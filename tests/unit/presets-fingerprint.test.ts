import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Effort } from "../../src/core/types.js";
import { buildOpenCodeConfig, githubTokenFingerprint, mcpCredentialFingerprint, secretsTokenFingerprint, stepsFor } from "../../src/presets/index.js";

const T1 = "sai_" + "a".repeat(40);
const T2 = "sai_" + "b".repeat(40);

describe("secretsTokenFingerprint", () => {
  it("is stable, 16 hex, changes with the token, undefined when absent", () => {
    const a = secretsTokenFingerprint({ secretsToken: T1 });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(secretsTokenFingerprint({ secretsToken: T1 })).toBe(a);
    expect(secretsTokenFingerprint({ secretsToken: T2 })).not.toBe(a);
    expect(secretsTokenFingerprint({})).toBeUndefined();
    expect(secretsTokenFingerprint(undefined)).toBeUndefined();
    expect(secretsTokenFingerprint({ secretsToken: "" })).toBeUndefined();
  });
  it("never contains the token and is domain-separated from github", () => {
    const f = secretsTokenFingerprint({ secretsToken: T1 })!;
    expect(T1).not.toContain(f);
    expect(githubTokenFingerprint({ githubToken: T1 })).not.toBe(f);
  });
  it("mcpCredentialFingerprint changes only when an MCP credential changes", () => {
    const base = mcpCredentialFingerprint({ secretsToken: T1, githubToken: "ghp_x" });
    expect(mcpCredentialFingerprint({ secretsToken: T1, githubToken: "ghp_x", openrouterApiKey: "k" })).toBe(base);
    expect(mcpCredentialFingerprint({ secretsToken: T2, githubToken: "ghp_x" })).not.toBe(base);
    expect(mcpCredentialFingerprint({ secretsToken: T1 })).not.toBe(base);
    expect(mcpCredentialFingerprint({})).toBe(mcpCredentialFingerprint(undefined));
  });
});

describe("stepsFor", () => {
  it("maps effort levels", () => {
    expect(stepsFor({ effort: { level: "low" } })).toBe(3);
    expect(stepsFor({ effort: { level: "medium" } })).toBe(8);
    expect(stepsFor({ effort: { level: "high" } })).toBe(20);
    expect(stepsFor({ effort: { level: "custom", maxSteps: 42 } })).toBe(42);
    expect(stepsFor({ effort: { level: "custom", maxSteps: 999 } })).toBe(200);
    expect(stepsFor({ effort: { level: "custom" } })).toBe(8);
    expect(stepsFor(undefined)).toBe(8);
  });
  it("accepts a bare Effort and a per-request override", () => {
    expect(stepsFor({ level: "high" })).toBe(20);
    expect(stepsFor({ effort: { level: "low" } }, { level: "high" })).toBe(20);
  });
  it("matches agent steps in the generated opencode.json", () => {
    for (const effort of [{ level: "low" }, { level: "high" }, { level: "custom", maxSteps: 13 }] as Effort[]) {
      const settings = { ...DEFAULT_SETTINGS, effort };
      const cfg = buildOpenCodeConfig({ settings, available: { openrouter: true, google: false, github: false, secrets: false }, secretsMcpEntry: "/x.js", nodePath: "node" }) as any;
      expect(cfg.agent.build.steps).toBe(stepsFor(settings));
      expect(cfg.agent.plan.steps).toBe(stepsFor(settings));
    }
  });
});
