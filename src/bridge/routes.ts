import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AiProvider } from "../contract.js";
import {
  DEFAULT_BRIDGE_SETTINGS,
  type AiEvent,
  type BridgeSettings,
  type PermissionDecision,
  type SessionInfo,
} from "../events.js";
import { formatOpenCodeModel, mapEffort } from "../presets/effort.js";
import { fetchGeminiModels, fetchOpenRouterModels, testProviderConnection } from "../presets/models.js";
import { readStoredConfig, readStoredSessions, redactSecrets, writeStoredSessions } from "../security/auth.js";
import { OpenCodeSupervisor, type OpenCodeSupervisorOptions } from "../supervisor/opencode.js";
import { normalizeOpenCodeEvent } from "./normalize.js";
import { OpenCodeClient } from "./opencode-client.js";

export interface BridgeRouterOptions {
  defaultWorkspaceDir?: string;
  supervisorOptions?: Partial<Omit<OpenCodeSupervisorOptions, "workspaceDir">>;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

function resolveProviderKey(provider: AiProvider, req?: FastifyRequest): string {
  const fromHeader = req ? header(req, "x-provider-key") : undefined;
  if (fromHeader) return fromHeader;
  const stored = readStoredConfig();
  if (provider === "openrouter") {
    return process.env.OPENROUTER_API_KEY?.trim() || stored?.openrouterKey || "";
  }
  if (provider === "gemini") {
    return process.env.GEMINI_API_KEY?.trim() || stored?.geminiKey || "";
  }
  return "mock";
}

function resolveToolEnv(req?: FastifyRequest): Record<string, string> {
  const stored = readStoredConfig();
  const env: Record<string, string> = {};
  const orKey = (req && header(req, "x-provider-key")) || process.env.OPENROUTER_API_KEY || stored?.openrouterKey;
  const gemKey = process.env.GEMINI_API_KEY || stored?.geminiKey;
  const ghToken = (req && header(req, "x-github-token")) || process.env.GITHUB_TOKEN || stored?.githubToken;
  const secToken = (req && header(req, "x-secrets-token")) || process.env.SECRETS_TOKEN || stored?.secretsToken;
  const secUrl = process.env.SECRETS_API_URL || stored?.secretsApiUrl;

  if (orKey) env.OPENROUTER_API_KEY = orKey;
  if (gemKey) env.GEMINI_API_KEY = gemKey;
  if (ghToken) env.GITHUB_TOKEN = ghToken;
  if (secToken) env.SECRETS_TOKEN = secToken;
  if (secUrl) env.SECRETS_API_URL = secUrl;
  return env;
}

function parsePermissionDecision(body: unknown): PermissionDecision | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.decision === "allow" || b.decision === "deny" || b.decision === "allow_session") {
    return b.decision;
  }
  if (b.allow === true) return "allow";
  if (b.deny === true) return "deny";
  if (b.allow_session === true) return "allow_session";
  return null;
}

