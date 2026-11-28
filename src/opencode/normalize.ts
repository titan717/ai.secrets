/**
 * Stateful converter: raw OpenCode `/event` events -> normalized AiEvent (src/core/events.ts).
 * Keep exactly one Normalizer per OpenCode event connection; it remembers part types, roles and
 * streamed text so deltas and full part updates are not double-emitted.
 *
 * Rules (verified against tests/fixtures/traces/*.jsonl, see docs/OPENCODE-NOTES.md section 3):
 * - message.part.delta has only partID/field/delta: the part type comes from an earlier message.part.updated.
 * - Parts of user messages are ignored (role tracked from message.updated).
 * - A full message.part.updated only emits the suffix that was not streamed already.
 * - tool.start once at the first "running" state (or at completion if never seen running); tool.end on completed/error.
 * - session.error -> error (never responseBody/responseHeaders; redacted).
 * - Completed assistant message.updated -> usage, once per message.
 * - session.idle is emitted once per turn (OpenCode repeats it after errors/aborts).
 */
import type { AiEvent } from "../core/events.js";
import { redact } from "../core/redact.js";
import type { RawEvent } from "./client.js";

interface PartState {
  type: string;
  messageId: string;
  emitted: number; // chars of text already emitted
}

interface ToolState {
  started: boolean;
  ended: boolean;
}

interface SessionState {
  status: "idle" | "busy" | "retry";
  turnActive: boolean;
  steps: number;
}

export interface NormalizerOptions {
  /** Only emit events for these sessions (all when omitted). */
  sessionFilter?: (sessionId: string) => boolean;
  /** maxSteps to attach to step events, per session. */
  maxSteps?: (sessionId: string) => number | undefined;
}

export class Normalizer {
  private roles = new Map<string, string>();
  private parts = new Map<string, PartState>();
  private tools = new Map<string, ToolState>();
  private usageDone = new Set<string>();
  private sessions = new Map<string, SessionState>();

  constructor(private opts: NormalizerOptions = {}) {}

  /** Forget everything (e.g. after the OpenCode child restarted). */
  reset(): void {
    this.roles.clear();
    this.parts.clear();
    this.tools.clear();
    this.usageDone.clear();
    this.sessions.clear();
  }

