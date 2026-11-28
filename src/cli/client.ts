/** Typed HTTP client for the bridge API (src/core/api.ts). Plain fetch, no dependencies. */
import type {
  BridgeSession,
  CreateSessionRequest,
  HealthResponse,
  QuestionRespondRequest,
  SendMessageRequest,
  SettingsResponse,
  TestConnectionResponse,
} from "../core/api.js";
import type { AiEvent, PermissionDecision } from "../core/events.js";
import type { ModelInfo, Secrets, Settings } from "../core/types.js";
import { redact } from "../core/redact.js";
import { HttpStatusError, streamTurn, type TurnStreamOptions } from "./sse.js";

export const DEFAULT_URL = "http://127.0.0.1:8790";

/** The bridge could not be reached at all (connection refused, DNS, timeout). */
export class BridgeUnreachableError extends Error {
  constructor(readonly url: string, cause?: string) {
    super(
      `bridge not running at ${url}${cause ? ` (${cause})` : ""}. Start it with \`secrets-ai serve\` (or pass --url / set SECRETS_AI_URL).`,
    );
  }
}

/** The bridge answered with an error status. */
export class ApiError extends HttpStatusError {}

export interface ClientOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  /** Per-request timeout for non-streaming calls (ms). */
  timeoutMs?: number;
}

export class BridgeClient {
  readonly url: string;
  private readonly token?: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Low-level request; throws BridgeUnreachableError / ApiError with friendly messages. */
  async raw(method: string, path: string, body?: unknown, init: { headers?: Record<string, string>; stream?: boolean; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = this.headers(init.headers);
    if (body !== undefined) headers["content-type"] = "application/json";
    if (init.stream) headers.accept = "text/event-stream";
    let signal = init.signal;
    if (!init.stream && !signal) signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (err) {
      throw new BridgeUnreachableError(this.url, describeFetchError(err));
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new ApiError(`bridge returned invalid JSON for ${method} ${path}`, res.status, "bad_json");
    }
  }

  health(): Promise<HealthResponse> {
    return this.json("GET", "/health");
  }
  async createSession(req: CreateSessionRequest = {}): Promise<BridgeSession> {
    return (await this.json<{ session: BridgeSession }>("POST", "/v1/sessions", req)).session;
  }
  async listSessions(): Promise<BridgeSession[]> {
    return (await this.json<{ sessions: BridgeSession[] }>("GET", "/v1/sessions")).sessions ?? [];
  }
  async getSession(id: string): Promise<BridgeSession> {
    return (await this.json<{ session: BridgeSession }>("GET", `/v1/sessions/${enc(id)}`)).session;
  }
  async abort(id: string): Promise<boolean> {
    return (await this.json<{ ok: boolean }>("POST", `/v1/sessions/${enc(id)}/abort`, {})).ok;
  }
  async respondPermission(id: string, decision: PermissionDecision): Promise<void> {
    await this.json("POST", `/v1/permissions/${enc(id)}/respond`, { decision });
  }
  async respondQuestion(id: string, body: QuestionRespondRequest): Promise<void> {
    await this.json("POST", `/v1/questions/${enc(id)}/respond`, body);
  }
  async models(q: { provider?: string; freeTools?: boolean } = {}): Promise<ModelInfo[]> {
    const p = new URLSearchParams();
    if (q.provider) p.set("provider", q.provider);
    if (q.freeTools) p.set("free_tools", "1");
    const qs = p.toString();
    return (await this.json<{ models: ModelInfo[] }>("GET", `/v1/models${qs ? `?${qs}` : ""}`)).models ?? [];
  }
  getSettings(): Promise<SettingsResponse> {
    return this.json("GET", "/v1/settings");
  }
  putSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
    return this.json("PUT", "/v1/settings", patch);
  }
  putSecrets(patch: Partial<Secrets>): Promise<SettingsResponse> {
    return this.json("PUT", "/v1/secrets", patch);
  }
  testConnection(provider?: string): Promise<TestConnectionResponse> {
    return this.json("POST", "/v1/settings/test-connection", provider ? { provider } : {});
  }

  /** Send a message and stream the turn's events until session.idle, reconnecting on drops. */
  sendMessage(
    sessionId: string,
    req: SendMessageRequest,
    opts: Pick<TurnStreamOptions, "maxReconnects" | "backoff" | "onReconnect"> & { signal?: AbortSignal } = {},
  ): AsyncGenerator<AiEvent> {
    return streamTurn({
      ...opts,
      open: () => this.raw("POST", `/v1/sessions/${enc(sessionId)}/messages`, req, { stream: true, signal: opts.signal }),
      reconnect: (lastId) =>
        this.raw("GET", `/v1/sessions/${enc(sessionId)}/events`, undefined, {
          stream: true,
          signal: opts.signal,
          headers: lastId !== undefined ? { "last-event-id": lastId } : {},
        }).catch((err: unknown) => {
          // While the bridge is restarting, keep retrying; real HTTP errors are final.
          if (err instanceof BridgeUnreachableError) return new Response(null);
          throw err;
        }),
    });
  }
}

const enc = encodeURIComponent;

function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  const code = e?.cause?.code;
  if (code) return code;
  return redact(String(e?.cause?.message ?? e?.message ?? err));
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) message = `unauthorized: the bridge rejected the token. Check SECRETS_AI_TOKEN / --token, or run \`secrets-ai auth token\` on the bridge host.`;
  return new ApiError(redact(message), res.status, code);
}
