import { describe, expect, test } from "bun:test";
import { FrameError, LineSplitter, RpcFrameDecoder, negotiate, type RpcFrame } from "../src/rpc-frames.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunks(bytes: Uint8Array, count = 3): RpcFrame[] {
  const frames: RpcFrame[] = [];
  const width = Math.ceil(bytes.length / count);
  for (let index = 0; index < count; index++) {
    frames.push({
      type: "rpc_chunk", chunkId: "rpc-1", index, count, byteLength: bytes.length,
      data: Buffer.from(bytes.subarray(index * width, (index + 1) * width)).toString("base64"),
    });
  }
  return frames;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FrameError);
    expect((error as FrameError).code).toBe(code);
    return;
  }
  throw new Error(`Expected FrameError(${code})`);
}

describe("LineSplitter", () => {
  test("splits arbitrary byte boundaries, including multibyte UTF-8", () => {
    const splitter = new LineSplitter();
    const bytes = encoder.encode('{"text":"키돌이"}\n{"a":2}\n');
    const lines: Uint8Array[] = [];
    for (const byte of bytes) lines.push(...splitter.push(Uint8Array.of(byte)));
    expect(lines.map(line => decoder.decode(line))).toEqual(['{"text":"키돌이"}', '{"a":2}']);
    splitter.end();
  });

  test("accepts LF and CRLF, removes one CR only, and emits empty lines", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(encoder.encode("one\r"))).toEqual([]);
    expect(splitter.push(encoder.encode("\ntwo\n\nthree\r\r\n")).map(line => decoder.decode(line)))
      .toEqual(["one", "two", "", "three\r"]);
    splitter.end();
  });

  test("enforces exact line limit before or after a boundary", () => {
    expect(new LineSplitter(3).push(encoder.encode("abc\n")).map(line => decoder.decode(line))).toEqual(["abc"]);
    expectCode(() => new LineSplitter(3).push(encoder.encode("abcd\n")), "frame_too_large");
    const splitter = new LineSplitter(3);
    splitter.push(encoder.encode("ab"));
    expectCode(() => splitter.push(encoder.encode("cd")), "frame_too_large");
  });

  test("rejects final partial lines but permits empty EOF", () => {
    new LineSplitter().end();
    const splitter = new LineSplitter();
    splitter.push(encoder.encode("{}"));
    expectCode(() => splitter.end(), "incomplete_line");
  });
});

