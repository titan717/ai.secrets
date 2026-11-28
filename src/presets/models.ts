/**
 * Model listing and connection tests for the provider presets.
 *
 * OpenRouter (verified against the live API 2026-11-28):
 *   GET https://openrouter.ai/api/v1/models  (public; `?supported_parameters=tools` filters server-side)
 *   -> { data: Model[], total_count, links: { next } }. pricing.prompt/completion are USD-per-token
 *   STRINGS; "-1" marks dynamic routers (openrouter/auto). Key check: GET /api/v1/key (Bearer) ->
 *   401 {"error":{"message":"User not found.","code":401}} for a bad key.
 * Gemini: GET https://generativelanguage.googleapis.com/v1beta/models (header x-goog-api-key,
 *   pageSize<=1000, nextPageToken). A bad key -> 400 INVALID_ARGUMENT reason API_KEY_INVALID.
 */
import type { ListModelsOptions } from "../core/presets-contract.js";
import type { ModelInfo, ProviderId, Secrets } from "../core/types.js";
import { redact, registerSecret } from "../core/redact.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15000;

export class ModelsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number | null;
  pricing?: { prompt?: string | number; completion?: string | number };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
}

interface GeminiModel {
  name: string;
  baseModelId?: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

type Cached = { at: number; models: ModelInfo[] };
const cache = new Map<string, Cached>();

/** Clear the 5-minute model cache (tests, or after a key change). */
export function clearModelCache(): void {
  cache.clear();
}

function cacheKey(provider: string, base: string, secret: string | undefined): string {
  // Never keep the key itself as a map key; a short non-reversible fingerprint is enough.
  let h = 0;
  for (const c of secret ?? "") h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return `${provider}|${base}|${secret ? h.toString(36) : "anon"}`;
}

const perMTok = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
};

/** Extract `{modelID: variantNames[]}` (and toolcall/reasoning) for one provider from OpenCode `/config/providers`. */
export function opencodeModelMeta(payload: unknown, providerID: string): Map<string, { variants: string[]; toolcall?: boolean; reasoning?: boolean }> {
  const out = new Map<string, { variants: string[]; toolcall?: boolean; reasoning?: boolean }>();
  const providers = (payload as { providers?: unknown })?.providers;
  if (!Array.isArray(providers)) return out;
  const p = providers.find((x) => (x as { id?: string })?.id === providerID) as { models?: Record<string, any> } | undefined;
  for (const [id, m] of Object.entries(p?.models ?? {})) {
    out.set(id, {
      variants: m?.variants && typeof m.variants === "object" ? Object.keys(m.variants) : [],
      toolcall: typeof m?.capabilities?.toolcall === "boolean" ? m.capabilities.toolcall : undefined,
      reasoning: typeof m?.capabilities?.reasoning === "boolean" ? m.capabilities.reasoning : undefined,
    });
  }
  return out;
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: ctrl.signal });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? "request timed out" : (e as Error)?.message || String(e);
    throw new ModelsError(redact(`Network error: ${msg}`));
  } finally {
    clearTimeout(t);
  }
}

function httpError(provider: string, status: number, body: any): ModelsError {
  const reason = JSON.stringify(body?.error?.details ?? "");
  if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID/.test(reason))) return new ModelsError("Invalid API key", status);
  if (status === 402) return new ModelsError("Insufficient credits", status);
  if (status === 429) return new ModelsError("Rate limited by provider, try again shortly", status);
  const m = typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : `HTTP ${status}`;
  return new ModelsError(redact(`${provider} error: ${m}`), status);
}

function mapOpenRouter(m: OpenRouterModel, meta: ReturnType<typeof opencodeModelMeta>): ModelInfo {
  const params = m.supported_parameters ?? [];
  const inp = perMTok(m.pricing?.prompt);
  const outp = perMTok(m.pricing?.completion);
  const free = m.id.endsWith(":free") || (inp === 0 && outp === 0);
  const info: ModelInfo = {
    id: m.id,
    name: m.name || m.id,
    provider: "openrouter",
    toolCall: params.includes("tools"),
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    free,
  };
  if (typeof m.context_length === "number") info.contextLength = m.context_length;
  // "-1" is OpenRouter's sentinel for dynamic (router) pricing; don't report it as a price.
  const pricing: NonNullable<ModelInfo["pricing"]> = {};
  if (inp !== undefined && inp >= 0) pricing.inputPerMTok = inp;
  if (outp !== undefined && outp >= 0) pricing.outputPerMTok = outp;
  if (Object.keys(pricing).length) info.pricing = pricing;
  const v = meta.get(m.id);
  if (v && v.variants.length) info.variants = v.variants;
  return info;
}

const GOOGLE_NON_CHAT = /(embedding|tts|imagen|veo|lyria|aqa|live|native-audio|-image)/i;

