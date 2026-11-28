/**
 * Legacy API for the existing Secrets web frontend (titan717/secrets packages/shared/src/ai.ts).
 *
 *   POST /v1/chat                    AiChatRequest -> SSE `data: <AiStreamEvent>` frames, header x-run-id
 *   POST /v1/chat/:runId/confirm     { call_id, approve }
 *   POST /v1/chat/:runId/stop
 *   GET  /v1/models?provider=        (shared with the new API; { models: [{id, name, ...}] } is compatible)
 *
 * Each /v1/chat call runs in a fresh OpenCode session. The frontend sends the whole history, so prior
 * turns are folded into the prompt as a transcript. Provider "gemini" maps to OpenCode's "google".
 * OpenCode questions are rejected automatically because the legacy UI cannot answer them.
 * Auth: see the comment on the onRequest hook in app.ts (Origin allow-list instead of bearer).
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AiEvent } from "../core/events.js";
import { redact } from "../core/redact.js";
import type { Settings } from "../core/types.js";
import { HttpError, normalizeProvider, sendError, type Bridge } from "./app.js";
import { SseStream } from "./sse.js";

export const LEGACY_ROUTES = new Set(["POST /v1/chat", "POST /v1/chat/:runId/confirm", "POST /v1/chat/:runId/stop", "GET /v1/models"]);

interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}
interface AiChatRequest {
  provider: string;
  model: string;
  effort?: { level: string; maxSteps?: number; thinkingBudget?: number };
  system_prompt?: string;
  messages: AiMessage[];
  agent_mode?: boolean;
  tools_enabled?: { github: boolean; secrets: boolean };
  auto_approve?: boolean;
  secrets_api_url?: string;
}

type LegacyEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call_id: string; name: string; args: unknown; writes: boolean }
  | { type: "confirm_required"; call_id: string; name: string; args: unknown }
  | { type: "tool_result"; call_id: string; name: string; result: unknown; denied?: boolean }
  | { type: "step"; step: number; max_steps: number }
  | { type: "done"; reason: "complete" | "step_limit" | "stopped" }
  | { type: "error"; message: string };

interface Run {
  id: string;
  sessionId: string;
  stopped: boolean;
  /** callID -> permission id */
  permByCall: Map<string, string>;
  tools: Map<string, { name: string; input: unknown }>;
  timer?: NodeJS.Timeout;
}

const WRITE_TOOLS = new Set(["bash", "edit", "write", "patch", "multiedit"]);

/** Translate one normalized event to zero or more legacy events. */
export function toLegacy(ev: AiEvent, run: Run, maxSteps: number): LegacyEvent[] {
  switch (ev.type) {
    case "text.delta":
      return [{ type: "text", delta: ev.text }];
    case "reasoning.delta":
      return [{ type: "reasoning", delta: ev.text }];
    case "tool.start":
      run.tools.set(ev.callId, { name: ev.name, input: ev.input });
      return [{ type: "tool_call", call_id: ev.callId, name: ev.name, args: ev.input, writes: WRITE_TOOLS.has(ev.name) || /write|draft|create|update|delete/i.test(ev.name) }];
    case "permission.request": {
      const callId = ev.detail.callId ?? ev.permissionId;
      run.permByCall.set(callId, ev.permissionId);
      const t = run.tools.get(callId);
      return [{ type: "confirm_required", call_id: callId, name: t?.name ?? ev.action, args: t?.input ?? ev.detail.metadata }];
    }
    case "tool.end": {
      const name = ev.name ?? run.tools.get(ev.callId)?.name ?? "tool";
      if (ev.error) return [{ type: "tool_result", call_id: ev.callId, name, result: { error: ev.error }, ...(/reject|denied|dismiss/i.test(ev.error) ? { denied: true } : {}) }];
      return [{ type: "tool_result", call_id: ev.callId, name, result: ev.output }];
    }
    case "step":
      return [{ type: "step", step: ev.step, max_steps: ev.maxSteps ?? maxSteps }];
    case "error":
      if (ev.code === "MessageAbortedError") {
        run.stopped = true;
        return [];
      }
      return [{ type: "error", message: ev.message }];
    case "session.idle":
      return [{ type: "done", reason: run.stopped ? "stopped" : "complete" }];
    default:
      return [];
  }
}

function transcript(messages: AiMessage[]): { system: string[]; text: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content);
  const convo = messages.filter((m) => m.role !== "system");
  const last = convo[convo.length - 1];
  if (!last || last.role !== "user") throw new HttpError(400, "invalid_messages", "the last message must be from the user");
  const prior = convo.slice(0, -1);
  if (!prior.length) return { system, text: last.content };
  const lines = prior.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  return { system, text: `Conversation so far:\n${lines.join("\n\n")}\n\nUser's new message:\n${last.content}` };
}