  private ses(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { status: "idle", turnActive: false, steps: 0 };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Mark a turn as started (the bridge calls this when it sends a prompt). */
  beginTurn(sessionId: string): void {
    const s = this.ses(sessionId);
    s.turnActive = true;
    s.steps = 0;
  }

  push(ev: RawEvent): AiEvent[] {
    const p = ev.properties ?? {};
    const sessionId: string | undefined = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
    if (!sessionId) return [];
    if (this.opts.sessionFilter && !this.opts.sessionFilter(sessionId)) return [];
    const out: AiEvent[] = [];
    const s = this.ses(sessionId);

    switch (ev.type) {
      case "message.updated": {
        const info = p.info ?? {};
        if (info.id && info.role) this.roles.set(info.id, info.role);
        if (info.role === "assistant" && info.time?.completed && !this.usageDone.has(info.id)) {
          this.usageDone.add(info.id);
          const t = info.tokens ?? {};
          const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
          // Errored/aborted messages with no tokens carry no usage information.
          if (!(info.error && total === 0 && !info.cost)) {
            out.push({
              type: "usage",
              sessionId,
              messageId: info.id,
              inputTokens: t.input ?? 0,
              outputTokens: t.output ?? 0,
              reasoningTokens: t.reasoning ?? 0,
              cacheReadTokens: t.cache?.read ?? 0,
              cacheWriteTokens: t.cache?.write ?? 0,
              costUsd: info.cost ?? 0,
            });
          }
        }
        break;
      }
      case "message.part.updated": {
        const part = p.part ?? {};
        if (!part.id || !part.type) break;
        if (this.roles.get(part.messageID) === "user") break;
        let st = this.parts.get(part.id);
        if (!st) {
          st = { type: part.type, messageId: part.messageID, emitted: 0 };
          this.parts.set(part.id, st);
        }
        if (part.type === "text" || part.type === "reasoning") {
          const text: string = typeof part.text === "string" ? part.text : "";
          if (text.length > st.emitted) {
            const suffix = text.slice(st.emitted);
            st.emitted = text.length;
            out.push({ type: part.type === "text" ? "text.delta" : "reasoning.delta", sessionId, text: suffix, messageId: part.messageID, partId: part.id });
          }
        } else if (part.type === "step-start") {
          if (!s.turnActive) {
            s.turnActive = true;
          }
          s.steps += 1;
          const maxSteps = this.opts.maxSteps?.(sessionId);
          out.push(maxSteps ? { type: "step", sessionId, step: s.steps, maxSteps } : { type: "step", sessionId, step: s.steps });
        } else if (part.type === "tool") {
          out.push(...this.tool(sessionId, part));
        }
        break;
      }
      case "message.part.delta": {
        if (p.field !== "text" || typeof p.delta !== "string" || !p.delta) break;
        if (this.roles.get(p.messageID) === "user") break;
        let st = this.parts.get(p.partID);
        if (!st) {
          st = { type: "text", messageId: p.messageID, emitted: 0 };
          this.parts.set(p.partID, st);
        }
        if (st.type !== "text" && st.type !== "reasoning") break;
        st.emitted += p.delta.length;
        out.push({ type: st.type === "text" ? "text.delta" : "reasoning.delta", sessionId, text: p.delta, messageId: p.messageID, partId: p.partID });
        break;
      }
      case "permission.asked": {
        out.push({
          type: "permission.request",
          sessionId,
          permissionId: p.id,
          action: String(p.permission ?? "unknown"),
          detail: {
            patterns: Array.isArray(p.patterns) ? p.patterns : [],
            metadata: p.metadata && typeof p.metadata === "object" ? p.metadata : {},
            always: Array.isArray(p.always) ? p.always : [],
            ...(p.tool?.callID ? { callId: p.tool.callID } : {}),
          },
        });
        break;
      }
      case "permission.replied": {
        out.push({ type: "permission.resolved", sessionId, permissionId: p.requestID ?? p.permissionID ?? p.id, reply: p.reply ?? p.response });
        break;
      }
      case "question.asked": {
        const qs: any[] = Array.isArray(p.questions) ? p.questions : [];
        const questions = qs.map((q) => ({
          question: String(q.question ?? ""),
          ...(q.header ? { header: String(q.header) } : {}),
          options: Array.isArray(q.options) ? q.options.map((o: any) => String(o?.label ?? o)) : [],
          ...(q.multiple !== undefined ? { multiple: Boolean(q.multiple) } : {}),
        }));
        out.push({ type: "question", sessionId, questionId: p.id, text: questions[0]?.question ?? "", options: questions[0]?.options ?? [], questions });
        break;
      }
      case "session.status": {
        const status = p.status ?? {};
        const type = status.type as SessionState["status"];
        if (type !== "idle" && type !== "busy" && type !== "retry") break;
        if (type !== "idle") s.turnActive = true;
        if (type === "retry") {
          s.status = type;
          out.push({
            type: "status",
            sessionId,
            status: "retry",
            ...(status.message ? { message: redact(String(status.message)) } : {}),
            ...(status.attempt !== undefined ? { attempt: status.attempt } : {}),
            ...(status.next !== undefined ? { nextAt: status.next } : {}),
          });
        } else if (s.status !== type) {
          s.status = type;
          out.push({ type: "status", sessionId, status: type });
        }
        break;
      }
      case "session.error": {
        const err = p.error ?? {};
        const message = redact(String(err.data?.message ?? err.message ?? err.name ?? "Unknown error"));
        const ev: AiEvent = { type: "error", sessionId, message };
        if (err.name) ev.code = String(err.name);
        if (typeof err.data?.isRetryable === "boolean") ev.retryable = err.data.isRetryable;
        out.push(ev);
        break;
      }
      case "session.idle": {
        if (s.status !== "idle") {
          s.status = "idle";
          out.push({ type: "status", sessionId, status: "idle" });
        }
        if (s.turnActive) {
          s.turnActive = false;
          s.steps = 0;
          out.push({ type: "session.idle", sessionId });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  private tool(sessionId: string, part: any): AiEvent[] {
    const callId: string = part.callID ?? part.id;
    const name: string = part.tool ?? "tool";
    const state = part.state ?? {};
    let t = this.tools.get(callId);
    if (!t) {
      t = { started: false, ended: false };
      this.tools.set(callId, t);
    }
    const out: AiEvent[] = [];
    if (t.ended) return out;
    const status = state.status;
    if (!t.started && (status === "running" || status === "completed" || status === "error")) {
      t.started = true;
      out.push({ type: "tool.start", sessionId, callId, name, input: state.input ?? {} });
    }
    if (status === "completed") {
      t.ended = true;
      out.push({ type: "tool.end", sessionId, callId, name, output: state.output ?? "" });
    } else if (status === "error") {
      t.ended = true;
      out.push({ type: "tool.end", sessionId, callId, name, output: null, error: redact(String(state.error ?? "tool error")) });
    }
    return out;
  }
}
