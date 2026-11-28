/**
 * Minimal, spec-compliant Server-Sent Events parser (WHATWG "event stream interpretation").
 * Handles chunk boundaries anywhere (including between CR and LF), CRLF/CR/LF line endings,
 * multi-line `data:`, comments (`: ping`) and `id:` tracking for Last-Event-ID resume.
 */
import type { AiEvent } from "../core/events.js";

export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

export class SseParser {
  private buf = "";
  private pendingCR = false;
  private data: string[] = [];
  private event = "";
  private frameId: string | undefined;
  /** Last `id:` seen (persists across frames, like EventSource.lastEventId). */
  lastEventId: string | undefined;

  /** Feed a decoded text chunk; returns the frames completed by it. */
  push(chunk: string): SseFrame[] {
    const out: SseFrame[] = [];
    let text = chunk;
    if (this.pendingCR) {
      this.pendingCR = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    this.buf += text;
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c !== "\n" && c !== "\r") continue;
      const line = this.buf.slice(start, i);
      if (c === "\r") {
        if (i + 1 < this.buf.length) {
          if (this.buf[i + 1] === "\n") i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const f = this.line(line);
      if (f) out.push(f);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Flush at end of stream. Per spec an unterminated frame is discarded. */
  end(): SseFrame[] {
    this.buf = "";
    this.data = [];
    this.event = "";
    this.frameId = undefined;
    return [];
  }

  private line(line: string): SseFrame | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        this.frameId = undefined;
        return null;
      }
      const f: SseFrame = { event: this.event || "message", data: this.data.join("\n") };
      if (this.frameId !== undefined) f.id = this.frameId;
      this.data = [];
      this.event = "";
      this.frameId = undefined;
      return f;
    }
    if (line.startsWith(":")) return null; // comment / ping
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.frameId = value;
          this.lastEventId = value;
        }
        break;
      default:
        break; // retry and unknown fields ignored
    }
    return null;
  }
}

/** Parse a frame's data as an AiEvent; returns null for non-JSON or untyped frames. */
export function frameToEvent(f: SseFrame): AiEvent | null {
  try {
    const v = JSON.parse(f.data) as { type?: unknown };
    if (!v || typeof v !== "object" || typeof v.type !== "string") return null;
    return v as AiEvent;
  } catch {
    return null;
  }
}

/** Iterate SSE frames from a fetch Response body. */
export async function* readSse(body: ReadableStream<Uint8Array>, parser = new SseParser()): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const f of parser.push(dec.decode(value, { stream: true }))) yield f;
    }
    const tail = dec.decode();
    if (tail) for (const f of parser.push(tail)) yield f;
    parser.end();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
}

export interface TurnStreamOptions {
  /** Opens the initial stream (e.g. POST /messages). */
  open: () => Promise<Response>;
  /** Re-subscribes after a drop (GET /events with Last-Event-ID). */
  reconnect: (lastEventId: string | undefined) => Promise<Response>;
  maxReconnects?: number;
  /** Backoff delay in ms for attempt n (0-based). */
  backoff?: (attempt: number) => number;
  onReconnect?: (attempt: number, lastEventId: string | undefined) => void;
  /** Stop once this returns true for an event (default: session.idle). */
  isTerminal?: (ev: AiEvent) => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream one turn of AiEvents, transparently reconnecting with Last-Event-ID if the
 * connection drops before the terminal event. Duplicate ids after a resume are skipped.
 */
export async function* streamTurn(opts: TurnStreamOptions): AsyncGenerator<AiEvent> {
  const max = opts.maxReconnects ?? 5;
  const backoff = opts.backoff ?? ((n: number) => Math.min(250 * 2 ** n, 4000));
  const isTerminal = opts.isTerminal ?? ((ev: AiEvent) => ev.type === "session.idle");
  let lastId: string | undefined;
  let attempts = 0;
  let res = await opts.open();
  for (;;) {
    let progressed = false;
    try {
      if (!res.body) throw new Error("empty event stream");
      for await (const f of readSse(res.body)) {
        if (f.id !== undefined) {
          if (lastId !== undefined && isNumeric(f.id) && isNumeric(lastId) && Number(f.id) <= Number(lastId)) continue;
          lastId = f.id;
        }
        const ev = frameToEvent(f);
        if (!ev) continue;
        progressed = true;
        yield ev;
        if (isTerminal(ev)) return;
      }
    } catch (err) {
      if (err instanceof HttpStatusError) throw err;
      // network drop: fall through to reconnect
    }
    if (progressed) attempts = 0;
    if (attempts >= max) throw new StreamDroppedError(`event stream dropped and ${max} reconnect attempts failed`);
    const delay = backoff(attempts);
    attempts++;
    opts.onReconnect?.(attempts, lastId);
    await sleep(delay);
    try {
      res = await opts.reconnect(lastId);
    } catch (err) {
      if (err instanceof HttpStatusError) throw err;
      res = new Response(null); // treat as another drop
    }
  }
}

function isNumeric(s: string): boolean {
  return /^\d+$/.test(s);
}

export class StreamDroppedError extends Error {}
/** Thrown by reconnect/open callbacks for non-retryable HTTP failures. */
export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