function mapGemini(m: GeminiModel, meta: ReturnType<typeof opencodeModelMeta>): ModelInfo {
  const id = m.name.replace(/^models\//, "");
  const oc = meta.get(id);
  const info: ModelInfo = {
    id,
    name: m.displayName || id,
    provider: "google",
    // Gemini's list API does not report tool support; prefer OpenCode's catalog, else exclude non-chat families.
    toolCall: oc?.toolcall ?? !GOOGLE_NON_CHAT.test(id),
    reasoning: oc?.reasoning ?? Boolean(m.thinking),
    free: false, // free tier is a quota, not a per-model price
  };
  if (typeof m.inputTokenLimit === "number") info.contextLength = m.inputTokenLimit;
  if (oc && oc.variants.length) info.variants = oc.variants;
  return info;
}

async function fetchOpenRouter(fetchImpl: typeof fetch, base: string, key?: string): Promise<OpenRouterModel[]> {
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const { status, body } = await getJson(fetchImpl, `${base}/models`, headers);
  if (status !== 200) throw httpError("OpenRouter", status, body);
  if (!Array.isArray(body?.data)) throw new ModelsError("OpenRouter returned an unexpected models payload");
  return body.data as OpenRouterModel[];
}

async function fetchGemini(fetchImpl: typeof fetch, base: string, key: string): Promise<GeminiModel[]> {
  const all: GeminiModel[] = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const url = `${base}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const { status, body } = await getJson(fetchImpl, url, { "x-goog-api-key": key });
    if (status !== 200) throw httpError("Gemini", status, body);
    if (!Array.isArray(body?.models)) throw new ModelsError("Gemini returned an unexpected models payload");
    all.push(...(body.models as GeminiModel[]));
    token = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
    if (!token) break;
  }
  return all;
}

export async function listModels(opts: ListModelsOptions, internal: { noCache?: boolean } = {}): Promise<ModelInfo[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const provider = opts.provider;
  let models: ModelInfo[];
  if (provider === "openrouter") {
    const base = (opts.baseUrls?.openrouter ?? OPENROUTER_BASE).replace(/\/$/, "");
    const key = opts.secrets.openrouterApiKey;
    registerSecret(key);
    const ck = cacheKey("openrouter", base, key);
    const hit = cache.get(ck);
    let raw: ModelInfo[];
    if (hit && !internal.noCache && Date.now() - hit.at < CACHE_TTL_MS) raw = hit.models;
    else {
      raw = (await fetchOpenRouter(fetchImpl, base, key)).map((m) => mapOpenRouter(m, new Map()));
      cache.set(ck, { at: Date.now(), models: raw });
    }
    const meta = opencodeModelMeta(opts.opencodeProviders, "openrouter");
    models = raw.map((m) => {
      const v = meta.get(m.id)?.variants;
      return v && v.length ? { ...m, variants: v } : { ...m };
    });
  } else if (provider === "google") {
    const key = opts.secrets.geminiApiKey;
    if (!key) throw new ModelsError("Gemini API key is not set");
    registerSecret(key);
    const base = (opts.baseUrls?.google ?? GOOGLE_BASE).replace(/\/$/, "");
    const ck = cacheKey("google", base, key);
    const hit = cache.get(ck);
    let raw: GeminiModel[];
    if (hit && !internal.noCache && Date.now() - hit.at < CACHE_TTL_MS) raw = hit.models as unknown as GeminiModel[];
    else {
      raw = (await fetchGemini(fetchImpl, base, key)).filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"));
      cache.set(ck, { at: Date.now(), models: raw as unknown as ModelInfo[] });
    }
    const meta = opencodeModelMeta(opts.opencodeProviders, "google");
    models = raw.map((m) => mapGemini(m, meta));
  } else {
    throw new ModelsError(`Unknown provider: ${String(provider).slice(0, 40)}`);
  }
  if (opts.freeToolsOnly) models = models.filter((m) => m.free && m.toolCall);
  return models;
}

export async function testConnection(
  provider: ProviderId,
  secrets: Secrets,
  opts: { fetchImpl?: typeof fetch; baseUrls?: ListModelsOptions["baseUrls"] } = {},
): Promise<{ ok: boolean; message: string; models?: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    if (provider === "openrouter") {
      const key = secrets.openrouterApiKey;
      if (!key) return { ok: false, message: "OpenRouter API key is not set" };
      registerSecret(key);
      const base = (opts.baseUrls?.openrouter ?? OPENROUTER_BASE).replace(/\/$/, "");
      const { status, body } = await getJson(fetchImpl, `${base}/key`, { authorization: `Bearer ${key}` });
      if (status !== 200) throw httpError("OpenRouter", status, body);
      const d = body?.data ?? {};
      const parts = ["OpenRouter key is valid"];
      if (d.is_free_tier) parts.push("free tier");
      if (typeof d.limit_remaining === "number") parts.push(`$${d.limit_remaining.toFixed(2)} remaining`);
      const fr = d.free_model_daily_requests;
      if (fr && typeof fr.remaining === "number" && typeof fr.limit === "number") parts.push(`${fr.remaining}/${fr.limit} free requests left today`);
      let count: number | undefined;
      try {
        count = (await listModels({ provider, secrets, fetchImpl, baseUrls: opts.baseUrls })).length;
      } catch {
        count = undefined;
      }
      return { ok: true, message: redact(parts.join(", ")), ...(count !== undefined ? { models: count } : {}) };
    }
    if (provider === "google") {
      if (!secrets.geminiApiKey) return { ok: false, message: "Gemini API key is not set" };
      const models = await listModels({ provider, secrets, fetchImpl, baseUrls: opts.baseUrls }, { noCache: true });
      return { ok: true, message: `Gemini key is valid, ${models.length} models available`, models: models.length };
    }
    return { ok: false, message: `Unknown provider: ${String(provider).slice(0, 40)}` };
  } catch (e) {
    return { ok: false, message: redact(e instanceof Error ? e.message : String(e)) };
  }
}
