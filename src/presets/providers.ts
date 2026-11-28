import type { ProviderPreset } from "../core/presets-contract.js";
import type { Settings } from "../core/types.js";

export const APP_REFERER = "https://github.com/titan717/secrets";
export const APP_TITLE = "Secrets";

export const PROVIDER_PRESETS: Record<"openrouter" | "google", ProviderPreset> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    secretKey: "openrouterApiKey",
    defaultModel: "openrouter/free",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    secretKey: "geminiApiKey",
    defaultModel: "gemini-2.5-flash",
  },
};

/** Extra env names OpenCode also accepts for Google (verified in /config/providers `env`). */
export const GOOGLE_ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;

/** Cheap model for titles/summaries per provider. */
export const SMALL_MODELS: Record<string, string> = {
  openrouter: "openrouter/free",
  google: "gemini-2.5-flash-lite",
};

/** "openrouter" + "openai/gpt-5-mini" -> { providerID: "openrouter", modelID: "openai/gpt-5-mini" } */
export function modelRef(settings: Pick<Settings, "provider" | "model">): { providerID: string; modelID: string } {
  const providerID = String(settings.provider || "openrouter");
  let modelID = String(settings.model || "").trim();
  // Accept an accidental "google/gemini-2.5-flash" for google. OpenRouter ids legitimately contain
  // a vendor prefix ("openai/gpt-5-mini") so only strip for providers whose ids never include "/".
  if (providerID === "google" && modelID.startsWith("google/")) modelID = modelID.slice("google/".length);
  if (providerID === "google" && modelID.startsWith("models/")) modelID = modelID.slice("models/".length);
  if (!modelID) modelID = PROVIDER_PRESETS[providerID as "openrouter" | "google"]?.defaultModel ?? "";
  return { providerID, modelID };
}
