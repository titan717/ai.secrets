/**
 * Bridge HTTP API contract (implemented by src/bridge, consumed by src/cli and the Secrets frontend).
 * Owned by AMIT. Additive changes only.
 *
 * Auth: every /v1/* route requires `Authorization: Bearer <token>` (token from ~/.config/secrets-ai/auth.json
 * or $SECRETS_AI_TOKEN). `GET /health` is open. Optional per-request secret headers (never stored, never logged):
 *   x-provider-key   -> key for the active provider (OpenRouter or Gemini)
 *   x-github-token   -> GitHub token for the GitHub MCP preset
 *   x-secrets-token  -> Secrets API session token for secrets-mcp
 *
 *   GET    /health                          -> HealthResponse                  (no auth)
 *   POST   /v1/sessions                     CreateSessionRequest -> { session: BridgeSession }
 *   GET    /v1/sessions                     -> { sessions: BridgeSession[] }
 *   GET    /v1/sessions/:id                 -> { session: BridgeSession }
 *   DELETE /v1/sessions/:id                 -> { ok: true }
 *   POST   /v1/sessions/:id/messages        SendMessageRequest -> text/event-stream of AiEvent until session.idle
 *   GET    /v1/sessions/:id/events          -> text/event-stream (live subscribe / reconnect; honours Last-Event-ID)
 *   POST   /v1/sessions/:id/abort           -> { ok: boolean }
 *   POST   /v1/permissions/:id/respond      PermissionRespondRequest -> { ok: true }
 *   POST   /v1/questions/:id/respond        QuestionRespondRequest -> { ok: true }
 *   GET    /v1/models?provider=openrouter&free_tools=1 -> { models: ModelInfo[] }
 *   GET    /v1/settings                     -> SettingsResponse
 *   PUT    /v1/settings                     Partial<Settings> -> SettingsResponse
 *   PUT    /v1/secrets                      Partial<Secrets> ("" clears) -> SettingsResponse   (stored in the 0600 auth file)
 *   POST   /v1/settings/test-connection     { provider?: ProviderId } -> TestConnectionResponse
 *
 * SSE framing: `id: <seq>\nevent: <type>\ndata: <AiEvent JSON>\n\n`; `: ping` comments every 15s.
 * Errors: JSON `{ error: { code: string, message: string } }` with a 4xx/5xx status.
 */
import type { AiEvent, PermissionDecision } from "./events.js";
import type { ModelInfo, ProviderId, Settings } from "./types.js";

export interface HealthResponse {
  ok: boolean;
  version: string;
  opencode: { running: boolean; version?: string; workspaces: number };
}

export interface CreateSessionRequest {
  title?: string;
  /** Absolute workspace directory; defaults to $SECRETS_AI_WORKSPACE or the bridge's cwd. */
  workspace?: string;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface BridgeSession {
  /** OpenCode session id ("ses_..."). */
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "busy" | "retry";
  usage: SessionUsage;
}

export interface SendMessageRequest {
  text: string;
  /** One-off overrides for this turn. */
  model?: string;
  provider?: ProviderId;
  effort?: Settings["effort"];
  system?: string;
}

export interface PermissionRespondRequest {
  decision: PermissionDecision;
}

export interface QuestionRespondRequest {
  /** One array of selected option labels (or free text) per question. Omit with reject:true to dismiss. */
  answers?: string[][];
  reject?: boolean;
}

export interface SettingsResponse {
  settings: Settings;
  /** Which secrets are configured (never the values). */
  secrets: { openrouter: boolean; google: boolean; github: boolean; secrets: boolean };
}

export interface TestConnectionResponse {
  ok: boolean;
  provider: ProviderId;
  message: string;
  models?: number;
}

export interface ApiError {
  error: { code: string; message: string };
}

export type { AiEvent, ModelInfo };

/** In-process start used by `secrets-ai serve` and src/index.ts. Implemented in src/bridge/server.ts as `startBridge`. */
export interface StartBridgeOptions {
  host?: string; // default $HOST or 127.0.0.1
  port?: number; // default $PORT or 8790; 0 = random
  workspace?: string; // default $SECRETS_AI_WORKSPACE or process.cwd()
  env?: NodeJS.ProcessEnv;
  /** Path/command of the opencode binary; default $OPENCODE_BIN or "opencode". */
  opencodeBin?: string;
  quiet?: boolean;
}

export interface BridgeHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}
