/**
 * Fastify app implementing the bridge HTTP API (src/core/api.ts) plus the legacy Secrets
 * frontend routes (see legacy.ts).
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type {
  BridgeSession,
  CreateSessionRequest,
  HealthResponse,
  PermissionRespondRequest,
  QuestionRespondRequest,
  SendMessageRequest,
  SettingsResponse,
  TestConnectionResponse,
} from "../core/api.js";
import { ensureToken, loadSecrets, saveSecret, verifyBearer } from "../core/auth.js";
import { toOpenCodeReply, type AiEvent, type PermissionDecision } from "../core/events.js";
import { createLogger, silentLogger, type Logger } from "../core/log.js";
import { redact, registerSecret } from "../core/redact.js";
import { loadSettings, mergeSettings, saveSettings, SettingsError, validateSettingsPatch } from "../core/settings.js";
import type { ModelInfo, ProviderId, Secrets, Settings } from "../core/types.js";
import { listModels, modelRef, PROVIDER_PRESETS, resolveEffort, testConnection } from "../presets/index.js";
import type { ListModelsOptions } from "../core/presets-contract.js";
import type { RawEvent } from "../opencode/client.js";
import type { SupervisorOptions } from "../supervisor/index.js";
import { EventHub, type StoredEvent } from "./hub.js";
import { WorkspaceRuntime } from "./runtime.js";
import { SseStream } from "./sse.js";
import { SessionStore } from "./store.js";
import { registerLegacyRoutes, LEGACY_ROUTES } from "./legacy.js";

export const BRIDGE_VERSION = "0.2.0";

export interface BridgeAppOptions {
  env: NodeJS.ProcessEnv;
  workspace: string;
  opencodeBin?: string;
  quiet?: boolean;
  logger?: Logger;
  /** Test hooks forwarded to every supervisor. */
  supervisor?: Partial<Omit<SupervisorOptions, "workspace" | "getSettings" | "getSecrets">>;
  pingMs?: number;
  /** Test hook: provider API base URLs / fetch used by listModels and testConnection. */
  /** Test hook: force every prompt onto this OpenCode model (e.g. a custom mock provider). */
  modelOverride?: { providerID: string; modelID: string };
  models?: { baseUrls?: ListModelsOptions["baseUrls"]; fetchImpl?: typeof fetch };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Turn {
  sessionId: string;
  rt: WorkspaceRuntime;
  maxSteps: number;
  authProvider?: string;
  autoApprove?: boolean;
  /** Legacy runs reject OpenCode questions automatically (the old frontend has no question UI). */
  rejectQuestions?: boolean;
  stopped?: boolean;
}

/** Per-request secret headers. Values are registered for redaction and never logged or stored. */
export function requestSecrets(req: FastifyRequest): { providerKey?: string; githubToken?: string; secretsToken?: string } {
  const h = (n: string) => {
    const v = req.headers[n];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) {
      registerSecret(s.trim());
      return s.trim();
    }
    return undefined;
  };
  return { providerKey: h("x-provider-key"), githubToken: h("x-github-token"), secretsToken: h("x-secrets-token") };
}

export function normalizeProvider(p: unknown): ProviderId | undefined {
  if (typeof p !== "string" || !p) return undefined;
  return p === "gemini" ? "google" : p;
}

