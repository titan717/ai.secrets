import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index.js";
import { handleMcpRequest as handleGithubMcp } from "../src/mcp/github-mcp.js";
import { handleMcpRequest as handleSecretsMcp } from "../src/mcp/secrets-mcp.js";
import { mapEffort } from "../src/presets/effort.js";
import { testProviderConnection } from "../src/presets/models.js";
import { ensureBridgeToken, readStoredSessions, redactSecrets, writeStoredSessions } from "../src/security/auth.js";

describe("Presets, Security, MCP & CLI", () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env.SECRETS_AI_CONFIG_DIR;
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("maps effort levels to steps and reasoning tiers", () => {
    expect(mapEffort({ level: "low" })).toEqual({ maxSteps: 3, reasoningEffort: "low" });
    expect(mapEffort({ level: "medium" })).toEqual({ maxSteps: 8, reasoningEffort: "medium" });
    expect(mapEffort({ level: "high" })).toEqual({ maxSteps: 20, reasoningEffort: "high" });
    expect(mapEffort({ level: "custom", maxSteps: 15, thinkingBudget: 0 })).toEqual({
      maxSteps: 15,
      reasoningEffort: "none",
      thinkingBudget: 0,
    });
  });

  it("redacts API keys and Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer sai_0123456789abcdef0123456789abcdef key=sk-or-v1-abcdef1234567890");
    expect(out).not.toContain("sai_0123456789");
    expect(out).not.toContain("sk-or-v1-abcdef");
    expect(out).toContain("[redacted]");
  });

  it("creates 0600 config file on ensureBridgeToken and CLI init", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-ai-cfg-"));
    dirs.push(dir);
    process.env.SECRETS_AI_CONFIG_DIR = dir;

    const tok = ensureBridgeToken();
    expect(tok).toMatch(/^sai_/);
    const mode = statSync(join(dir, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(await runCli(["--help"])).toBe(0);
    expect(await runCli(["auth"])).toBe(0);
  });

  it("exposes tools in secrets-mcp and github-mcp", async () => {
    const listSec = await handleSecretsMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const secNames = ((listSec?.result as any)?.tools ?? []).map((t: any) => t.name);
    expect(secNames).toEqual(["read_conversation", "summarize_dock_channel", "draft_message"]);

    const listGh = await handleGithubMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const ghNames = ((listGh?.result as any)?.tools ?? []).map((t: any) => t.name);
    expect(ghNames).toContain("list_repos");
    expect(ghNames).toContain("open_pr");
  });

  it("persists sessions with 0600 mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-ai-ses-"));
    dirs.push(dir);
    process.env.SECRETS_AI_CONFIG_DIR = dir;

    writeStoredSessions([{ id: "ses_1", workspaceDir: "/tmp", createdAt: "2026-11-28T00:00:00Z" }]);
    const loaded = readStoredSessions<{ id: string }>();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("ses_1");
    const mode = statSync(join(dir, "sessions.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tests mock provider connection", async () => {
    const res = await testProviderConnection("mock", "");
    expect(res.ok).toBe(true);
  });
});
