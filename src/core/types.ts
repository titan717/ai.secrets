/**
 * Shared domain types and module contracts. Owned by AMIT: builders import from here and
 * request changes instead of editing it, so parallel work never collides.
 */

export type ProviderId = "openrouter" | "google" | (string & {});
export type EffortLevel = "low" | "medium" | "high" | "custom";

export interface Effort {
  level: EffortLevel;
  /** Only for level "custom": max agent steps (1..200). */
  maxSteps?: number;
  /** Only for level "custom": preferred reasoning variant name, e.g. "minimal" | "xhigh" | "max". */
  variant?: string;
}

export interface ToolToggles {
  github: boolean;
  secrets: boolean;
}

/** User-editable settings (PUT /v1/settings). Never contains secrets. */
export interface Settings {
  provider: ProviderId;
  /** Model id without provider prefix, e.g. "openai/gpt-5-mini" for openrouter, "gemini-2.5-flash" for google. */
  model: string;
  effort: Effort;
  /** OpenCode primary agent: "build" (can edit/run) or "plan" (read-only). */
  agentMode: "build" | "plan";
  tools: ToolToggles;
  systemPrompt?: string;
  /** Secrets API base URL for secrets-mcp. */
  secretsApiUrl?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",
  model: "openrouter/free",
  effort: { level: "medium" },
  agentMode: "build",
  tools: { github: false, secrets: false },
};

/** Secrets are kept apart from Settings and only ever live in env, the 0600 file, or a request header. */
export interface Secrets {
  openrouterApiKey?: string;
  geminiApiKey?: string;
  githubToken?: string;
  secretsToken?: string;
}

/** Result of mapping an Effort onto a concrete model. */
export interface ResolvedEffort {
  /** OpenCode model variant to send with each prompt, or undefined when the model has none. */
  variant?: string;
  /** Value for opencode.json `agent.<mode>.steps`. */
  steps: number;
}

/** Minimal model description used by effort mapping and GET /v1/models. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  toolCall: boolean;
  reasoning: boolean;
  free: boolean;
  contextLength?: number;
  /** Variant names OpenCode knows for this model (from GET /config/providers). */
  variants?: string[];
  pricing?: { inputPerMTok?: number; outputPerMTok?: number };
}

/** Inputs for generating a workspace opencode.json. */
export interface OpenCodeConfigInput {
  settings: Settings;
  /** Which secrets are available (values are injected via env, never written to disk). */
  available: { openrouter: boolean; google: boolean; github: boolean; secrets: boolean };
  /** Absolute path of the built secrets-mcp entry (dist/mcp/secrets-mcp.js). */
  secretsMcpEntry: string;
  /** Absolute path of node binary used to run local MCP servers. */
  nodePath: string;
}

/**
 * Contract: presets (BUILDER-2) produce the opencode.json object; the supervisor (BUILDER-1)
 * writes it and restarts OpenCode when it changes.
 */
export type BuildOpenCodeConfig = (input: OpenCodeConfigInput) => Record<string, unknown>;

/** Contract: env vars to pass to the `opencode serve` child for the given secrets. */
export type BuildProviderEnv = (secrets: Secrets) => Record<string, string>;