describe("RpcFrameDecoder", () => {
  test("decodes objects and passes supervisor frames unchanged", () => {
    const decoder = new RpcFrameDecoder();
    const frame = { type: "remote_subtask_supervisor", event: "started", pid: 123 };
    expect(decoder.push(encoder.encode(JSON.stringify(frame)))).toEqual(frame);
    decoder.end();
  });

  test.each(["{", "undefined", "{} {}"])("rejects malformed JSON %s", line => {
    expectCode(() => new RpcFrameDecoder().push(line), "invalid_json");
  });

  test.each(["null", "[]", '"text"', "42", "true"])("rejects non-object JSON %s", line => {
    expectCode(() => new RpcFrameDecoder().push(line), "invalid_frame");
  });

  test("strictly rejects invalid UTF-8 in a physical frame", () => {
    expectCode(() => new RpcFrameDecoder().push(Uint8Array.of(123, 34, 120, 34, 58, 34, 0xff, 34, 125)), "invalid_utf8");
  });

  test("enforces physical frame bytes including the newline and applies ready limits", () => {
    const decoder = new RpcFrameDecoder();
    decoder.setLimits({ maxFrameBytes: 3, maxReassembledFrameBytes: 100 });
    expect(decoder.push("{}")).toEqual({});
    expectCode(() => decoder.push("{} "), "frame_too_large");
    expectCode(() => decoder.setLimits({ maxFrameBytes: NaN }), "invalid_frame_limit");
  });

  test("reassembles multibyte JSON from raw byte slices", () => {
    const logical = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "키돌이 🐤" }] } };
    const decoder = new RpcFrameDecoder();
    const frames = chunks(encoder.encode(JSON.stringify(logical)), 7);
    for (const frame of frames.slice(0, -1)) expect(decoder.push(JSON.stringify(frame))).toBeNull();
    expect(decoder.push(JSON.stringify(frames.at(-1)))).toEqual(logical);
    decoder.end();
  });

  test("rejects nonsequential indices, duplicate indices, and missing first chunk", () => {
    const frames = chunks(encoder.encode('{"type":"test","value":"abc"}'));
    expectCode(() => new RpcFrameDecoder().push(JSON.stringify(frames[1])), "invalid_chunk_index");
    const decoder = new RpcFrameDecoder();
    decoder.push(JSON.stringify(frames[0]));
    expectCode(() => decoder.push(JSON.stringify(frames[0])), "invalid_chunk_index");
    const second = new RpcFrameDecoder();
    second.push(JSON.stringify(frames[0]));
    expectCode(() => second.push(JSON.stringify(frames[2])), "invalid_chunk_index");
  });

  test.each([
    { chunkId: "" }, { chunkId: 1 }, { index: -1 }, { index: 0.5 }, { count: 0 },
    { count: 1.5 }, { byteLength: 0 }, { byteLength: -1 }, { byteLength: 1.5 },
  ])("validates chunk metadata %j", invalid => {
    const frame = chunks(encoder.encode('{"a":123}'))[0];
    expectCode(() => new RpcFrameDecoder().push(JSON.stringify({ ...frame, ...invalid })), "invalid_chunk");
  });

  test.each([{ count: 4 }, { byteLength: 100 }])("rejects changed sequence metadata %j", invalid => {
    const frames = chunks(encoder.encode('{"a":123}'));
    const decoder = new RpcFrameDecoder();
    decoder.push(JSON.stringify(frames[0]));
    expectCode(() => decoder.push(JSON.stringify({ ...frames[1], ...invalid })), "inconsistent_chunk_metadata");
  });

  test("rejects byteLength underflow and overflow", () => {
    const bytes = encoder.encode('{"a":123}');
    expectCode(() => new RpcFrameDecoder().push(JSON.stringify({ ...chunks(bytes, 1)[0], byteLength: bytes.length - 1 })), "invalid_chunk_byte_length");
    expectCode(() => new RpcFrameDecoder().push(JSON.stringify({ ...chunks(bytes, 1)[0], byteLength: bytes.length + 1 })), "invalid_chunk_byte_length");
  });

  test("rejects interleaved IDs and interrupted sequences", () => {
    const frames = chunks(encoder.encode('{"a":123}'));
    const decoder = new RpcFrameDecoder();
    decoder.push(JSON.stringify(frames[0]));
    expectCode(() => decoder.push(JSON.stringify({ ...frames[1], chunkId: "rpc-2" })), "interleaved_chunk_sequence");
    const second = new RpcFrameDecoder();
    second.push(JSON.stringify(frames[0]));
    expectCode(() => second.push('{"type":"ready"}'), "interrupted_chunk_sequence");
    expectCode(() => second.end(), "incomplete_chunk_sequence");
  });

  test.each(["!@#$", "YQ", "YQ=", "YR==", "YQ==\n", "", 4])("rejects invalid base64 %j", data => {
    const frame = chunks(encoder.encode('{"a":123}'))[0];
    expectCode(() => new RpcFrameDecoder().push(JSON.stringify({ ...frame, data })), "invalid_chunk_data");
  });

  test("rejects over-limit reassembly before allocating and rejects reduced limits", () => {
    const frames = chunks(encoder.encode('{"a":123}'));
    const decoder = new RpcFrameDecoder({ maxReassembledFrameBytes: 3 });
    expectCode(() => decoder.push(JSON.stringify(frames[0])), "frame_too_large");
    const second = new RpcFrameDecoder();
    second.push(JSON.stringify(frames[0]));
    expectCode(() => second.setLimits({ maxReassembledFrameBytes: 3 }), "frame_too_large");
  });

  test("strictly rejects invalid reassembled UTF-8, JSON, and nonobjects", () => {
    for (const [bytes, code] of [
      [Uint8Array.of(0xc3, 0x28), "invalid_utf8"],
      [encoder.encode("not json"), "invalid_json"],
      [encoder.encode("[]"), "invalid_frame"],
    ] as const) {
      expectCode(() => new RpcFrameDecoder().push(JSON.stringify(chunks(bytes, 1)[0])), code);
    }
  });

  test("rejects nested chunks and can decode successive complete logical frames", () => {
    const nested = encoder.encode('{"type":"rpc_chunk"}');
    expectCode(() => new RpcFrameDecoder().push(JSON.stringify(chunks(nested, 1)[0])), "invalid_chunk");
    const decoder = new RpcFrameDecoder();
    for (let i = 0; i < 2; i++) {
      for (const frame of chunks(encoder.encode('{"ok":true}'), 1)) {
        expect(decoder.push(JSON.stringify(frame))).toEqual({ ok: true });
      }
    }
  });
});

describe("negotiate", () => {
  test("offers v2 only when explicitly supported", () => {
    expect(negotiate({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] })).toEqual({
      version: 2, send: { id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 },
    });
    expect(negotiate({ type: "ready", protocolVersion: 1 })).toEqual({ version: 1 });
    expect(negotiate({ type: "ready", supportedProtocolVersions: [1, "2"] })).toEqual({ version: 1 });
    expect(negotiate({ type: "ready", supportedProtocolVersions: [1, 3] })).toEqual({ version: 1 });
  });
});
