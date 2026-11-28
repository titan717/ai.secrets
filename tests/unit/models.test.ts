import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { listModels, testConnection } from "../../src/presets/index.js";
import { clearModelCache, opencodeModelMeta } from "../../src/presets/models.js";

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));
const OR_MODELS = fx("openrouter/models.json");
const OR_OC = fx("openrouter/opencode-providers.json");
const G_OC = fx("google/opencode-providers.json");
const OR_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const G_KEY = "AIza" + "S".repeat(35);

type Call = { url: string; headers: Record<string, string> };
function stub(routes: Record<string, (url: URL) => { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
    const r = routes[url.pathname];
    if (!r) return new Response(JSON.stringify({ error: { message: "nf" } }), { status: 404 });
    const { status, body } = r(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const baseUrls = { openrouter: "http://or.test/api/v1", google: "http://g.test/v1beta" };

beforeEach(() => clearModelCache());

describe("listModels openrouter", () => {
  it("maps the recorded catalog", async () => {
    const s = stub({ "/api/v1/models": () => ({ status: 200, body: OR_MODELS }) });
    const ms = await listModels({ provider: "openrouter", secrets: {}, fetchImpl: s.fetchImpl, baseUrls });
    expect(ms).toHaveLength(30);
    const free = ms.find((m) => m.id === "openrouter/free")!;
    expect(free).toMatchObject({ provider: "openrouter", name: "Free Models Router", free: true, toolCall: true, reasoning: true, contextLength: 200000, pricing: { inputPerMTok: 0, outputPerMTok: 0 } });
    const auto = ms.find((m) => m.id === "openrouter/auto")!;
    expect(auto.free).toBe(false);
    expect(auto.pricing).toBeUndefined(); // "-1" sentinel dropped
    const mini = ms.find((m) => m.id === "openai/gpt-5-mini")!;
    expect(mini.free).toBe(false);
    expect(mini.pricing!.inputPerMTok).toBeGreaterThan(0);
    expect(s.calls[0]!.headers.authorization).toBeUndefined(); // public endpoint, no key needed
  });
  it("freeToolsOnly = free (price 0 or :free) AND supports tools", async () => {
    const s = stub({ "/api/v1/models": () => ({ status: 200, body: OR_MODELS }) });
    const ms = await listModels({ provider: "openrouter", secrets: {}, freeToolsOnly: true, fetchImpl: s.fetchImpl, baseUrls });
    expect(ms.map((m) => m.id).sort()).toEqual(
      [
        "openrouter/free", "particle-ai/particle-1:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        "liquid/lfm-3-1.7b:free", "google/gemma-4-31b-it:free", "baidu/ernie-5.5-flash-preview:free", "recursive/flint-v1.0:free",
        "nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free", "google/gemma-4-26b-a4b-it:free",
      ].sort(),
    );
    expect(ms.every((m) => m.free && m.toolCall)).toBe(true);
  });
  it("free price-0 models without tools are excluded; :free suffix counts as free", async () => {
    const body = { data: [
      { id: "a/no-tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
      { id: "b/x:free", pricing: { prompt: "0.000001", completion: "0" }, supported_parameters: ["tools"] },
      { id: "c/paid", pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
    ] };
    const s = stub({ "/api/v1/models": () => ({ status: 200, body }) });
    const ms = await listModels({ provider: "openrouter", secrets: {}, freeToolsOnly: true, fetchImpl: s.fetchImpl, baseUrls });
    expect(ms.map((m) => m.id)).toEqual(["b/x:free"]);
  });
  it("attaches variants from the opencode /config/providers payload", async () => {
    const s = stub({ "/api/v1/models": () => ({ status: 200, body: OR_MODELS }) });
    const ms = await listModels({ provider: "openrouter", secrets: {}, opencodeProviders: OR_OC, fetchImpl: s.fetchImpl, baseUrls });
    expect(ms.find((m) => m.id === "openai/gpt-5-mini")!.variants).toEqual(["minimal", "low", "medium", "high"]);
    expect(ms.find((m) => m.id === "anthropic/claude-sonnet-4.5")!.variants).toEqual(["low", "medium", "high"]);
    expect(ms.find((m) => m.id === "particle-ai/particle-1:free")!.variants).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(ms.find((m) => m.id === "openrouter/free")!.variants).toBeUndefined();
  });
  it("caches for 5 minutes", async () => {
    const s = stub({ "/api/v1/models": () => ({ status: 200, body: OR_MODELS }) });
    await listModels({ provider: "openrouter", secrets: {}, fetchImpl: s.fetchImpl, baseUrls });
    await listModels({ provider: "openrouter", secrets: {}, fetchImpl: s.fetchImpl, baseUrls, freeToolsOnly: true });
    expect(s.calls).toHaveLength(1);
    clearModelCache();
    await listModels({ provider: "openrouter", secrets: {}, fetchImpl: s.fetchImpl, baseUrls });
    expect(s.calls).toHaveLength(2);
  });
  it("sends the key as Bearer when present and redacts it from errors", async () => {
    const s = stub({ "/api/v1/models": () => ({ status: 500, body: { error: { message: `boom ${OR_KEY}` } } }) });
    const err = await listModels({ provider: "openrouter", secrets: { openrouterApiKey: OR_KEY }, fetchImpl: s.fetchImpl, baseUrls }).catch((e) => e);
    expect(s.calls[0]!.headers.authorization).toBe(`Bearer ${OR_KEY}`);
    expect(String(err.message)).not.toContain(OR_KEY);
    expect(String(err.message)).toContain("OpenRouter error");
  });
});

describe("listModels google", () => {
  const routes = () =>
    stub({
      "/v1beta/models": (u) => ({ status: 200, body: u.searchParams.get("pageToken") === "page-2-token" ? fx("google/models-page2.json") : fx("google/models-page1.json") }),
    });
  it("pages, filters generateContent and uses x-goog-api-key", async () => {
    const s = routes();
    const ms = await listModels({ provider: "google", secrets: { geminiApiKey: G_KEY }, fetchImpl: s.fetchImpl, baseUrls });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]!.headers["x-goog-api-key"]).toBe(G_KEY);
    expect(s.calls[0]!.url).not.toContain(G_KEY);
    const ids = ms.map((m) => m.id);
    expect(ids).toContain("gemini-2.5-flash");
    expect(ids).not.toContain("gemini-embedding-001");
    expect(ids).not.toContain("imagen-4.0-generate-001");
    expect(ms.find((m) => m.id === "gemini-2.5-flash")).toMatchObject({ provider: "google", name: "Gemini 2.5 Flash", toolCall: true, reasoning: true, contextLength: 1048576, free: false });
    expect(ms.find((m) => m.id === "gemini-2.5-flash-preview-tts")!.toolCall).toBe(false);
  });
  it("attaches the real Gemini variants from opencode", async () => {
    const s = routes();
    const ms = await listModels({ provider: "google", secrets: { geminiApiKey: G_KEY }, opencodeProviders: G_OC, fetchImpl: s.fetchImpl, baseUrls });
    expect(ms.find((m) => m.id === "gemini-2.5-flash")!.variants).toEqual(["high", "max"]);
    expect(ms.find((m) => m.id === "gemini-2.5-pro")!.variants).toEqual(["high", "max"]);
    expect(ms.find((m) => m.id === "gemini-3.1-pro-preview")!.variants).toEqual(["low", "medium", "high"]);
    expect(ms.find((m) => m.id === "gemini-3-pro-image")!.toolCall).toBe(false); // from opencode capabilities
  });
  it("requires a key", async () => {
    await expect(listModels({ provider: "google", secrets: {}, baseUrls })).rejects.toThrow("Gemini API key is not set");
  });
  it("unknown provider", async () => {
    await expect(listModels({ provider: "nope", secrets: {}, baseUrls })).rejects.toThrow("Unknown provider");
  });
});

describe("opencodeModelMeta", () => {
  it("reads variants and capabilities, tolerates garbage", () => {
    expect(opencodeModelMeta(G_OC, "google").get("gemini-2.5-flash")).toEqual({ variants: ["high", "max"], toolcall: true, reasoning: true });
    expect(opencodeModelMeta(null, "google").size).toBe(0);
    expect(opencodeModelMeta({ providers: "x" }, "google").size).toBe(0);
  });
});

describe("testConnection", () => {
  it("openrouter valid key", async () => {
    const s = stub({ "/api/v1/key": () => ({ status: 200, body: fx("openrouter/key.json") }), "/api/v1/models": () => ({ status: 200, body: OR_MODELS }) });
    const r = await testConnection("openrouter", { openrouterApiKey: OR_KEY }, { fetchImpl: s.fetchImpl, baseUrls });
    expect(r.ok).toBe(true);
    expect(r.models).toBe(30);
    expect(r.message).toContain("OpenRouter key is valid");
    expect(r.message).toContain("38/50 free requests");
    expect(r.message).not.toContain("sk-or");
    expect(s.calls[0]!.url).toBe("http://or.test/api/v1/key");
    expect(s.calls[0]!.headers.authorization).toBe(`Bearer ${OR_KEY}`);
  });
  it("openrouter 401 -> Invalid API key", async () => {
    const s = stub({ "/api/v1/key": () => ({ status: 401, body: fx("openrouter/key-invalid.json") }) });
    expect(await testConnection("openrouter", { openrouterApiKey: OR_KEY }, { fetchImpl: s.fetchImpl, baseUrls })).toEqual({ ok: false, message: "Invalid API key" });
  });
  it("openrouter missing key", async () => {
    expect((await testConnection("openrouter", {})).message).toBe("OpenRouter API key is not set");
  });
  it("google valid key counts generateContent models", async () => {
    const s = stub({ "/v1beta/models": (u) => ({ status: 200, body: u.searchParams.get("pageToken") ? fx("google/models-page2.json") : fx("google/models-page1.json") }) });
    const r = await testConnection("google", { geminiApiKey: G_KEY }, { fetchImpl: s.fetchImpl, baseUrls });
    expect(r).toEqual({ ok: true, message: "Gemini key is valid, 8 models available", models: 8 });
  });
  it("google 400 API_KEY_INVALID -> Invalid API key, bypassing cache", async () => {
    const ok = stub({ "/v1beta/models": () => ({ status: 200, body: fx("google/models-page2.json") }) });
    await listModels({ provider: "google", secrets: { geminiApiKey: G_KEY }, fetchImpl: ok.fetchImpl, baseUrls });
    const bad = stub({ "/v1beta/models": () => ({ status: 400, body: fx("google/error-invalid-key.json") }) });
    expect(await testConnection("google", { geminiApiKey: G_KEY }, { fetchImpl: bad.fetchImpl, baseUrls })).toEqual({ ok: false, message: "Invalid API key" });
  });
  it("network errors are reported without the key", async () => {
    const fetchImpl = (async () => { throw new Error(`connect ECONNREFUSED with ${G_KEY}`); }) as unknown as typeof fetch;
    const r = await testConnection("google", { geminiApiKey: G_KEY }, { fetchImpl, baseUrls });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Network error/);
    expect(r.message).not.toContain(G_KEY);
  });
  it("429 and 402 messages", async () => {
    const s429 = stub({ "/api/v1/key": () => ({ status: 429, body: {} }) });
    expect((await testConnection("openrouter", { openrouterApiKey: OR_KEY }, { fetchImpl: s429.fetchImpl, baseUrls })).message).toMatch(/Rate limited/);
    const s402 = stub({ "/api/v1/key": () => ({ status: 402, body: {} }) });
    expect((await testConnection("openrouter", { openrouterApiKey: OR_KEY }, { fetchImpl: s402.fetchImpl, baseUrls })).message).toBe("Insufficient credits");
  });
});
