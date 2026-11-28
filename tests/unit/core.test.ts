import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureToken, loadSecrets, saveSecret, verifyBearer, readAuthFile } from "../../src/core/auth.js";
import { redact, registerSecret } from "../../src/core/redact.js";
import { loadSettings, saveSettings, validateSettingsPatch, mergeSettings, SettingsError } from "../../src/core/settings.js";
import { sseFrame, toOpenCodeReply } from "../../src/core/events.js";
import { paths } from "../../src/core/paths.js";

const envFor = () => ({ SECRETS_AI_HOME: mkdtempSync(join(tmpdir(), "sai-core-")) }) as NodeJS.ProcessEnv;

describe("auth", () => {
  it("creates a token once, stores it 0600 and reuses it", () => {
    const env = envFor();
    const a = ensureToken(env);
    expect(a.created).toBe(true);
    expect(a.token).toMatch(/^sai_/);
    const b = ensureToken(env);
    expect(b).toEqual({ token: a.token, created: false });
    if (process.platform !== "win32") expect(statSync(paths.authFile(env)).mode & 0o777).toBe(0o600);
  });

  it("prefers SECRETS_AI_TOKEN from env", () => {
    const env = { ...envFor(), SECRETS_AI_TOKEN: "envtoken" };
    expect(ensureToken(env).token).toBe("envtoken");
  });

  it("verifies bearer tokens in constant time and rejects bad ones", () => {
    expect(verifyBearer("Bearer abc", "abc")).toBe(true);
    expect(verifyBearer("bearer  abc ", "abc")).toBe(true);
    expect(verifyBearer("Bearer abd", "abc")).toBe(false);
    expect(verifyBearer("Bearer ab", "abc")).toBe(false);
    expect(verifyBearer(undefined, "abc")).toBe(false);
    expect(verifyBearer("Basic abc", "abc")).toBe(false);
  });

  it("saves secrets to the auth file and env overrides file", () => {
    const env = envFor();
    saveSecret("openrouterApiKey", "sk-or-v1-filekey", env);
    expect(loadSecrets(env).openrouterApiKey).toBe("sk-or-v1-filekey");
    expect(loadSecrets({ ...env, OPENROUTER_API_KEY: "sk-or-v1-envkey" }).openrouterApiKey).toBe("sk-or-v1-envkey");
    saveSecret("openrouterApiKey", "", env);
    expect(readAuthFile(env)?.secrets.openrouterApiKey).toBeUndefined();
    // token survives secret updates
    expect(readAuthFile(env)?.token).toMatch(/^sai_/);
  });
});

describe("redact", () => {
  it("scrubs known key formats", () => {
    const s = redact("key sk-or-v1-abcdef0123456789abcdef and AIzaSyA1234567890abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz0123 Bearer sai_abcdefghijklmnopqrstuvwxyz");
    expect(s).not.toMatch(/sk-or-v1-abc|AIzaSy|ghp_abc|sai_abc/);
  });
  it("scrubs key=value and json fields", () => {
    expect(redact('{"apiKey":"hunter2hunter2"}')).not.toContain("hunter2");
    expect(redact("password=supersecret")).not.toContain("supersecret");
  });
  it("scrubs registered runtime secrets", () => {
    registerSecret("weird-custom-secret-value");
    expect(redact("x weird-custom-secret-value y")).toBe("x [REDACTED] y");
  });
});

describe("settings", () => {
  it("validates patches", () => {
    expect(validateSettingsPatch({ effort: "high" })).toEqual({ effort: { level: "high" } });
    expect(validateSettingsPatch({ effort: { level: "custom", maxSteps: 12, variant: "max" } })).toEqual({ effort: { level: "custom", maxSteps: 12, variant: "max" } });
    expect(() => validateSettingsPatch({ effort: { level: "custom" } })).toThrow(SettingsError);
    expect(() => validateSettingsPatch({ agentMode: "yolo" })).toThrow(SettingsError);
    expect(() => validateSettingsPatch({ provider: "Bad Provider!" })).toThrow(SettingsError);
    expect(() => validateSettingsPatch([])).toThrow(SettingsError);
  });
  it("accepts partial tool toggles without resetting the others", () => {
    const cur = mergeSettings(loadSettings(envFor()), { tools: { github: true, secrets: true } });
    const next = mergeSettings(cur, validateSettingsPatch({ tools: { secrets: false } }));
    expect(next.tools).toEqual({ github: true, secrets: false });
    expect(() => validateSettingsPatch({ tools: { github: "yes" } })).toThrow(SettingsError);
  });
  it("persists and merges", () => {
    const env = envFor();
    const s = mergeSettings(loadSettings(env), { model: "openai/gpt-5-mini", tools: { github: true, secrets: false } });
    saveSettings(s, env);
    const back = loadSettings(env);
    expect(back.model).toBe("openai/gpt-5-mini");
    expect(back.tools.github).toBe(true);
    expect(JSON.parse(readFileSync(paths.settingsFile(env), "utf8")).provider).toBe("openrouter");
  });
});

describe("events", () => {
  it("maps decisions to OpenCode replies", () => {
    expect(toOpenCodeReply("allow")).toBe("once");
    expect(toOpenCodeReply("allow_session")).toBe("always");
    expect(toOpenCodeReply("deny")).toBe("reject");
  });
  it("frames SSE", () => {
    expect(sseFrame({ type: "session.idle", sessionId: "s" })).toBe('event: session.idle\ndata: {"type":"session.idle","sessionId":"s"}\n\n');
  });
});
