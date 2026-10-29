export type RpcFrame = Record<string, unknown>;

export class FrameError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "FrameError";
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Splits on LF; accepts CRLF by removing exactly one CR before the LF.
 * maxLineBytes counts bytes before LF, including a possible CR. */
export class LineSplitter {
  private segments: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxLineBytes = 1024 * 1024 + 1) {
    if (!positiveInteger(maxLineBytes)) throw new FrameError("invalid_frame_limit");
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const segment = chunk.subarray(start, index);
      if (this.length + segment.length > this.maxLineBytes) throw new FrameError("frame_too_large");
      let line: Uint8Array;
      if (this.length === 0) {
        line = segment;
      } else {
        line = new Uint8Array(this.length + segment.length);
        let offset = 0;
        for (const part of this.segments) {
          line.set(part, offset);
          offset += part.length;
        }
        line.set(segment, offset);
      }
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      lines.push(line);
      this.segments = [];
      this.length = 0;
      start = index + 1;
    }
    if (start < chunk.length) {
      const remaining = chunk.subarray(start);
      if (this.length + remaining.length > this.maxLineBytes) throw new FrameError("frame_too_large");
      this.segments.push(remaining);
      this.length += remaining.length;
    }
    return lines;
  }

  end(): void {
    if (this.length !== 0) throw new FrameError("incomplete_line");
  }
}

export interface FrameLimits {
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

const DEFAULT_LIMITS: FrameLimits = {
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

function parseObject(bytes: Uint8Array): RpcFrame {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FrameError("invalid_utf8");
  }
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    throw new FrameError("invalid_json");
  }
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    throw new FrameError("invalid_frame", "RPC frames must be JSON objects");
  }
  return frame as RpcFrame;
}

interface PendingChunk {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  offset: number;
  bytes: Uint8Array;
}

export class RpcFrameDecoder {
  private limits: FrameLimits;
  private pending: PendingChunk | null = null;

  constructor(limits: Partial<FrameLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS };
    this.setLimits(limits);
  }

  setLimits(limits: Partial<FrameLimits>): void {
    const next = { ...this.limits, ...limits };
    if (!positiveInteger(next.maxFrameBytes) || !positiveInteger(next.maxReassembledFrameBytes)) {
      throw new FrameError("invalid_frame_limit");
    }
    if (this.pending && this.pending.byteLength > next.maxReassembledFrameBytes) {
      throw new FrameError("frame_too_large");
    }
    this.limits = next;
  }

  /** Input excludes the physical LF. Chunk sequences yield null until complete. */
  push(line: Uint8Array | string): RpcFrame | null {
    const bytes = typeof line === "string" ? new TextEncoder().encode(line) : line;
    if (bytes.length + 1 > this.limits.maxFrameBytes) throw new FrameError("frame_too_large");
    const frame = parseObject(bytes);
    if (frame.type !== "rpc_chunk") {
      if (this.pending) throw new FrameError("interrupted_chunk_sequence");
      return frame;
    }

    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || chunkId.length === 0
      || !positiveInteger(count) || !positiveInteger(byteLength)
      || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= count
      || count > byteLength) {
      throw new FrameError("invalid_chunk");
    }
    if (byteLength > this.limits.maxReassembledFrameBytes) throw new FrameError("frame_too_large");
    if (this.pending) {
      if (this.pending.chunkId !== chunkId) throw new FrameError("interleaved_chunk_sequence");
      if (this.pending.count !== count || this.pending.byteLength !== byteLength) {
        throw new FrameError("inconsistent_chunk_metadata");
      }
    } else if (index !== 0) {
      throw new FrameError("invalid_chunk_index");
    }
    if (this.pending && index !== this.pending.nextIndex) throw new FrameError("invalid_chunk_index");
    // Buffer's decoder is permissive: validate canonical, padded base64 first.
    if (typeof data !== "string" || data.length === 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new FrameError("invalid_chunk_data");
    }
    const decodedLength = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    const offset = this.pending?.offset ?? 0;
    if (offset + decodedLength > byteLength) throw new FrameError("invalid_chunk_byte_length");
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data) throw new FrameError("invalid_chunk_data");
    const pending = this.pending ?? {
      chunkId, count, byteLength, nextIndex: 0, offset: 0, bytes: new Uint8Array(byteLength),
    };
    this.pending = pending;
    pending.bytes.set(decoded, pending.offset);
    pending.offset += decoded.length;
    pending.nextIndex++;
    if (pending.nextIndex !== count) return null;
    if (pending.offset !== byteLength) throw new FrameError("invalid_chunk_byte_length");
    const result = parseObject(pending.bytes);
    if (result.type === "rpc_chunk") throw new FrameError("invalid_chunk", "Nested rpc_chunk frames are not allowed");
    this.pending = null;
    return result;
  }

  end(): void {
    if (this.pending) throw new FrameError("incomplete_chunk_sequence");
  }
}

export function negotiate(ready: RpcFrame): { send?: RpcFrame; version: 1 | 2 } {
  if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
    return { send: { id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 }, version: 2 };
  }
  return { version: 1 };
}