export class Bridge {
  readonly env: NodeJS.ProcessEnv;
  readonly token: string;
  readonly store: SessionStore;
  readonly hub = new EventHub();
  readonly runtimes = new Map<string, WorkspaceRuntime>();
  readonly turns = new Map<string, Turn>();
  readonly permissions = new Map<string, { sessionId: string; rt: WorkspaceRuntime; callId?: string }>();
  readonly questions = new Map<string, { sessionId: string; rt: WorkspaceRuntime }>();
  readonly log: Logger;
  readonly defaultWorkspace: string;
  readonly corsOrigins: string[];
  private authRefs = new Map<string, number>();
  private streams = new Set<SseStream>();
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(readonly opts: BridgeAppOptions) {
    this.env = opts.env;
    this.token = ensureToken(opts.env).token;
    registerSecret(this.token);
    this.store = new SessionStore(opts.env);
    this.log = opts.logger ?? (opts.quiet ? silentLogger : createLogger("bridge"));
    this.defaultWorkspace = resolve(opts.workspace);
    this.corsOrigins = (opts.env.SECRETS_AI_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }

  settings(): Settings {
    return loadSettings(this.env);
  }
  secrets(): Secrets {
    return loadSecrets(this.env);
  }

  runtime(workspace = this.defaultWorkspace): WorkspaceRuntime {
    const ws = resolve(workspace);
    let rt = this.runtimes.get(ws);
    if (!rt) {
      rt = new WorkspaceRuntime(
        ws,
        {
          ...(this.opts.supervisor ?? {}),
          workspace: ws,
          env: this.env,
          bin: this.opts.opencodeBin ?? this.opts.supervisor?.bin,
          getSettings: () => this.settings(),
          getSecrets: () => this.secrets(),
          logger: this.opts.supervisor?.logger ?? this.log,
        },
        {
          onEvent: (ev, r) => this.onEvent(ev, r),
          onRaw: (raw) => this.onRaw(raw),
          activeSessions: (r) => [...this.turns.values()].filter((t) => t.rt === r).map((t) => t.sessionId),
          maxSteps: (sid) => this.turns.get(sid)?.maxSteps,
        },
        this.log,
      );
      this.runtimes.set(ws, rt);
      rt.start().catch((e) => this.log.warn(`opencode failed to start for ${ws}: ${redact((e as Error).message)}`));
    }
    return rt;
  }

  trackStream(s: SseStream) {
    this.streams.add(s);
    s.onClose(() => this.streams.delete(s));
  }

  private onRaw(raw: RawEvent) {
    if (raw.type === "session.updated") {
      const info = raw.properties?.info;
      if (info?.id && typeof info.title === "string" && info.title) this.store.update(info.id, { title: info.title });
    }
  }

  publish(ev: AiEvent): StoredEvent {
    return this.hub.publish(ev);
  }

  private onEvent(ev: AiEvent, rt: WorkspaceRuntime) {
    const sid = ev.sessionId;
    const turn = this.turns.get(sid);
    switch (ev.type) {
      case "usage":
        this.store.addUsage(sid, ev);
        break;
      case "status":
        this.store.update(sid, { status: ev.status });
        break;
      case "permission.request":
        this.permissions.set(ev.permissionId, { sessionId: sid, rt, callId: ev.detail.callId });
        if (turn?.autoApprove) {
          rt.client.replyPermission(ev.permissionId, "once").catch((e) => this.log.warn("auto-approve failed", e));
        }
        break;
      case "permission.resolved":
        this.permissions.delete(ev.permissionId);
        break;
      case "question":
        this.questions.set(ev.questionId, { sessionId: sid, rt });
        if (turn?.rejectQuestions) rt.client.rejectQuestion(ev.questionId).catch((e) => this.log.warn("question reject failed", e));
        break;
      default:
        break;
    }
    this.publish(ev);
    if (ev.type === "session.idle") this.endTurn(sid);
  }

  /** Release a turn: drop transient per-request auth and clear pending prompts for the session. */
  endTurn(sid: string) {
    const turn = this.turns.get(sid);
    if (!turn) return;
    this.turns.delete(sid);
    this.store.update(sid, { status: "idle" });
    for (const [id, p] of this.permissions) if (p.sessionId === sid) this.permissions.delete(id);
    for (const [id, q] of this.questions) if (q.sessionId === sid) this.questions.delete(id);
    if (turn.authProvider) {
      const key = `${turn.rt.workspace}\u0000${turn.authProvider}`;
      const n = (this.authRefs.get(key) ?? 1) - 1;
      if (n <= 0) {
        this.authRefs.delete(key);
        turn.rt.client.deleteAuth(turn.authProvider).catch(() => {});
      } else this.authRefs.set(key, n);
    }
  }

  /** Cached model list (for variants) keyed by provider. Never exposes raw /config/providers. */
  async modelsFor(provider: ProviderId, secrets: Secrets, rt?: WorkspaceRuntime, freeToolsOnly = false): Promise<ModelInfo[]> {
    let opencodeProviders: unknown;
    if (rt && rt.sup.state.state === "running") {
      opencodeProviders = await rt.client.configProviders().catch(() => undefined);
    }
    return listModels({ provider, secrets, freeToolsOnly, opencodeProviders, ...(this.opts.models ?? {}) });
  }

  private async modelInfo(rt: WorkspaceRuntime, providerID: string, modelID: string, secrets: Secrets): Promise<ModelInfo | undefined> {
    const k = `${rt.workspace}|${providerID}`;
    const c = this.modelCache.get(k);
    let models = c && Date.now() - c.at < 5 * 60_000 ? c.models : undefined;
    if (!models) {
      models = await this.modelsFor(providerID, secrets, rt).catch(() => []);
      // Fall back to OpenCode's own catalogue for variants (no secrets leave this function).
      if (!models.length) {
        const p = await rt.client.configProviders().catch(() => undefined);
        const prov = (p?.providers ?? []).find((x: any) => x?.id === providerID);
        models = Object.entries(prov?.models ?? {}).map(([id, m]: [string, any]) => ({
          id,
          name: String(m?.name ?? id),
          provider: providerID,
          toolCall: Boolean(m?.capabilities?.toolcall),
          reasoning: Boolean(m?.capabilities?.reasoning),
          free: false,
          variants: Object.keys(m?.variants ?? {}),
        }));
      }
      this.modelCache.set(k, { at: Date.now(), models });
    }
    return models.find((m) => m.id === modelID);
  }

  /**
   * Start a turn: apply per-request secrets, subscribe to the session, send prompt_async.
   * Returns the buffered subscription; the caller drains it into its stream.
   */
  async startTurn(
    session: BridgeSession,
    req: FastifyRequest,
    body: { text: string; provider?: ProviderId; model?: string; effort?: Settings["effort"]; system?: string; agent?: string },
    extra: Partial<Turn> = {},
  ): Promise<{ turn: Turn; queue: StoredEvent[]; attach(fn: (e: StoredEvent) => void): void; detach(): void }> {
    if (this.turns.has(session.id)) throw new HttpError(409, "session_busy", "this session is already running a turn");
    const sec = requestSecrets(req);
    const rt = this.runtime(session.workspace);
    if (sec.githubToken || sec.secretsToken) {
      rt.sup.setSecretOverrides({ githubToken: sec.githubToken, secretsToken: sec.secretsToken });
      await rt.sup.reload().catch((e) => this.log.warn("reload failed", e));
    }
    try {
      await rt.waitConnected(this.opts.supervisor?.healthTimeoutMs ? this.opts.supervisor.healthTimeoutMs + 10_000 : 40_000);
    } catch (e) {
      throw new HttpError(503, "opencode_unavailable", redact((e as Error).message));
    }
    const settings = this.settings();
    const provider = body.provider ?? settings.provider;
    const model = body.model ?? (body.provider && body.provider !== settings.provider ? (PROVIDER_PRESETS as any)[provider]?.defaultModel : settings.model) ?? settings.model;
    const ref = this.opts.modelOverride ?? modelRef({ provider, model });
    const effort = body.effort ?? settings.effort;
    const secrets = { ...this.secrets() };
    if (sec.providerKey) {
      if (ref.providerID === "google") secrets.geminiApiKey = sec.providerKey;
      else if (ref.providerID === "openrouter") secrets.openrouterApiKey = sec.providerKey;
    }
    const info = await this.modelInfo(rt, ref.providerID, ref.modelID, secrets).catch(() => undefined);
    const resolved = resolveEffort(effort, info);
    if (this.turns.has(session.id)) throw new HttpError(409, "session_busy", "this session is already running a turn");
    const turn: Turn = { sessionId: session.id, rt, maxSteps: resolved.steps, ...extra };
    this.turns.set(session.id, turn);

    const queue: StoredEvent[] = [];
    let sink: ((e: StoredEvent) => void) | undefined;
    const unsub = this.hub.subscribe(session.id, (e) => (sink ? sink(e) : queue.push(e)));
    try {
      if (sec.providerKey) {
        await rt.client.setAuth(ref.providerID, sec.providerKey);
        turn.authProvider = ref.providerID;
        const key = `${rt.workspace}\u0000${ref.providerID}`;
        this.authRefs.set(key, (this.authRefs.get(key) ?? 0) + 1);
      }
      rt.normalizer.beginTurn(session.id);
      this.store.update(session.id, { status: "busy" });
      await rt.client.promptAsync(session.id, {
        parts: [{ type: "text", text: body.text }],
        model: ref,
        agent: body.agent ?? settings.agentMode,
        ...(body.system ? { system: body.system } : {}),
        ...(resolved.variant ? { variant: resolved.variant } : {}),
      });
    } catch (e) {
      unsub();
      this.endTurn(session.id);
      throw e instanceof HttpError ? e : new HttpError(502, "opencode_error", redact((e as Error).message));
    }
    return {
      turn,
      queue,
      attach(fn) {
        sink = fn;
        for (const e of queue.splice(0)) fn(e);
      },
      detach: unsub,
    };
  }

  async close(): Promise<void> {
    for (const s of [...this.streams]) s.close();
    await Promise.all([...this.runtimes.values()].map((r) => r.stop().catch(() => {})));
  }

  isLegacyAllowed(req: FastifyRequest): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && this.corsOrigins.includes(origin.replace(/\/+$/, ""));
  }
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  const msg = redact(message);
  // The legacy frontend reads `message` (or a string `error`); add it on legacy paths only.
  const legacy = /^\/v1\/(chat|models)(\/|\?|$)/.test(reply.request.url);
  return reply.code(status).send(legacy ? { error: { code, message: msg }, message: msg } : { error: { code, message: msg } });
}

