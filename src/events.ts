import type { AiProvider, Effort } from "./contract.js";

/**
 * Normalized AI event stream shared with the Secrets frontend and `secrets-ai` CLI.
 * Documented in docs.secrets/EVENTS.md.
 */
export type AiEvent =
  | { type: "text.delta"; sessionId: string; text: string }
  | { type: "reasoning.delta"; sessionId: string; text: string }
  | { type: "tool.start"; sessionId: string; callId: string; name: string; input: unknown }
  | { type: "tool.end"; sessionId: string; callId: string; output: unknown; error?: string }
  | { type: "permission.request"; sessionId: string; permissionId: string; action: string; detail: unknown }
  | { type: "question"; sessionId: string; questionId: string; text: string; options?: string[] }
  | { type: "session.idle"; sessionId: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "usage"; sessionId: string; inputTokens?: number; outputTokens?: number; costUsd?: number };

export type PermissionDecision = "allow" | "deny" | "allow_session";

export interface BridgeSettings {
  provider: AiProvider;
  model: string;
  effort: Effort;
  agentMode: boolean;
  tools: {
    github: boolean;
    secrets: boolean;
  };
  autoApprove: boolean;
  systemPrompt?: string;
}

export interface SessionInfo {
  id: string;
  workspaceDir: string;
  title?: string;
  createdAt: string;
  provider?: AiProvider;
  model?: string;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  provider: "openrouter",
  model: "openrouter/auto",
  effort: { level: "medium", maxSteps: 8 },
  agentMode: true,
  tools: {
    github: false,
    secrets: true,
  },
  autoApprove: false,
};
