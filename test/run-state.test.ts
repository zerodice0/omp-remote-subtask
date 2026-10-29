import { describe, expect, test } from "bun:test";
import { checkInheritedTools, createRunState, decide, reduceRunState, type RunEvent, type RunState } from "../src/run-state.ts";
import type { RpcFrame } from "../src/rpc-frames.ts";

function apply(...events: RunEvent[]): RunState {
  return events.reduce(reduceRunState, createRunState());
}

function frame(value: RpcFrame): RunEvent {
  return { kind: "frame", frame: value };
}

const sent: RunEvent = { kind: "prompt_sent" };
const closed: RunEvent = { kind: "transport_closed", exitCode: 255, signal: null };
const abort: RunEvent = { kind: "abort_requested", reason: "signal" };
const completed = frame({ type: "prompt_result", id: "prompt-1", status: "completed", sessionSettled: true });
const unsettled = frame({ type: "prompt_result", id: "prompt-1", status: "completed", sessionSettled: false });
const exited = frame({ type: "remote_subtask_supervisor", event: "exited", code: 0, signal: null, termSent: false, killSent: false, groupGone: true });

describe("run state outcomes", () => {
  test("starts pending and records ready, supervisor start, and confirmed protocol negotiation", () => {
    const initial = createRunState();
    expect(decide(initial).done).toBe(false);
    const start = { type: "remote_subtask_supervisor", event: "started", pid: 12, pgid: 12 };
    const state = apply(frame(start), frame({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }));
    expect(state.supervisor.started).toEqual(start);
    expect(state.protocolVersion).toBe(1);
    expect(reduceRunState(state, frame({ type: "response", id: "protocol-1", success: false })).protocolVersion).toBe(1);
    expect(reduceRunState(state, frame({ type: "response", id: "protocol-1", success: true, data: { protocolVersion: 2 } })).protocolVersion).toBe(2);
    expect(initial.ready).toBeNull();
  });

  test("completes only on settled prompt_result, without waiting for supervisor exit", () => {
    const state = apply(sent, frame({ type: "response", id: "prompt-1", command: "prompt", success: true }), completed);
    expect(state.promptAccepted).toBe(true);
    expect(state.supervisor.exited).toBeNull();
    expect(decide(state)).toEqual({ done: true, status: "completed", cancellationConfirmed: false, reason: "completed_and_settled" });
    expect(decide(reduceRunState(state, closed)).status).toBe("completed");
  });

  test("waits for session_settled after a yield even after agent_end", () => {
    let state = apply(sent, unsettled, frame({ type: "agent_end", isTerminal: true, yielded: true, messages: [] }));
    expect(decide(state)).toEqual({ done: false, cancellationConfirmed: false, reason: "awaiting_session_settled" });
    state = reduceRunState(state, frame({ type: "session_settled" }));
    expect(decide(state).status).toBe("completed");
  });

  test("does not reuse session_settled from before the prompt", () => {
    expect(apply(frame({ type: "session_settled" })).sessionSettled).toBe(false);
    const state = apply(frame({ type: "session_settled" }), sent, unsettled);
    expect(decide(state).done).toBe(false);
  });

  test("handles RPC local-only prompt completion without expecting agent_end", () => {
    const state = apply(sent, frame({ type: "response", id: "prompt-1", command: "prompt", success: true, data: { agentInvoked: false } }));
    expect(state.promptAccepted).toBe(true);
    expect(decide(state).status).toBe("completed");
  });

  test("fails on provider prompt_result error even if acknowledged successfully", () => {
    const state = apply(sent, frame({ type: "response", id: "prompt-1", success: true }), frame({
      type: "prompt_result", id: "prompt-1", status: "error", sessionSettled: true,
      error: { message: "Quota exceeded", retryable: false, provider: "p", model: "m" },
    }));
    expect(decide(state).status).toBe("failed");
    expect(state.promptResult?.error).toEqual({ message: "Quota exceeded", retryable: false, provider: "p", model: "m" });
  });

  test("fails on prompt response rejection but ignores another command's response", () => {
    expect(decide(apply(sent, frame({ type: "response", id: "prompt-1", success: false, error: "Rejected" }))).status).toBe("failed");
    expect(decide(apply(sent, frame({ type: "response", id: "abort-1", success: false, error: "Rejected" }))).done).toBe(false);
    expect(decide(apply(sent, frame({ type: "prompt_result", id: "other", status: "completed", sessionSettled: true }))).done).toBe(false);
  });

  test("aborts only after supervisor exit confirms the entire process group gone", () => {
    let state = apply(sent, abort, frame({ type: "prompt_result", id: "prompt-1", status: "aborted", sessionSettled: true }));
    expect(decide(state).done).toBe(false);
    state = reduceRunState(state, { kind: "terminate_requested" });
    expect(state.terminateRequested).toBe(true);
    expect(decide(state).done).toBe(false);
    state = reduceRunState(state, exited);
    expect(decide(state)).toEqual({ done: true, status: "aborted", cancellationConfirmed: true, reason: "cancellation_confirmed" });
  });

  test("confirmed supervisor termination is enough even when abort result never arrived", () => {
    expect(decide(apply(sent, { kind: "abort_requested", reason: "timeout" }, exited)).status).toBe("aborted");
    expect(decide(apply(sent, completed, abort, exited)).status).toBe("aborted");
  });

  test("abort without observed supervisor/groupGone remains unknown at transport close", () => {
    for (const events of [
      [sent, abort, closed],
      [sent, abort, frame({ type: "prompt_result", id: "prompt-1", status: "aborted", sessionSettled: true }), closed],
      [sent, abort, frame({ type: "remote_subtask_supervisor", event: "exited", groupGone: false })],
      [sent, abort, frame({ type: "remote_subtask_supervisor", event: "exited" })],
    ]) {
      expect(decide(apply(...events))).toEqual({ done: true, status: "unknown", cancellationConfirmed: false, reason: "cancellation_unconfirmed" });
    }
  });

  test("drop after prompt_sent is unknown even before admission response", () => {
    const decision = decide(apply(sent, closed));
    expect(decision.status).toBe("unknown");
    expect(decision.cancellationConfirmed).toBe(false);
    expect(decision.notStarted).toBeUndefined();
    expect(Object.keys(decision)).not.toContain("resend");
    expect(decide(apply(sent, unsettled, closed)).status).toBe("unknown");
  });

  test("drop or local error before prompt fails with notStarted true", () => {
    const localError: RunEvent = { kind: "local_error", code: "unexpected_remote_tools", message: "bash mounted" };
    expect(decide(apply(closed))).toMatchObject({ done: true, status: "failed", notStarted: true, cancellationConfirmed: false });
    expect(decide(apply(localError))).toMatchObject({ status: "failed", notStarted: true, reason: "unexpected_remote_tools" });
    expect(decide(apply(sent, localError))).toMatchObject({ status: "unknown", cancellationConfirmed: false });
  });

  test("a supervisor group exit before completion fails rather than asserting completion", () => {
    expect(decide(apply(sent, exited)).status).toBe("failed");
    expect(decide(apply(sent, unsettled, exited)).status).toBe("failed");
    expect(decide(apply(sent, completed, exited)).status).toBe("completed");
  });
});

