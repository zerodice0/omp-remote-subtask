import type { RpcFrame } from "./rpc-frames.ts";

export type RunStatus = "completed" | "failed" | "aborted" | "unknown";
export type RunEvent =
  | { kind: "frame"; frame: RpcFrame }
  | { kind: "prompt_sent" }
  | { kind: "abort_requested"; reason: "signal" | "timeout" }
  | { kind: "terminate_requested" }
  | { kind: "transport_closed"; exitCode: number | null; signal: string | null }
  | { kind: "local_error"; code: string; message: string };

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

export interface RunState {
  ready: RpcFrame | null;
  protocolVersion: 1 | 2;
  promptSent: boolean;
  promptAccepted: boolean;
  promptResponseError: string | null;
  promptResult: RpcFrame | null;
  sessionSettled: boolean;
  lastAssistantText: string;
  actualModel: string | null;
  usage: RunUsage;
  abortRequested: "signal" | "timeout" | null;
  terminateRequested: boolean;
  transportClosed: { exitCode: number | null; signal: string | null } | null;
  localError: { code: string; message: string } | null;
  supervisor: { started: RpcFrame | null; exited: RpcFrame | null };
}

export interface RunDecision {
  done: boolean;
  status?: RunStatus;
  cancellationConfirmed: boolean;
  reason: string;
  notStarted?: true;
}

export function createRunState(): RunState {
  return {
    ready: null, protocolVersion: 1, promptSent: false, promptAccepted: false,
    promptResponseError: null, promptResult: null, sessionSettled: false,
    lastAssistantText: "", actualModel: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    abortRequested: null, terminateRequested: false, transportClosed: null, localError: null,
    supervisor: { started: null, exited: null },
  };
}

function finiteUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Immutable reducer. Timeouts are explicit caller events, never wall-clock reads. */
export function reduceRunState(state: RunState, event: RunEvent): RunState {
  switch (event.kind) {
    case "prompt_sent":
      return { ...state, promptSent: true, sessionSettled: false };
    case "abort_requested":
      return { ...state, abortRequested: state.abortRequested ?? event.reason };
    case "terminate_requested":
      return { ...state, terminateRequested: true };
    case "transport_closed":
      return { ...state, transportClosed: { exitCode: event.exitCode, signal: event.signal } };
    case "local_error":
      return { ...state, localError: { code: event.code, message: event.message } };
    case "frame":
      return reduceFrame(state, event.frame);
  }
}

function reduceFrame(state: RunState, frame: RpcFrame): RunState {
  switch (frame.type) {
    case "ready":
      return { ...state, ready: frame, protocolVersion: frame.protocolVersion === 2 ? 2 : 1 };
    case "response":
      if (frame.id === "protocol-1" && frame.success === true
        && frame.data !== null && typeof frame.data === "object"
        && "protocolVersion" in frame.data && frame.data.protocolVersion === 2) {
        return { ...state, protocolVersion: 2 };
      }
      if (frame.id !== "prompt-1") return state;
      if (frame.success === false) {
        return { ...state, promptResponseError: typeof frame.error === "string" ? frame.error : "Prompt rejected" };
      }
      if (frame.success !== true) return state;
      if (frame.data !== null && typeof frame.data === "object"
        && "agentInvoked" in frame.data && frame.data.agentInvoked === false) {
        return {
          ...state, promptAccepted: true, sessionSettled: true,
          promptResult: { type: "prompt_result", id: "prompt-1", agentInvoked: false, status: "completed", sessionSettled: true },
        };
      }
      return { ...state, promptAccepted: true };
    case "prompt_result":
      if (frame.id !== "prompt-1") return state;
      return { ...state, promptResult: frame, sessionSettled: frame.sessionSettled === true || state.sessionSettled };
    case "session_settled":
      return state.promptSent ? { ...state, sessionSettled: true } : state;
    case "message_end": {
      const message = frame.message;
      if (message === null || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return state;
      const content = "content" in message ? message.content : null;
      const provider = "provider" in message ? message.provider : null;
      const model = "model" in message ? message.model : null;
      let text = "";
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part !== null && typeof part === "object" && "type" in part && part.type === "text"
            && "text" in part && typeof part.text === "string") text += part.text;
        }
      }
      const rawUsage = "usage" in message ? message.usage : null;
      const usage = rawUsage !== null && typeof rawUsage === "object" ? rawUsage : {};
      const rawCost = "cost" in usage ? usage.cost : null;
      const cost = rawCost !== null && typeof rawCost === "object" ? rawCost : {};
      return {
        ...state,
        lastAssistantText: text,
        actualModel: typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : null,
        usage: {
          input: state.usage.input + finiteUsage("input" in usage ? usage.input : null),
          output: state.usage.output + finiteUsage("output" in usage ? usage.output : null),
          cacheRead: state.usage.cacheRead + finiteUsage("cacheRead" in usage ? usage.cacheRead : null),
          cacheWrite: state.usage.cacheWrite + finiteUsage("cacheWrite" in usage ? usage.cacheWrite : null),
          totalTokens: state.usage.totalTokens + finiteUsage("totalTokens" in usage ? usage.totalTokens : null),
          cost: { total: state.usage.cost.total + finiteUsage("total" in cost ? cost.total : null) },
        },
      };
    }
    case "remote_subtask_supervisor":
      if (frame.event === "started") return { ...state, supervisor: { ...state.supervisor, started: frame } };
      if (frame.event === "exited") return { ...state, supervisor: { ...state.supervisor, exited: frame } };
      return state;
    default:
      // In particular, agent_end is a yield, not proof of session quiescence.
      return state;
  }
}

/** Terminal outcomes never request a resend, even when admission was unobserved. */
export function decide(state: RunState): RunDecision {
  if (state.promptResponseError !== null || state.promptResult?.status === "error") {
    return { done: true, status: "failed", cancellationConfirmed: false, reason: "prompt_error" };
  }
  if (!state.promptSent && (state.localError || state.transportClosed || state.supervisor.exited)) {
    return {
      done: true, status: "failed", cancellationConfirmed: false, notStarted: true,
      reason: state.localError?.code ?? "transport_closed_before_prompt",
    };
  }
  if (state.abortRequested) {
    if (state.supervisor.exited?.groupGone === true) {
      return { done: true, status: "aborted", cancellationConfirmed: true, reason: "cancellation_confirmed" };
    }
    if (state.supervisor.exited || state.transportClosed || state.localError) {
      return { done: true, status: "unknown", cancellationConfirmed: false, reason: "cancellation_unconfirmed" };
    }
    return { done: false, cancellationConfirmed: false, reason: "awaiting_cancellation_confirmation" };
  }
  if (state.promptResult?.status === "completed" && state.sessionSettled) {
    return { done: true, status: "completed", cancellationConfirmed: false, reason: "completed_and_settled" };
  }
  if (state.supervisor.exited?.groupGone === true) {
    return { done: true, status: "failed", cancellationConfirmed: false, reason: "supervisor_exited_without_settled_completion" };
  }
  if (state.transportClosed || state.localError || state.supervisor.exited) {
    return { done: true, status: "unknown", cancellationConfirmed: false, reason: "outcome_unconfirmed" };
  }
  return { done: false, cancellationConfirmed: false, reason: state.promptResult?.status === "completed"
    ? "awaiting_session_settled" : "awaiting_prompt_result" };
}

const INHERITED_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, write: true };

export function checkInheritedTools(names: readonly string[]): { ok: boolean; unexpected: string[] } {
  const unexpected = names.filter(name => !Object.hasOwn(INHERITED_TOOLS, name));
  return { ok: unexpected.length === 0, unexpected };
}