export function registerBridgeRoutes(app: FastifyInstance, options: BridgeRouterOptions = {}): void {
  const defaultWorkspace = options.defaultWorkspaceDir || process.cwd();
  let settings: BridgeSettings = structuredClone(DEFAULT_BRIDGE_SETTINGS);

  const workspaces = new Map<string, { supervisor: OpenCodeSupervisor; client: OpenCodeClient }>();
  const sessions = new Map<string, { info: SessionInfo; workspaceDir: string; activeAbort?: AbortController }>();
  for (const info of readStoredSessions<SessionInfo>()) {
    if (info && typeof info.id === "string" && typeof info.workspaceDir === "string") {
      sessions.set(info.id, { info, workspaceDir: info.workspaceDir });
    }
  }
  const permissionIndex = new Map<string, { sessionId: string; workspaceDir: string }>();

  function persistSessions() {
    writeStoredSessions([...sessions.values()].map((s) => s.info));
  }

  async function ensureWorkspace(workspaceDir: string, req?: FastifyRequest) {
    const existing = workspaces.get(workspaceDir);
    if (existing && existing.supervisor.isRunning && existing.supervisor.baseUrl) {
      existing.client.setBaseUrl(existing.supervisor.baseUrl);
      return existing;
    }
    const supervisor = new OpenCodeSupervisor({
      ...options.supervisorOptions,
      workspaceDir,
      settings,
      env: { ...options.supervisorOptions?.env, ...resolveToolEnv(req) },
    });
    const { baseUrl } = await supervisor.start();
    const client = new OpenCodeClient(baseUrl);
    const entry = { supervisor, client };
    workspaces.set(workspaceDir, entry);
    return entry;
  }

  app.addHook("onClose", async () => {
    await Promise.all([...workspaces.values()].map((w) => w.supervisor.stop().catch(() => {})));
    workspaces.clear();
  });

  app.get("/v1/settings", async () => ({ settings }));

  app.put<{ Body: Partial<BridgeSettings> }>("/v1/settings", async (req, reply) => {
    const b = req.body ?? {};
    if (b.provider && !["openrouter", "gemini", "mock"].includes(b.provider)) {
      return reply.status(400).send({ error: "bad_request", message: "provider must be openrouter, gemini, or mock." });
    }
    settings = {
      ...settings,
      ...b,
      effort: b.effort ? { ...settings.effort, ...b.effort } : settings.effort,
      tools: b.tools ? { ...settings.tools, ...b.tools } : settings.tools,
    };
    const env = resolveToolEnv(req);
    await Promise.all([...workspaces.values()].map((w) => w.supervisor.updateSettings(settings, env)));
    return { ok: true, settings };
  });

  app.post<{ Body: { provider?: AiProvider; apiKey?: string } }>("/v1/settings/test-connection", async (req) => {
    const provider = req.body?.provider ?? settings.provider;
    const apiKey = req.body?.apiKey?.trim() || resolveProviderKey(provider, req);
    return testProviderConnection(provider, apiKey, AbortSignal.timeout(15_000));
  });

  app.get<{ Querystring: { provider?: string; free_tools?: string; freeOnly?: string } }>(
    "/v1/bridge/models",
    async (req, reply) => {
      const provider = (req.query.provider ?? settings.provider) as AiProvider;
      const freeToolsOnly = req.query.free_tools === "1" || req.query.free_tools === "true" || req.query.freeOnly === "true";
      const apiKey = resolveProviderKey(provider, req);

      if (provider === "mock") {
        return { models: [{ id: "mock-1", name: "Mock Demo Model", free: true, supportsTools: true }] };
      }
      if (provider === "gemini") {
        if (!apiKey) {
          return reply.status(401).send({ error: "missing_key", message: "Gemini API key is required." });
        }
        const models = await fetchGeminiModels(apiKey, AbortSignal.timeout(15_000));
        return { models };
      }
      const models = await fetchOpenRouterModels(apiKey, { freeToolsOnly, signal: AbortSignal.timeout(15_000) });
      return { models };
    },
  );

  app.post<{ Body: { workspaceDir?: string; title?: string } }>("/v1/sessions", async (req, reply) => {
    const workspaceDir = req.body?.workspaceDir?.trim() || defaultWorkspace;
    const { client } = await ensureWorkspace(workspaceDir, req);
    const created = await client.createSession(workspaceDir, req.body?.title);
    const info: SessionInfo = {
      id: created.id,
      workspaceDir,
      title: req.body?.title,
      createdAt: new Date().toISOString(),
      provider: settings.provider,
      model: settings.model,
    };
    sessions.set(info.id, { info, workspaceDir });
    persistSessions();
    return reply.status(201).send({ session: info });
  });

  app.get("/v1/sessions", async () => {
    return { sessions: [...sessions.values()].map((s) => s.info) };
  });

  app.post<{
    Params: { id: string };
    Body: { text?: string; content?: string; model?: string; systemPrompt?: string };
  }>("/v1/sessions/:id/messages", async (req, reply) => {
    const sessionId = req.params.id;
    const text = (req.body?.text ?? req.body?.content ?? "").trim();
    if (!text) {
      return reply.status(400).send({ error: "bad_request", message: "text is required." });
    }

    let entry = sessions.get(sessionId);
    if (!entry) {
      // Allow connecting to a session known directly by the default workspace
      await ensureWorkspace(defaultWorkspace, req);
      entry = {
        info: { id: sessionId, workspaceDir: defaultWorkspace, createdAt: new Date().toISOString() },
        workspaceDir: defaultWorkspace,
      };
      sessions.set(sessionId, entry);
    }

    const { client } = await ensureWorkspace(entry.workspaceDir, req);
    const ac = new AbortController();
    entry.activeAbort = ac;

    reply.hijack();
    const raw = reply.raw;
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) headers[k] = v as string;
    }
    raw.writeHead(200, {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders?.();

    let open = true;
    const emit = (ev: AiEvent) => {
      if (open && !raw.writableEnded) {
        raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };

    const heartbeat = setInterval(() => {
      if (open && !raw.writableEnded) raw.write(": ping\n\n");
    }, 15_000);

    raw.on("close", () => {
      open = false;
      ac.abort();
      client.abortSession(sessionId).catch(() => {});
    });

    const effortMap = mapEffort(settings.effort);
    const model = formatOpenCodeModel(settings.provider, req.body?.model ?? settings.model);
    const system = req.body?.systemPrompt ?? settings.systemPrompt;

    try {
      const eventStream = client.subscribeEvents(ac.signal);

      // Kick off prompt concurrently while consuming SSE events
      const promptPromise = client.sendPrompt(
        sessionId,
        {
          text,
          model,
          variant: effortMap.reasoningEffort,
          ...(system ? { system } : {}),
        },
        ac.signal,
      );

      promptPromise.catch((err) => {
        if (!ac.signal.aborted) {
          emit({ type: "error", sessionId, message: redactSecrets((err as Error).message) });
          ac.abort();
        }
      });

      for await (const rawEv of eventStream) {
        if (ac.signal.aborted) break;
        const normalized = normalizeOpenCodeEvent(rawEv, sessionId);
        if (!normalized) continue;
        if (normalized.sessionId !== sessionId) continue;

        if (normalized.type === "permission.request") {
          permissionIndex.set(normalized.permissionId, {
            sessionId,
            workspaceDir: entry.workspaceDir,
          });
        }
        emit(normalized);
        if (normalized.type === "session.idle" || normalized.type === "error") {
          break;
        }
      }

      await promptPromise.catch(() => {});
    } catch (err) {
      if (!ac.signal.aborted) {
        emit({ type: "error", sessionId, message: redactSecrets((err as Error).message) });
      }
    } finally {
      clearInterval(heartbeat);
      entry.activeAbort = undefined;
      if (!raw.writableEnded) raw.end();
    }
  });

  app.post<{ Params: { id: string } }>("/v1/sessions/:id/abort", async (req, reply) => {
    const entry = sessions.get(req.params.id);
    if (!entry) {
      return reply.status(404).send({ error: "not_found", message: "Session not found." });
    }
    entry.activeAbort?.abort();
    const ws = workspaces.get(entry.workspaceDir);
    if (ws) {
      await ws.client.abortSession(req.params.id).catch(() => false);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/v1/permissions/:id/respond", async (req, reply) => {
    const decision = parsePermissionDecision(req.body);
    if (!decision) {
      return reply.status(400).send({
        error: "bad_request",
        message: 'Body must specify decision ("allow" | "deny" | "allow_session").',
      });
    }
    const perm = permissionIndex.get(req.params.id);
    if (!perm) {
      return reply.status(404).send({ error: "not_found", message: "Permission request not found." });
    }
    const ws = workspaces.get(perm.workspaceDir);
    if (!ws) {
      return reply.status(409).send({ error: "workspace_offline", message: "Workspace supervisor is not running." });
    }
    const ok = await ws.client.respondPermission(perm.sessionId, req.params.id, decision);
    permissionIndex.delete(req.params.id);
    return { ok, decision };
  });
}
