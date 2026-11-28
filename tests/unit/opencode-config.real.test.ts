/**
 * Validates the generated opencode.json against the REAL `opencode serve` binary.
 * Skipped unless OPENCODE_REAL=1 (needs `opencode` on PATH or OPENCODE_BIN). No real keys needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildOpenCodeConfig, buildProviderEnv, sanitizeOpenCodeProviders } from "../../src/presets/index.js";
import { DEFAULT_SETTINGS, type Settings } from "../../src/core/types.js";

const REAL = process.env.OPENCODE_REAL === "1";
const children: ChildProcess[] = [];
afterAll(() => children.forEach((c) => c.kill()));

async function serve(settings: Settings, secrets: Parameters<typeof buildProviderEnv>[0], extraEnv: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), "oc-cfg-"));
  const cfg = buildOpenCodeConfig({
    settings,
    available: { openrouter: !!secrets.openrouterApiKey, google: !!secrets.geminiApiKey, github: !!secrets.githubToken, secrets: !!secrets.secretsToken },
    secretsMcpEntry: join(work, "missing-mcp.js"),
    nodePath: process.execPath,
  });
  writeFileSync(join(work, "opencode.json"), JSON.stringify(cfg, null, 2));
  const xdg = (d: string) => { const p = join(work, ".xdg", d); mkdirSync(p, { recursive: true }); return p; };
  const password = "t-" + Math.random().toString(36).slice(2);
  const oc = spawn(process.env.OPENCODE_BIN || "opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: work,
    env: { ...process.env, ...buildProviderEnv(secrets), ...extraEnv, OPENCODE_SERVER_PASSWORD: password, XDG_CONFIG_HOME: xdg("c"), XDG_DATA_HOME: xdg("d"), XDG_STATE_HOME: xdg("s"), XDG_CACHE_HOME: xdg("k") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(oc);
  const base = await new Promise<string>((res, rej) => {
    let buf = "";
    oc.stdout!.on("data", (d) => { buf += d; const m = /listening on (http:\/\/[\d.:]+)/.exec(buf); if (m) res(m[1]!); });
    oc.once("exit", (c) => rej(new Error(`opencode exited ${c}`)));
  });
  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const get = async (p: string) => (await fetch(base + p, { headers: { authorization: auth } })).json() as Promise<any>;
  return { cfg, get, kill: () => oc.kill() };
}

describe.skipIf(!REAL)("opencode.json against real opencode serve", () => {
  it("openrouter config with MCP + effort + prompt is accepted and reflected in /config", async () => {
    const s = await serve(
      { ...DEFAULT_SETTINGS, effort: { level: "high" }, systemPrompt: "Be brief.", tools: { github: true, secrets: true }, secretsApiUrl: "http://127.0.0.1:9" },
      { openrouterApiKey: "placeholder-or", githubToken: "placeholder-gh", secretsToken: "placeholder-st" },
      { GITHUB_TOKEN: "placeholder-gh2" }, // even if one leaks into the env, copilot stays disabled
    );
    const c = await s.get("/config");
    expect(c.model).toBe("openrouter/openrouter/free");
    expect(c.agent.build).toMatchObject({ steps: 20, prompt: "Be brief." });
    expect(c.agent.plan.permission).toMatchObject({ edit: "deny", bash: "deny" });
    expect(c.permission).toMatchObject({ edit: "ask", read: "allow", "github_create_pull_request": "ask", "github_get_*": "allow" });
    expect(c.mcp.github.headers.Authorization).toBe("Bearer placeholder-gh"); // {env:} substituted at load
    expect(Object.keys(c.mcp)).toEqual(["github", "secrets"]);
    const p = await s.get("/config/providers");
    const ids = p.providers.map((x: any) => x.id);
    expect(ids).toContain("openrouter");
    expect(ids).not.toContain("github-copilot");
    const or = p.providers.find((x: any) => x.id === "openrouter");
    expect(or.options.headers).toEqual({ "HTTP-Referer": "https://github.com/titan717/secrets", "X-Title": "Secrets" });
    expect(JSON.stringify(sanitizeOpenCodeProviders(p))).not.toContain("placeholder-or");
    s.kill();
  });
  it("google config is accepted", async () => {
    const s = await serve({ ...DEFAULT_SETTINGS, provider: "google", model: "gemini-2.5-flash" }, { geminiApiKey: "placeholder-gm" });
    const c = await s.get("/config");
    expect(c.model).toBe("google/gemini-2.5-flash");
    expect(c.small_model).toBe("google/gemini-2.5-flash-lite");
    const p = await s.get("/config/providers");
    const g = p.providers.find((x: any) => x.id === "google");
    expect(Object.keys(g.models["gemini-2.5-flash"].variants)).toEqual(["high", "max"]);
    s.kill();
  });
});