describe("assistant message accounting", () => {
  test("concatenates only text parts, retains last assistant provider/model, and sums usage", () => {
    const first = frame({ type: "message_end", message: {
      role: "assistant", provider: "provider-1", model: "model-1",
      content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "First " }, { type: "toolCall", name: "read" }, { type: "text", text: "reply" }],
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.125 } },
    } });
    const second = frame({ type: "message_end", message: {
      role: "assistant", provider: "provider-2", model: "model-2", content: [{ type: "text", text: "Final" }],
      usage: { input: 20, output: 10, cacheRead: 6, cacheWrite: 4, totalTokens: 40, cost: { total: 0.25 } },
    } });
    const initial = createRunState();
    const state = reduceRunState(initial, first);
    expect(state.lastAssistantText).toBe("First reply");
    const final = reduceRunState(state, second);
    expect(final.lastAssistantText).toBe("Final");
    expect(final.actualModel).toBe("provider-2/model-2");
    expect(final.usage).toEqual({ input: 30, output: 15, cacheRead: 9, cacheWrite: 6, totalTokens: 60, cost: { total: 0.375 } });
    expect(initial.usage.input).toBe(0);
    expect(state.usage.input).toBe(10);
    const repeated = reduceRunState(final, frame({ type: "agent_end", messages: [first, second] }));
    expect(repeated.usage).toEqual(final.usage);
  });

  test("ignores tool/user messages, tolerates missing usage and does not infer status from stopReason", () => {
    const state = apply(sent, frame({ type: "message_end", message: { role: "user", content: "ignore", usage: { input: 100 } } }),
      frame({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Error" }], stopReason: "error" } }));
    expect(state.lastAssistantText).toBe("Error");
    expect(state.actualModel).toBeNull();
    expect(state.usage.input).toBe(0);
    expect(decide(state).done).toBe(false);
  });
});

test("inheritance permits exactly read, grep, glob, write and catches inherited MCP/autolearn", () => {
  expect(checkInheritedTools(["read", "grep", "glob", "write"])).toEqual({ ok: true, unexpected: [] });
  expect(checkInheritedTools([])).toEqual({ ok: true, unexpected: [] });
  expect(checkInheritedTools(["read", "manage_skill", "mcp__rea", "learn", "bash", "constructor"]))
    .toEqual({ ok: false, unexpected: ["manage_skill", "mcp__rea", "learn", "bash", "constructor"] });
});
