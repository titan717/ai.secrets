import { createHash } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AiChatRequest, AiStreamEvent } from "./contract.js";
import { runAgent } from "./agent/loop.js";
import { activeRuns, createRun, endRun, getRun } from "./agent/runs.js";
import { registerBridgeRoutes, type BridgeRouterOptions } from "./bridge/routes.js";
import { fetchOpenRouterModels } from "./presets/models.js";
import { getProvider } from "./providers/index.js";
import { ProviderError } from "./providers/types.js";
import { ensureBridgeToken, readStoredConfig, verifyBearerToken } from "./security/auth.js";

export interface BuildAppOptions extends BridgeRouterOptions {
  bridgeToken?: string;
  requireAuth?: boolean;
}

const VERSION = "0.1.0";
const SECRET_HEADERS = ["x-provider-key", "x-github-token", "x-secrets-token", "authorization", "cookie"];
const MODELS_TTL_MS = Number(process.env.MODELS_CACHE_TTL_MS) || 10 * 60 * 1000;

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

function corsOrigin(): boolean | string | string[] {
  const raw = (process.env.CORS_ORIGIN ?? "*").trim();
  if (raw === "*" || raw === "") return true; // reflect any origin
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 1 ? list[0] : list;
}

function validateChat(b: any): string | null {
  if (!b || typeof b !== "object") return "Body must be a JSON object (AiChatRequest).";
  if (!["gemini", "openrouter", "mock"].includes(b.provider)) return 'provider must be "gemini", "openrouter" or "mock".';
  if (typeof b.model !== "string" || !b.model.trim()) return "model is required.";
  if (!Array.isArray(b.messages) || !b.messages.length) return "messages must be a non-empty array.";
  for (const m of b.messages) {
    if (!m || !["user", "assistant", "system"].includes(m.role) || typeof m.content !== "string") return "each message needs role (user|assistant|system) and string content.";
  }
  if (!b.effort || !["low", "medium", "high", "custom"].includes(b.effort.level)) return "effort.level must be low|medium|high|custom.";
  return null;
}

