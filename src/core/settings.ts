import { DEFAULT_SETTINGS, type Settings } from "./types.js";
import { paths } from "./paths.js";
import { readJsonFile, writePrivateJson } from "./secure-file.js";

const MODES = new Set(["build", "plan"]);
const LEVELS = new Set(["low", "medium", "high", "custom"]);

export class SettingsError extends Error {}

/** Validate a partial settings patch; throws SettingsError with a user-facing message. */
export function validateSettingsPatch(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SettingsError("settings must be an object");
  const p = patch as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if ("provider" in p) {
    if (typeof p.provider !== "string" || !/^[a-z0-9-]{2,40}$/.test(p.provider)) throw new SettingsError("provider must be a provider id like 'openrouter' or 'google'");
    out.provider = p.provider;
  }
  if ("model" in p) {
    if (typeof p.model !== "string" || !p.model || p.model.length > 200) throw new SettingsError("model must be a non-empty string");
    out.model = p.model;
  }
  if ("effort" in p) {
    const e = p.effort as Record<string, unknown> | string;
    const eff = typeof e === "string" ? { level: e } : e;
    if (!eff || typeof eff !== "object" || !LEVELS.has(String(eff.level))) throw new SettingsError("effort.level must be low|medium|high|custom");
    const level = eff.level as Settings["effort"]["level"];
    const res: Settings["effort"] = { level };
    if (level === "custom") {
      const ms = Number(eff.maxSteps);
      if (!Number.isInteger(ms) || ms < 1 || ms > 200) throw new SettingsError("effort.maxSteps must be an integer 1..200 for custom effort");
      res.maxSteps = ms;
      if (eff.variant !== undefined) {
        if (typeof eff.variant !== "string" || eff.variant.length > 40) throw new SettingsError("effort.variant must be a string");
        res.variant = eff.variant;
      }
    }
    out.effort = res;
  }
  if ("agentMode" in p) {
    if (!MODES.has(String(p.agentMode))) throw new SettingsError("agentMode must be build|plan");
    out.agentMode = p.agentMode as Settings["agentMode"];
  }
  if ("tools" in p) {
    const t = p.tools as Record<string, unknown>;
    if (!t || typeof t !== "object") throw new SettingsError("tools must be an object");
    out.tools = { github: Boolean(t.github), secrets: Boolean(t.secrets) };
  }
  if ("systemPrompt" in p) {
    if (p.systemPrompt !== null && typeof p.systemPrompt !== "string") throw new SettingsError("systemPrompt must be a string");
    if (typeof p.systemPrompt === "string" && p.systemPrompt.length > 20000) throw new SettingsError("systemPrompt too long (max 20000 chars)");
    out.systemPrompt = (p.systemPrompt as string | null) || undefined;
  }
  if ("secretsApiUrl" in p) {
    if (p.secretsApiUrl !== null && (typeof p.secretsApiUrl !== "string" || !/^https?:\/\//.test(p.secretsApiUrl))) throw new SettingsError("secretsApiUrl must be an http(s) URL");
    out.secretsApiUrl = (p.secretsApiUrl as string | null) || undefined;
  }
  return out;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const stored = readJsonFile<Partial<Settings>>(paths.settingsFile(env), {});
  let patch: Partial<Settings> = {};
  try {
    patch = validateSettingsPatch(stored);
  } catch {
    patch = {};
  }
  const s: Settings = { ...DEFAULT_SETTINGS, ...patch, tools: { ...DEFAULT_SETTINGS.tools, ...(patch.tools ?? {}) } };
  if (env.SECRETS_API_URL && !s.secretsApiUrl) s.secretsApiUrl = env.SECRETS_API_URL;
  return s;
}

export function saveSettings(s: Settings, env: NodeJS.ProcessEnv = process.env): void {
  writePrivateJson(paths.settingsFile(env), s);
}

export function mergeSettings(cur: Settings, patch: Partial<Settings>): Settings {
  return { ...cur, ...patch, tools: { ...cur.tools, ...(patch.tools ?? {}) }, effort: patch.effort ?? cur.effort };
}
