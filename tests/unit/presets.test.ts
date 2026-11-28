import { describe, expect, it } from "vitest";
import presets, { PROVIDER_PRESETS, buildProviderEnv, modelRef } from "../../src/presets/index.js";

describe("PROVIDER_PRESETS", () => {
  it("has openrouter and google with the verified env vars", () => {
    expect(PROVIDER_PRESETS.openrouter).toMatchObject({ id: "openrouter", envKey: "OPENROUTER_API_KEY", secretKey: "openrouterApiKey", defaultModel: "openrouter/free" });
    expect(PROVIDER_PRESETS.google).toMatchObject({ id: "google", envKey: "GEMINI_API_KEY", secretKey: "geminiApiKey", defaultModel: "gemini-2.5-flash" });
  });
  it("default export implements the module contract", () => {
    for (const k of ["PROVIDER_PRESETS", "buildOpenCodeConfig", "buildProviderEnv", "resolveEffort", "listModels", "testConnection", "modelRef"]) {
      expect(presets).toHaveProperty(k);
    }
  });
});

describe("buildProviderEnv", () => {
  it("empty secrets -> empty env", () => {
    expect(buildProviderEnv({})).toEqual({});
  });
  it("maps every secret to only the vars OpenCode/MCP need", () => {
    expect(buildProviderEnv({ openrouterApiKey: "or-1", geminiApiKey: "gm-1", githubToken: "gh-1", secretsToken: "st-1" })).toEqual({
      OPENROUTER_API_KEY: "or-1",
      GEMINI_API_KEY: "gm-1",
      GOOGLE_GENERATIVE_AI_API_KEY: "gm-1",
      SECRETS_AI_GITHUB_TOKEN: "gh-1",
      SECRETS_AI_SECRETS_TOKEN: "st-1",
    });
  });
});

describe("modelRef", () => {
  it("keeps vendor prefix for openrouter", () => {
    expect(modelRef({ provider: "openrouter", model: "openai/gpt-5-mini" })).toEqual({ providerID: "openrouter", modelID: "openai/gpt-5-mini" });
    expect(modelRef({ provider: "openrouter", model: "openrouter/free" })).toEqual({ providerID: "openrouter", modelID: "openrouter/free" });
  });
  it("strips google/ and models/ prefixes for google", () => {
    expect(modelRef({ provider: "google", model: "google/gemini-2.5-flash" }).modelID).toBe("gemini-2.5-flash");
    expect(modelRef({ provider: "google", model: "models/gemini-2.5-pro" }).modelID).toBe("gemini-2.5-pro");
  });
  it("falls back to the preset default", () => {
    expect(modelRef({ provider: "google", model: "" }).modelID).toBe("gemini-2.5-flash");
  });
});

describe("buildProviderEnv never exposes generic GitHub names", () => {
  it("does not set GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN / SECRETS_TOKEN", () => {
    const env = buildProviderEnv({ githubToken: "gh-1", secretsToken: "st-1" });
    expect(env).toEqual({ SECRETS_AI_GITHUB_TOKEN: "gh-1", SECRETS_AI_SECRETS_TOKEN: "st-1" });
  });
});