const modelsCache = new Map<string, { at: number; models: { id: string; name: string }[] }>();

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const bridgeToken = options.bridgeToken ?? ensureBridgeToken();
  const requireAuth = options.requireAuth ?? process.env.DISABLE_BRIDGE_AUTH !== "1";

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      redact: { paths: SECRET_HEADERS.map((h) => `req.headers["${h}"]`), censor: "[redacted]" },
    },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: corsOrigin(),
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["content-type", ...SECRET_HEADERS.filter((h) => h !== "cookie")],
    maxAge: 86400,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!requireAuth || req.method === "OPTIONS") return;
    if (!req.url.startsWith("/v1/")) return;
    if (!verifyBearerToken(req.headers.authorization, bridgeToken)) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "Valid Authorization: Bearer <token> header is required.",
      });
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.status(status).send({ error: status >= 500 ? "internal_error" : "bad_request", message: err.message });
  });

  app.get("/health", async () => ({ ok: true, service: "ai.secrets", version: VERSION, active_runs: activeRuns() }));

  app.get("/", async () => ({
    service: "ai.secrets",
    endpoints: [
      "POST /v1/sessions",
      "GET /v1/sessions",
      "POST /v1/sessions/:id/messages",
      "POST /v1/sessions/:id/abort",
      "POST /v1/permissions/:id/respond",
      "GET /v1/models",
      "GET /v1/settings",
      "PUT /v1/settings",
      "POST /v1/settings/test-connection",
      "POST /v1/chat",
      "POST /v1/chat/:runId/confirm",
      "POST /v1/chat/:runId/stop",
      "GET /health",
    ],
  }));

  registerBridgeRoutes(app, options);

  app.get<{ Querystring: { provider?: string; refresh?: string; free_tools?: string; freeOnly?: string } }>(
    "/v1/models",
    async (req, reply) => {
      const providerId = (req.query.provider ?? "openrouter").toLowerCase();
      const freeToolsOnly = req.query.free_tools === "1" || req.query.free_tools === "true" || req.query.freeOnly === "true";
      const provider = getProvider(providerId);
      if (!provider) return reply.status(400).send({ error: "bad_request", message: 'Query "provider" must be gemini, openrouter or mock.' });
      const stored = readStoredConfig();
      const key =
        header(req, "x-provider-key") ??
        (provider.id === "openrouter"
          ? process.env.OPENROUTER_API_KEY || stored?.openrouterKey || ""
          : provider.id === "gemini"
            ? process.env.GEMINI_API_KEY || stored?.geminiKey || ""
            : "");
      if (!key && provider.id === "gemini") return reply.status(401).send({ error: "missing_key", message: "Header x-provider-key (Gemini API key) is required." });
      if (provider.id === "mock") return { models: await provider.listModels("") };
      if (provider.id === "openrouter" && freeToolsOnly) {
        try {
          const models = await fetchOpenRouterModels(key, { freeToolsOnly: true, signal: AbortSignal.timeout(20_000) });
          return { models };
        } catch (e) {
          const status = e instanceof ProviderError && e.status && e.status < 500 ? e.status : 502;
          return reply.status(status).send({ error: "provider_error", message: (e as Error).message });
        }
      }
      const cacheKey = provider.id === "openrouter" ? "openrouter" : `gemini:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      const hit = modelsCache.get(cacheKey);
      if (hit && Date.now() - hit.at < MODELS_TTL_MS && req.query.refresh !== "1") {
        reply.header("x-cache", "hit");
        return { models: hit.models };
      }
      try {
        const models = (await provider.listModels(key, AbortSignal.timeout(20_000))).sort((a, b) => a.id.localeCompare(b.id));
        modelsCache.set(cacheKey, { at: Date.now(), models });
        if (modelsCache.size > 500) modelsCache.delete(modelsCache.keys().next().value!);
        reply.header("x-cache", "miss");
        return { models };
      } catch (e) {
        const status = e instanceof ProviderError && e.status && e.status < 500 ? e.status : 502;
        return reply.status(status).send({ error: "provider_error", message: (e as Error).message });
      }
    },
  );

  app.post<{ Body: AiChatRequest }>("/v1/chat", async (req, reply) => {
    const bad = validateChat(req.body);
    if (bad) return reply.status(400).send({ error: "bad_request", message: bad });
    const body = req.body;
    const apiKey = header(req, "x-provider-key") ?? (body.provider === "mock" ? "mock" : undefined);
    if (!apiKey) return reply.status(401).send({ error: "missing_key", message: `Header x-provider-key (${body.provider} API key) is required.` });
    const provider = getProvider(body.provider)!;

    const run = createRun();
    reply.hijack();
    const raw = reply.raw;
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v as string;
    raw.writeHead(200, {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Run-Id": run.id,
    });
    raw.flushHeaders?.();

    let open = true;
    const emit = (e: AiStreamEvent) => {
      if (open && !raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const heartbeat = setInterval(() => open && raw.write(": ping\n\n"), 15_000);
    raw.on("close", () => {
      open = false;
      run.stop(); // client disconnected => abort provider stream & pending confirms
    });

    emit({ type: "run", run_id: run.id });
    try {
      await runAgent({
        req: body,
        provider,
        apiKey,
        ctx: {
          githubToken: header(req, "x-github-token"),
          secretsToken: header(req, "x-secrets-token"),
          secretsApiUrl: body.secrets_api_url || process.env.SECRETS_API_URL || undefined,
        },
        run,
        emit,
      });
    } catch (e) {
      req.log.error({ err: (e as Error).message }, "run failed");
      emit({ type: "error", message: "Internal error while running the agent." });
    } finally {
      clearInterval(heartbeat);
      endRun(run);
      if (!raw.writableEnded) raw.end();
    }
  });

  app.post<{ Params: { runId: string }; Body: { call_id?: string; approve?: boolean } }>("/v1/chat/:runId/confirm", async (req, reply) => {
    const run = getRun(req.params.runId);
    if (!run) return reply.status(404).send({ error: "not_found", message: "Run not found (finished, stopped, or on another server instance)." });
    const { call_id, approve } = req.body ?? {};
    if (typeof call_id !== "string" || typeof approve !== "boolean") return reply.status(400).send({ error: "bad_request", message: "Body must be { call_id: string, approve: boolean }." });
    if (!run.confirm(call_id, approve)) return reply.status(409).send({ error: "not_pending", message: `No pending confirmation for call ${call_id}.` });
    return { ok: true };
  });

  app.post<{ Params: { runId: string } }>("/v1/chat/:runId/stop", async (req, reply) => {
    const run = getRun(req.params.runId);
    if (!run) return reply.status(404).send({ error: "not_found", message: "Run not found (already finished?)." });
    run.stop();
    return { ok: true };
  });

  return app;
}
