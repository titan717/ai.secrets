/**
 * Minimal typed fetch client for the `opencode serve` HTTP API (routes in docs/OPENCODE-NOTES.md section 2).
 * Uses HTTP Basic auth (user "opencode", per-child random password from the supervisor).
 */
import { redact } from "../core/redact.js";

export interface RawEvent {
  id?: string;
  type: string;
  properties: Record<string, any>;
}

/** Synthetic marker yielded by events() after the SSE stream had to be re-established. */
export const RECONNECT_EVENT = "bridge.reconnected";

export interface OpenCodeSession {
  id: string;
  title?: string;
  directory?: string;
  cost?: number;
  tokens?: unknown;
  time?: { created?: number; updated?: number };
  [k: string]: unknown;
}

export interface PromptBody {
  parts: Array<{ type: "text"; text: string }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  system?: string;
  variant?: string;
  tools?: Record<string, boolean>;
}

export interface SessionStatusInfo {
  type: "idle" | "busy" | "retry";
  attempt?: number;
  message?: string;
  next?: number;
}

export class OpenCodeHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  password?: string;
  username?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout for non-streaming calls (ms). */
  timeoutMs?: number;
}

export interface EventsOptions {
  signal?: AbortSignal;
  /** Initial reconnect delay (ms), doubled up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Called on every (re)connect failure; for logging. */
  onError?: (err: unknown) => void;
}

export class OpenCodeClient {
  baseUrl: string;
  private auth?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: OpenCodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.password) this.auth = "Basic " + Buffer.from(`${opts.username ?? "opencode"}:${opts.password}`).toString("base64");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Point the client at a restarted child. */
  setTarget(baseUrl: string, password?: string, username = "opencode"): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : undefined;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...(extra ?? {}) };
    if (this.auth) h.authorization = this.auth;
    return h;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: this.headers(body !== undefined ? { "content-type": "application/json" } : undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new OpenCodeHttpError(0, `opencode ${method} ${path} failed: ${redact((e as Error).message)}`);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    if (!res.ok) throw new OpenCodeHttpError(res.status, `opencode ${method} ${path} -> ${res.status}: ${redact(text.slice(0, 300))}`);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  health(timeoutMs?: number) {
    return this.request<{ healthy: boolean; version?: string }>("GET", "/global/health", undefined, { timeoutMs });
  }
  createSession(body: { title?: string; agent?: string } = {}) {
    return this.request<OpenCodeSession>("POST", "/session", body);
  }
  listSessions() {
    return this.request<OpenCodeSession[]>("GET", "/session");
  }
  getSession(id: string) {
    return this.request<OpenCodeSession>("GET", `/session/${enc(id)}`);
  }
  deleteSession(id: string) {
    return this.request<boolean>("DELETE", `/session/${enc(id)}`);
  }
  promptAsync(id: string, body: PromptBody) {
    return this.request<void>("POST", `/session/${enc(id)}/prompt_async`, body);
  }
  abort(id: string) {
    return this.request<boolean>("POST", `/session/${enc(id)}/abort`);
  }
  messages(id: string) {
    return this.request<Array<{ info: any; parts: any[] }>>("GET", `/session/${enc(id)}/message`);
  }
  sessionStatus() {
    return this.request<Record<string, SessionStatusInfo>>("GET", "/session/status");
  }
  listPermissions() {
    return this.request<any[]>("GET", "/permission");
  }
  replyPermission(requestId: string, reply: "once" | "always" | "reject", message?: string) {
    return this.request<boolean>("POST", `/permission/${enc(requestId)}/reply`, message ? { reply, message } : { reply });
  }
  listQuestions() {
    return this.request<any[]>("GET", "/question");
  }
  replyQuestion(requestId: string, answers: string[][]) {
    return this.request<boolean>("POST", `/question/${enc(requestId)}/reply`, { answers });
  }
  rejectQuestion(requestId: string) {
    return this.request<boolean>("POST", `/question/${enc(requestId)}/reject`);
  }
  configProviders() {
    return this.request<{ providers: any[]; default: Record<string, string> }>("GET", "/config/providers");
  }
  setAuth(providerId: string, key: string) {
    return this.request<boolean>("PUT", `/auth/${enc(providerId)}`, { type: "api", key });
  }
  deleteAuth(providerId: string) {
    return this.request<boolean>("DELETE", `/auth/${enc(providerId)}`);
  }

  /**
   * Async iterator over GET /event. Reconnects with capped exponential backoff and yields a synthetic
   * `{ type: RECONNECT_EVENT }` after every successful reconnect so callers can resync state.
   * Ends when `signal` aborts.
   */
  async *events(opts: EventsOptions = {}): AsyncGenerator<RawEvent> {
    const base = opts.backoffMs ?? 250;
    const max = opts.maxBackoffMs ?? 5000;
    let delay = base;
    let connectedBefore = false;
    while (!opts.signal?.aborted) {
      let res: Response | undefined;
      try {
        res = await this.fetchImpl(this.baseUrl + "/event", { headers: this.headers({ accept: "text/event-stream" }), signal: opts.signal });
        if (!res.ok || !res.body) throw new OpenCodeHttpError(res.status, `opencode /event -> ${res.status}`);
        if (connectedBefore) yield { type: RECONNECT_EVENT, properties: {} };
        connectedBefore = true;
        delay = base;
        for await (const data of parseSse(res.body, opts.signal)) {
          let ev: RawEvent;
          try {
            ev = JSON.parse(data) as RawEvent;
          } catch {
            continue;
          }
          if (ev && typeof ev.type === "string") {
            ev.properties ??= {};
            yield ev;
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) return;
        opts.onError?.(e);
      }
      if (opts.signal?.aborted) return;
      await sleep(delay, opts.signal);
      delay = Math.min(max, delay * 2);
    }
  }
}

function enc(s: string) {
  return encodeURIComponent(s);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Parse an SSE byte stream into `data` payloads (multi-line data joined with \n). Comments are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
