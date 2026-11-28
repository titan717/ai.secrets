import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeClient } from "../src/bridge/opencode-client.js";
import { OpenCodeSupervisor } from "../src/supervisor/opencode.js";

const FAKE_BIN = resolve(process.cwd(), "tests/fake-opencode.mjs");

describe("OpenCodeSupervisor", () => {
  const dirs: string[] = [];

  function tempWorkspace() {
    const d = mkdtempSync(join(tmpdir(), "secrets-ai-sup-"));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("spawns fake opencode, generates opencode.json without raw keys, and shuts down cleanly", async () => {
    const ws = tempWorkspace();
    const sup = new OpenCodeSupervisor({
      workspaceDir: ws,
      command: process.execPath,
      argsPrefix: [FAKE_BIN],
      env: { OPENROUTER_API_KEY: "sk-or-v1-secret-test-key" },
    });

    const { port, baseUrl } = await sup.start();
    expect(port).toBeGreaterThan(0);
    expect(sup.isRunning).toBe(true);

    const cfgPath = join(ws, "opencode.json");
    expect(existsSync(cfgPath)).toBe(true);
    const cfgRaw = readFileSync(cfgPath, "utf8");
    expect(cfgRaw).toContain("{env:OPENROUTER_API_KEY}");
    expect(cfgRaw).not.toContain("sk-or-v1-secret-test-key");

    const client = new OpenCodeClient(baseUrl);
    expect(await client.health()).toBe(true);

    await sup.stop();
    expect(sup.isRunning).toBe(false);
  });

  it("restarts automatically if the child process crashes", async () => {
    const ws = tempWorkspace();
    let restarted = false;
    const sup = new OpenCodeSupervisor({
      workspaceDir: ws,
      command: process.execPath,
      argsPrefix: [FAKE_BIN],
      onRestart: () => {
        restarted = true;
      },
    });

    const { baseUrl } = await sup.start();
    const client = new OpenCodeClient(baseUrl);
    const ses = await client.createSession(ws);

    // Trigger crash in fake-opencode
    await client.sendPrompt(ses.id, { text: "__crash__" });

    // Wait for supervisor restart
    const deadline = Date.now() + 8000;
    while (!restarted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(restarted).toBe(true);
    expect(sup.isRunning).toBe(true);
    await sup.stop();
  }, 15_000);
});