export function registerLegacyRoutes(app: FastifyInstance, b: Bridge) {
  const runs = new Map<string, Run>();

  app.post("/v1/chat", async (req, reply) => {
    const body = req.body as AiChatRequest | null;
    if (!body || typeof body !== "object") throw new HttpError(400, "invalid_request", "body must be an AiChatRequest object");
    if (!Array.isArray(body.messages) || !body.messages.every((m) => m && typeof m.content === "string" && ["user", "assistant", "system"].includes(m.role))) {
      throw new HttpError(400, "invalid_messages", "messages must be [{role, content}]");
    }
    if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "invalid_model", "model is required");
    const provider = normalizeProvider(body.provider);
    if (!provider) throw new HttpError(400, "invalid_provider", "provider is required");
    const { system, text } = transcript(body.messages);
    if (body.system_prompt) system.unshift(body.system_prompt);

    let effort: Settings["effort"] | undefined;
    const lvl = body.effort?.level;
    if (lvl === "low" || lvl === "medium" || lvl === "high") effort = { level: lvl };
    else if (lvl === "custom") effort = { level: "custom", maxSteps: Math.min(200, Math.max(1, Math.round(Number(body.effort?.maxSteps) || 8))) };

    const rt = b.runtime();
    try {
      await rt.waitConnected();
    } catch (e) {
      throw new HttpError(503, "opencode_unavailable", (e as Error).message);
    }
    const title = text.split("\n").pop()!.slice(0, 60) || "Chat";
    const oc = await rt.client.createSession({ title }).catch((e) => {
      throw new HttpError(502, "opencode_error", (e as Error).message);
    });
    const session = b.store.add({ id: oc.id, title, workspace: rt.workspace });
    const run: Run = { id: "run_" + randomBytes(12).toString("hex"), sessionId: session.id, stopped: false, permByCall: new Map(), tools: new Map() };
    runs.set(run.id, run);

    let t;
    try {
      t = await b.startTurn(
        session,
        req,
        { text, provider, model: body.model, effort, system: system.join("\n\n") || undefined, agent: body.agent_mode === false ? "plan" : "build" },
        { autoApprove: body.auto_approve === true, rejectQuestions: true },
      );
    } catch (e) {
      runs.delete(run.id);
      throw e;
    }
    const maxSteps = t.turn.maxSteps;
    const stream = new SseStream(reply, { pingMs: b.opts.pingMs, headers: { "x-run-id": run.id } });
    b.trackStream(stream);
    let done = false;
    stream.onClose(() => {
      t.detach();
      // Closing the stream stops the run (legacy semantics).
      if (!done) {
        run.stopped = true;
        rt.client.abort(run.sessionId).catch(() => {});
      }
      run.timer = setTimeout(() => runs.delete(run.id), 60_000);
      run.timer.unref?.();
    });
    t.attach((e) => {
      for (const le of toLegacy(e.ev, run, maxSteps)) {
        if (le.type === "error") le.message = redact(le.message);
        stream.data(le);
        if (le.type === "done") {
          done = true;
          stream.close();
        }
      }
    });
    return reply;
  });

  app.post<{ Params: { runId: string } }>("/v1/chat/:runId/confirm", async (req, reply) => {
    const run = runs.get(req.params.runId);
    if (!run) return sendError(reply, 404, "run_not_found", "unknown run");
    const body = (req.body ?? {}) as { call_id?: string; approve?: boolean };
    if (typeof body.call_id !== "string" || typeof body.approve !== "boolean") return sendError(reply, 400, "invalid_request", "call_id and approve are required");
    const perm = run.permByCall.get(body.call_id) ?? (b.permissions.get(body.call_id)?.sessionId === run.sessionId ? body.call_id : undefined);
    if (!perm) return sendError(reply, 404, "call_not_found", "no pending confirmation for that call");
    const info = b.permissions.get(perm);
    const rt = info?.rt ?? b.runtime();
    await rt.client.replyPermission(perm, body.approve ? "once" : "reject").catch((e) => {
      throw new HttpError(502, "opencode_error", (e as Error).message);
    });
    run.permByCall.delete(body.call_id);
    return { ok: true };
  });

  app.post<{ Params: { runId: string } }>("/v1/chat/:runId/stop", async (req, reply) => {
    const run = runs.get(req.params.runId);
    if (!run) return sendError(reply, 404, "run_not_found", "unknown run");
    run.stopped = true;
    const s = b.store.get(run.sessionId);
    const rt = b.runtime(s?.workspace);
    await rt.client.abort(run.sessionId).catch(() => {});
    return { ok: true };
  });
}
