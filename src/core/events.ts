/**
 * Normalized event contract shared by the bridge, the `secrets-ai` CLI and the Secrets frontend.
 * Documented in docs.secrets/EVENTS.md. Additive changes only; never rename a field.
 *
 * The bridge streams these as Server-Sent Events: `event: <type>\ndata: <json>\n\n`.
 */

export type AiEvent =
  | { type: "text.delta"; sessionId: string; text: string; messageId?: string; partId?: string }
  | { type: "reasoning.delta"; sessionId: string; text: string; messageId?: string; partId?: string }
  | { type: "tool.start"; sessionId: string; callId: string; name: string; input: unknown }
  | { type: "tool.end"; sessionId: string; callId: string; name?: string; output: unknown; error?: string }
  | {
      type: "permission.request";
      sessionId: string;
      permissionId: string;
      /** OpenCode permission kind: "bash" | "edit" | "webfetch" | "<mcp tool>" ... */
      action: string;
      detail: { patterns: string[]; metadata: Record<string, unknown>; always: string[]; callId?: string };
    }
  | {
      type: "question";
      sessionId: string;
      questionId: string;
      text: string;
      options?: string[];
      /** Full OpenCode question list when the agent asks several at once. */
      questions?: Array<{ question: string; header?: string; options: string[]; multiple?: boolean }>;
    }
  | { type: "session.idle"; sessionId: string }
  | { type: "error"; sessionId: string; message: string; code?: string; retryable?: boolean }
  // ---- Additive extensions (clients may ignore) ----
  | {
      type: "usage";
      sessionId: string;
      messageId: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    }
  | { type: "status"; sessionId: string; status: "busy" | "retry" | "idle"; message?: string; attempt?: number; nextAt?: number }
  | { type: "permission.resolved"; sessionId: string; permissionId: string; reply: "once" | "always" | "reject" }
  | { type: "step"; sessionId: string; step: number; maxSteps?: number };

export type AiEventType = AiEvent["type"];

/** Event types every client MUST handle (the original contract). */
export const CORE_EVENT_TYPES = [
  "text.delta",
  "reasoning.delta",
  "tool.start",
  "tool.end",
  "permission.request",
  "question",
  "session.idle",
  "error",
] as const satisfies readonly AiEventType[];

export type PermissionDecision = "allow" | "deny" | "allow_session";

/** Bridge decision -> OpenCode `POST /permission/{id}/reply` body.reply */
export function toOpenCodeReply(decision: PermissionDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "allow":
      return "once";
    case "allow_session":
      return "always";
    case "deny":
      return "reject";
  }
}

/** Encode one event as an SSE frame. */
export function sseFrame(ev: AiEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}
