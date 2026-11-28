/**
 * Contract for src/presets (BUILDER-2 implements in src/presets/index.ts; BUILDER-1's supervisor
 * and bridge import ONLY these names from "../presets/index.js").
 */
import type { BuildOpenCodeConfig, BuildProviderEnv, Effort, ModelInfo, ProviderId, ResolvedEffort, Secrets, Settings } from "./types.js";

export interface ProviderPreset {
  id: "openrouter" | "google";
  label: string;
  /** Env var OpenCode reads for this provider's key. */
  envKey: string;
  /** Field in Secrets holding the key. */
  secretKey: keyof Secrets;
  defaultModel: string;
}

export interface ListModelsOptions {
  provider: ProviderId;
  secrets: Secrets;
  /** Only free models that support tool calling. */
  freeToolsOnly?: boolean;
  /** Payload of OpenCode `GET /config/providers` when available, used to attach `variants`. */
  opencodeProviders?: unknown;
  fetchImpl?: typeof fetch;
  /** Override base URLs in tests. */
  baseUrls?: { openrouter?: string; google?: string };
}

export interface PresetsModule {
  PROVIDER_PRESETS: Record<"openrouter" | "google", ProviderPreset>;
  buildOpenCodeConfig: BuildOpenCodeConfig;
  buildProviderEnv: BuildProviderEnv;
  /** Low=3, Medium=8, High=20, Custom=effort.maxSteps; variant = nearest one the model supports. */
  resolveEffort(effort: Effort, model?: Pick<ModelInfo, "variants" | "reasoning">): ResolvedEffort;
  listModels(opts: ListModelsOptions): Promise<ModelInfo[]>;
  testConnection(
    provider: ProviderId,
    secrets: Secrets,
    opts?: { fetchImpl?: typeof fetch; baseUrls?: ListModelsOptions["baseUrls"] },
  ): Promise<{ ok: boolean; message: string; models?: number }>;
  /** "openrouter" + "openai/gpt-5-mini" -> { providerID: "openrouter", modelID: "openai/gpt-5-mini" } */
  modelRef(settings: Pick<Settings, "provider" | "model">): { providerID: string; modelID: string };
}