const DECISIONS = new Set<PermissionDecision>(["allow", "deny", "allow_session"]);

function settingsResponse(b: Bridge): SettingsResponse {
  const s = b.secrets();
  return { settings: b.settings(), secrets: { openrouter: !!s.openrouterApiKey, google: !!s.geminiApiKey, github: !!s.githubToken, secrets: !!s.secretsToken } };
}

export async function buildApp(b: Bridge): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 4 * 1024 * 1024 });
  // Accept an empty JSON body (clients often send `content-type: application/json` on bodyless POST/DELETE).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body);
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, "invalid_json", "request body is not valid JSON"), undefined);
    }
  });

  if (b.corsOrigins.length) {
    await app.register(cors, {
      origin: b.corsOrigins,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization", "accept", "last-event-id", "x-provider-key", "x-github-token", "x-secrets-token"],
      exposedHeaders: ["x-run-id"],
    });
  }

  /*
   * Auth. Every /v1/* route needs `Authorization: Bearer <token>`.
   * Exception (legacy compatibility): the existing Secrets web frontend cannot send the bridge token,
   * so the LEGACY_ROUTES (/v1/chat, /v1/chat/:runId/confirm, /v1/chat/:runId/stop, GET /v1/models)
   * are allowed without a bearer ONLY when the request's Origin header exactly matches an entry of
   * $SECRETS_AI_CORS_ORIGINS. With no CORS origins configured, legacy routes require the bearer too.
   * Note: Origin is enforced by browsers; this keeps other web pages out, while the bridge itself only
   * binds to 127.0.0.1 by default.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/") || req.method === "OPTIONS") return;
    if (verifyBearer(req.headers.authorization, b.token)) return;
    const route = req.routeOptions?.url;
    if (route && LEGACY_ROUTES.has(`${req.method} ${route}`) && b.isLegacyAllowed(req)) return;
    return sendError(reply, 401, "unauthorized", "missing or invalid bearer token");
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err.status, err.code, err.message);
    if (err instanceof SettingsError) return sendError(reply, 400, "invalid_settings", err.message);
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) b.log.error("request failed", err);
    return sendError(reply, status, status >= 500 ? "internal" : "bad_request", status >= 500 ? "internal error" : String(err.message ?? "bad request"));
  });
  app.setNotFoundHandler((req, reply) => sendError(reply, 404, "not_found", `no route ${req.method} ${req.url.split("?")[0]}`));

  app.get("/health", async (): Promise<HealthResponse> => {
    const rts = [...b.runtimes.values()];
    const running = rts.find((r) => r.sup.state.state === "running");
    return { ok: true, version: BRIDGE_VERSION, opencode: { running: !!running, version: running?.sup.state.version, workspaces: rts.length } };
  });

  const getSession = (id: string) => {
    const s = b.store.get(id);
    if (!s) throw new HttpError(404, "session_not_found", `unknown session ${id}`);
    return s;
  };

  app.post("/v1/sessions", async (req) => {
    const body = (req.body ?? {}) as CreateSessionRequest;
    let ws = b.defaultWorkspace;
    if (body.workspace !== undefined) {
      if (typeof body.workspace !== "string" || !isAbsolute(body.workspace)) throw new HttpError(400, "invalid_workspace", "workspace must be an absolute path");
      let ok = false;
      try {
        ok = statSync(body.workspace).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) throw new HttpError(400, "invalid_workspace", "workspace directory does not exist");
      ws = resolve(body.workspace);
    }
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 500)) throw new HttpError(400, "invalid_title", "title must be a string");
    const rt = b.runtime(ws);
    try {
      await rt.waitConnected();
    } catch (e) {
      throw new HttpError(503, "opencode_unavailable", (e as Error).message);
    }
    const oc = await rt.client.createSession(body.title ? { title: body.title } : {}).catch((e) => {
      throw new HttpError(502, "opencode_error", (e as Error).message);
    });
    const session = b.store.add({ id: oc.id, title: body.title || oc.title || "New session", workspace: ws });
    return { session };
  });

  app.get("/v1/sessions", async () => ({ sessions: b.store.list() }));
  app.get<{ Params: { id: string } }>("/v1/sessions/:id", async (req) => ({ session: getSession(req.params.id) }));
  app.delete<{ Params: { id: string } }>("/v1/sessions/:id", async (req) => {
    const s = getSession(req.params.id);
    const rt = b.runtimes.get(s.workspace);
    if (b.turns.has(s.id)) await rt?.client.abort(s.id).catch(() => {});
    if (rt && rt.sup.state.state === "running") await rt.client.deleteSession(s.id).catch(() => {});
    b.store.remove(s.id);
    b.hub.drop(s.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/sessions/:id/messages", async (req, reply) => {
    const s = getSession(req.params.id);
    const body = (req.body ?? {}) as SendMessageRequest;
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "invalid_message", "text is required");
    if (body.model !== undefined && (typeof body.model !== "string" || !body.model)) throw new HttpError(400, "invalid_message", "model must be a string");
    if (body.system !== undefined && typeof body.system !== "string") throw new HttpError(400, "invalid_message", "system must be a string");
    let effort: Settings["effort"] | undefined;
    if (body.effort !== undefined) {
      try {
        effort = validateSettingsPatch({ effort: body.effort }).effort;
      } catch (e) {
        throw new HttpError(400, "invalid_message", (e as Error).message);
      }
    }
    const t = await b.startTurn(s, req, { text: body.text, provider: normalizeProvider(body.provider), model: body.model, effort, system: body.system });
    const stream = new SseStream(reply, { pingMs: b.opts.pingMs });
    b.trackStream(stream);
    stream.onClose(() => t.detach());
    t.attach((e) => {
      stream.event(e.ev.type, e.ev, e.seq);
      if (e.ev.type === "session.idle") stream.close();
    });
    return reply;
  });

  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>("/v1/sessions/:id/events", async (req, reply) => {
    const s = getSession(req.params.id);
    const lastRaw = (req.headers["last-event-id"] as string | undefined) ?? req.query.lastEventId;
    const last = lastRaw !== undefined && /^\d+$/.test(String(lastRaw).trim()) ? Number(String(lastRaw).trim()) : undefined;
    const stream = new SseStream(reply, { pingMs: b.opts.pingMs });
    b.trackStream(stream);
    let maxSent = last ?? 0;
    const send = (e: StoredEvent) => {
      if (e.seq <= maxSent) return;
      maxSent = e.seq;
      stream.event(e.ev.type, e.ev, e.seq);
    };
    const unsub = b.hub.subscribe(s.id, send);
    stream.onClose(unsub);
    if (last !== undefined) for (const e of b.hub.since(s.id, last)) send(e);
    return reply;
  });

  app.post<{ Params: { id: string } }>("/v1/sessions/:id/abort", async (req) => {
    const s = getSession(req.params.id);
    const rt = b.runtimes.get(s.workspace);
    if (!rt || rt.sup.state.state !== "running") return { ok: false };
    const turn = b.turns.get(s.id);
    if (turn) turn.stopped = true;
    const ok = await rt.client.abort(s.id).catch((e) => {
      throw new HttpError(502, "opencode_error", (e as Error).message);
    });
    return { ok: ok !== false };
  });

  app.post<{ Params: { id: string } }>("/v1/permissions/:id/respond", async (req) => {
    const body = (req.body ?? {}) as PermissionRespondRequest;
    if (!DECISIONS.has(body.decision)) throw new HttpError(400, "invalid_decision", "decision must be allow|deny|allow_session");
    const id = req.params.id;
    const known = b.permissions.get(id);
    const candidates = known ? [known.rt] : [...b.runtimes.values()].filter((r) => r.sup.state.state === "running");
    for (const rt of candidates) {
      try {
        await rt.client.replyPermission(id, toOpenCodeReply(body.decision));
        return { ok: true };
      } catch (e) {
        if (known) throw new HttpError(502, "opencode_error", (e as Error).message);
      }
    }
    throw new HttpError(404, "permission_not_found", `unknown or already answered permission ${id}`);
  });

  app.post<{ Params: { id: string } }>("/v1/questions/:id/respond", async (req) => {
    const body = (req.body ?? {}) as QuestionRespondRequest;
    if (!body.reject && (!Array.isArray(body.answers) || !body.answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string")))) {
      throw new HttpError(400, "invalid_answers", "answers must be string[][] (or reject:true)");
    }
    const id = req.params.id;
    const known = b.questions.get(id);
    const candidates = known ? [known.rt] : [...b.runtimes.values()].filter((r) => r.sup.state.state === "running");
    for (const rt of candidates) {
      try {
        if (body.reject) await rt.client.rejectQuestion(id);
        else await rt.client.replyQuestion(id, body.answers!);
        b.questions.delete(id);
        return { ok: true };
      } catch (e) {
        if (known) throw new HttpError(502, "opencode_error", (e as Error).message);
      }
    }
    throw new HttpError(404, "question_not_found", `unknown or already answered question ${id}`);
  });

  app.get<{ Querystring: { provider?: string; free_tools?: string } }>("/v1/models", async (req) => {
    const provider = normalizeProvider(req.query.provider) ?? b.settings().provider;
    const sec = requestSecrets(req);
    const secrets = { ...b.secrets() };
    if (sec.providerKey) {
      if (provider === "google") secrets.geminiApiKey = sec.providerKey;
      else secrets.openrouterApiKey = sec.providerKey;
    }
    const rt = b.runtimes.get(b.defaultWorkspace);
    const freeTools = req.query.free_tools === "1" || req.query.free_tools === "true";
    try {
      const models = await b.modelsFor(provider, secrets, rt, freeTools);
      return { models };
    } catch (e) {
      throw new HttpError(502, "models_failed", (e as Error).message);
    }
  });

  app.get("/v1/settings", async () => settingsResponse(b));
  app.put("/v1/settings", async (req) => {
    const patch = validateSettingsPatch(req.body);
    saveSettings(mergeSettings(b.settings(), patch), b.env);
    await Promise.all([...b.runtimes.values()].map((r) => r.sup.reload().catch((e) => b.log.warn("reload failed", e))));
    return settingsResponse(b);
  });

  const SECRET_KEYS: Array<keyof Secrets> = ["openrouterApiKey", "geminiApiKey", "githubToken", "secretsToken"];
  app.put("/v1/secrets", async (req) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_secrets", "body must be an object");
    for (const [k, v] of Object.entries(body)) {
      if (!SECRET_KEYS.includes(k as keyof Secrets)) throw new HttpError(400, "invalid_secrets", `unknown secret ${k}`);
      if (typeof v !== "string" || v.length > 4096) throw new HttpError(400, "invalid_secrets", `${k} must be a string`);
    }
    for (const [k, v] of Object.entries(body) as Array<[keyof Secrets, string]>) {
      registerSecret(v);
      saveSecret(k, v.trim(), b.env);
    }
    await Promise.all([...b.runtimes.values()].map((r) => r.sup.reload().catch((e) => b.log.warn("reload failed", e))));
    return settingsResponse(b);
  });

  app.post("/v1/settings/test-connection", async (req): Promise<TestConnectionResponse> => {
    const body = (req.body ?? {}) as { provider?: string };
    const provider = normalizeProvider(body.provider) ?? b.settings().provider;
    const sec = requestSecrets(req);
    const secrets = { ...b.secrets() };
    if (sec.providerKey) {
      if (provider === "google") secrets.geminiApiKey = sec.providerKey;
      else secrets.openrouterApiKey = sec.providerKey;
    }
    const r = await testConnection(provider, secrets, b.opts.models).catch((e) => ({ ok: false, message: (e as Error).message, models: undefined }));
    return { ok: r.ok, provider, message: redact(r.message), ...(r.models !== undefined ? { models: r.models } : {}) };
  });

  registerLegacyRoutes(app, b);
  return app;
}
