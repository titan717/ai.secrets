import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/core/log.js";
import { DEFAULT_SETTINGS, type Secrets, type Settings } from "../../src/core/types.js";
import { buildOpenCodeConfig } from "../../src/presets/index.js";
import { OpenCodeSupervisor, type SupervisorOptions, type SupervisorStatus } from "../../src/supervisor/index.js";

const FAKE = resolve(__dirname, "..", "fixtures", "fake-opencode.mjs");
const FAKE_KEY = "fakeprovkey-Z9y8X7w6V5u4T3s2";

function captureLogger(lines: string[]): Logger {
  // Mirror createLogger: every line is redacted before it is written.
  const w = (lvl: string) => (m: string, e?: unknown) => lines.push(`${lvl} ${m}${e !== undefined ? " " + String(e instanceof Error ? e.message : JSON.stringify(e)) : ""}`);
  return { debug: w("debug"), info: w("info"), warn: w("warn"), error: w("error") };
}

const sups: OpenCodeSupervisor[] = [];
afterEach(async () => {
  await Promise.all(sups.splice(0).map((s) => s.stop()));
});

function make(over: Partial<SupervisorOptions> & { settings?: Settings; secrets?: Secrets; lines?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sai-sup-"));
  const workspace = mkdtempSync(join(tmpdir(), "sai-ws-"));
  const state = { settings: over.settings ?? { ...DEFAULT_SETTINGS }, secrets: over.secrets ?? { openrouterApiKey: FAKE_KEY } };
  const lines = over.lines ?? [];
  const sup = new OpenCodeSupervisor({
    workspace,
    bin: FAKE,
    env: { ...process.env, SECRETS_AI_HOME: home, GITHUB_TOKEN: "ghp_parentTokenShouldNotLeak000000000", OPENCODE_SERVER_PASSWORD: "parent" },
    getSettings: () => state.settings,
    getSecrets: () => state.secrets,
    logger: captureLogger(lines),
    backoffBaseMs: 50,
    backoffMaxMs: 200,
    killTimeoutMs: 1000,
    ...over,
  });
  sups.push(sup);
  return { sup, home, workspace, state, lines };
}

const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (fn: () => boolean, ms = 10000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const info = async (sup: OpenCodeSupervisor) => (await sup.client.request<any>("GET", "/__fake/info"));

describe("OpenCodeSupervisor (fake opencode)", () => {
  it("spawns, parses the port from stdout, waits for health and uses a random password", async () => {
    const { sup } = make();
    await sup.start();
    const st = sup.state;
    expect(st.state).toBe("running");
    expect(st.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(st.version).toBe("1.19.6");
    expect((await sup.client.health()).healthy).toBe(true);
    // Without credentials the child refuses every route.
    expect((await fetch(st.url + "/global/health")).status).toBe(401);
    expect((await fetch(st.url + "/global/health", { headers: { authorization: "Basic " + Buffer.from("opencode:parent").toString("base64") } })).status).toBe(401);
  });

  it("isolates XDG dirs and config under the workspace state dir and passes only preset env", async () => {
    const { sup, home, workspace } = make({ configOverride: (c) => ({ ...c, provider: { mock: { models: { "mock-1": { name: "Mock" } } } } }) });
    await sup.start();
    const i = await info(sup);
    expect(resolve(i.cwd)).toBe(resolve(workspace));
    expect(sup.stateDir.startsWith(join(home, "workspaces"))).toBe(true);
    for (const k of ["config", "data", "state", "cache"]) expect(i.xdg[k]).toBe(join(sup.stateDir, k));
    expect(i.configPath).toBe(join(sup.stateDir, "opencode.json"));
    expect(existsSync(join(workspace, "opencode.json"))).toBe(false);
    expect(i.envKeys).toContain("OPENROUTER_API_KEY");
    expect(i.envKeys).not.toContain("GITHUB_TOKEN");
    // Config = presets output + test override, written 0600, and never contains the key.
    const raw = readFileSync(sup.configPath, "utf8");
    expect(raw).not.toContain(FAKE_KEY);
    const expected = { ...buildOpenCodeConfig({ settings: DEFAULT_SETTINGS, available: { openrouter: true, google: false, github: false, secrets: false }, secretsMcpEntry: "x", nodePath: process.execPath }), provider: { mock: { models: { "mock-1": { name: "Mock" } } } } };
    expect(JSON.parse(raw)).toEqual(expected);
    expect(i.config).toEqual(expected);
    if (process.platform !== "win32") expect(statSync(sup.configPath).mode & 0o777).toBe(0o600);
  });

  it("redacts secrets from child stderr before logging", async () => {
    const lines: string[] = [];
    const { sup } = make({ lines, extraEnv: { FAKE_OPENCODE_ECHO_SECRETS: "1" } });
    await sup.start();
    await waitFor(() => lines.some((l) => l.includes("debug provider key")));
    const all = lines.join("\n");
    expect(all).toContain("[REDACTED]");
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toMatch(/password [A-Za-z0-9_-]{20,}/);
  });

  it("restarts after a crash with backoff and gives up after maxCrashes in the window", async () => {
    const statuses: SupervisorStatus[] = [];
    const { sup } = make({ extraEnv: { FAKE_OPENCODE_CRASH_AFTER_MS: "400" }, maxCrashes: 3, crashWindowMs: 60_000 });
    sup.on("status", (s) => statuses.push(s));
    await sup.start();
    const firstPid = sup.pid;
    const gen = sup.generation;
    await waitFor(() => sup.generation > gen);
    expect(sup.pid).not.toBe(firstPid);
    await waitFor(() => sup.state.state === "failed", 15000);
    expect(sup.state.message).toMatch(/crashed 3 times/);
    expect(statuses.filter((s) => s.state === "backoff").length).toBe(2);
    expect(statuses.filter((s) => s.state === "running").length).toBe(3);
    await expect(sup.ready(100)).rejects.toThrow(/crashed/);
  });

  it("stops cleanly with SIGTERM", async () => {
    const { sup } = make();
    await sup.start();
    const pid = sup.pid;
    expect(alive(pid)).toBe(true);
    await sup.stop();
    expect(sup.state.state).toBe("stopped");
    await waitFor(() => !alive(pid));
  });

  it.skipIf(process.platform === "win32")("falls back to SIGKILL when the child ignores SIGTERM", async () => {
    const { sup } = make({ extraEnv: { FAKE_OPENCODE_IGNORE_SIGTERM: "1" }, killTimeoutMs: 300 });
    await sup.start();
    const pid = sup.pid;
    const t = Date.now();
    await sup.stop();
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    await waitFor(() => !alive(pid));
  });

  it("regenerates the config and restarts only when settings or secrets change", async () => {
    const { sup, state } = make();
    await sup.start();
    const pid = sup.pid;
    expect(await sup.reload()).toBe(false);
    expect(sup.pid).toBe(pid);
    state.settings = { ...state.settings, model: "openai/gpt-5-mini" };
    expect(await sup.reload()).toBe(true);
    expect(sup.pid).not.toBe(pid);
    expect(sup.state.state).toBe("running");
    expect(JSON.parse(readFileSync(sup.configPath, "utf8")).model).toBe("openrouter/openai/gpt-5-mini");
    expect((await info(sup)).config.model).toBe("openrouter/openai/gpt-5-mini");
    const pid2 = sup.pid;
    state.secrets = { openrouterApiKey: FAKE_KEY + "x" };
    expect(await sup.reload()).toBe(true);
    expect(sup.pid).not.toBe(pid2);
    await waitFor(() => !alive(pid) && !alive(pid2));
  });

  it("reports a clear error when the binary does not exist", async () => {
    const { sup } = make({ bin: join(tmpdir(), "definitely-not-opencode-bin"), maxCrashes: 1 });
    await expect(sup.start()).rejects.toThrow(/failed to spawn|exited during startup/);
    expect(sup.state.state).toBe("failed");
  });
});
