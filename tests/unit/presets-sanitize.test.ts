import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeOpenCodeProviders } from "../../src/presets/index.js";

describe("sanitizeOpenCodeProviders", () => {
  it("strips key/apiKey/token-like fields at any depth and redacts strings", () => {
    const raw = {
      providers: [
        { id: "openrouter", source: "env", env: ["OPENROUTER_API_KEY"], key: "plain-key-value-123", options: { apiKey: "x-123456", headers: { Authorization: "Bearer abcdefghijkl", "X-Title": "Secrets" } }, models: { a: { id: "a", variants: { low: {} } } } },
        { id: "github-copilot", key: "ghp_" + "a".repeat(36), nested: [{ token: "t-123456", access_token: "u", refresh_token: "r", password: "p", ok: "note sk-or-v1-" + "b".repeat(40) }] },
      ],
      default: { openrouter: "openrouter/free" },
    };
    const out = sanitizeOpenCodeProviders(raw) as any;
    const s = JSON.stringify(out);
    for (const bad of ["plain-key-value-123", "x-123456", "abcdefghijkl", "ghp_", "t-123456", "sk-or-v1-b"]) expect(s).not.toContain(bad);
    expect(out.providers[0].env).toEqual(["OPENROUTER_API_KEY"]);
    expect(out.providers[0].options.headers).toEqual({ "X-Title": "Secrets" });
    expect(out.providers[0].models.a.variants).toEqual({ low: {} });
    expect(out.providers[1].nested[0]).toEqual({ ok: "note [REDACTED]" });
    expect(out.default).toEqual(raw.default);
    expect(raw.providers[0]!.key).toBe("plain-key-value-123"); // input untouched
  });
  it("passes primitives and null through", () => {
    expect(sanitizeOpenCodeProviders(null)).toBeNull();
    expect(sanitizeOpenCodeProviders(3)).toBe(3);
  });
  it("recorded fixtures contain no key fields", () => {
    for (const p of ["openrouter", "google"]) {
      const j = JSON.parse(readFileSync(new URL(`../fixtures/${p}/opencode-providers.json`, import.meta.url), "utf8"));
      expect(sanitizeOpenCodeProviders(j)).toEqual(j);
    }
  });
});
