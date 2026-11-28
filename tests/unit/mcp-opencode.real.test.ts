/**
 * secrets-mcp inside the REAL `opencode serve` (OPENCODE_REAL=1, needs `pnpm build` first).
 * Verifies: OpenCode connects over stdio, exposes tools as `<server>_<tool>`, the generated
 * permission rules apply to those names (read = allow, draft = ask), and the token reaches the
 * MCP child only via {env:SECRETS_AI_SECRETS_TOKEN} substitution.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildOpenCodeConfig, buildProviderEnv } from "../../src/presets/index.js";
import { DEFAULT_SETTINGS } from "../../src/core/types.js";
import { IDS, startStubApi } from "../fixtures/mcp/stub-secrets-api.mjs";

const DIST = fileURLToPath(new URL("../../dist/mcp/secrets-mcp.js", import.meta.url));
const MOCK = fileURLToPath(new URL("../fixtures/mcp/mock-llm-mcp.mjs", import.meta.url));
const REAL = process.env.OPENCODE_REAL === "1" && existsSync(DIST);
const kids: ChildProcess[] = [];
afterAll(() => kids.forEach((k) => k.kill()));

const waitLine = (p: ChildProcess, re: RegExp) =>
  new Promise<RegExpExecArray>((res, rej) => {
    let b = "";
    p.stdout!.on("data", (d) => { b += d; const m = re.exec(b); if (m) res(m); });
    p.once("exit", (c) => rej(new Error(`exited ${c}`)));
  });

describe.skipIf(!REAL)("secrets-mcp in real opencode", () => {
  it("tools are named secrets_<tool>, permissions apply, token is substituted", async () => {
    const TOKEN = "sai_" + "R".repeat(40);
    const api = await startStubApi({ token: TOKEN });
    const llm = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_CONV_ID: IDS.dm }, stdio: ["ignore", "pipe", "inherit"] });
    kids.push(llm);
    const llmPort = (await waitLine(llm, /MOCK_LLM_PORT=(\d+)/))[1];

    const work = mkdtempSync(join(tmpdir(), "oc-mcp-"));
    const cfg = buildOpenCodeConfig({
      settings: { ...DEFAULT_SETTINGS, tools: { github: false, secrets: true }, secretsApiUrl: api.url },
      available: { openrouter: false, google: false, github: false, secrets: true },
      secretsMcpEntry: DIST,
      nodePath: process.execPath,
    }) as Record<string, any>;
    cfg.provider = { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: "x" }, models: { "mock-1": { name: "Mock 1", tool_call: true } } } };
    cfg.model = cfg.small_model = "mock/mock-1";
    writeFileSync(join(work, "opencode.json"), JSON.stringify(cfg, null, 2));
    expect(JSON.stringify(cfg)).not.toContain(TOKEN);

    const xdg = (d: string) => { const p = join(work, ".xdg", d); mkdirSync(p, { recursive: true }); return p; };
    const pw = "p" + Math.random().toString(36).slice(2);
    const oc = spawn(process.env.OPENCODE_BIN || "opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: work,
      env: { ...process.env, ...buildProviderEnv({ secretsToken: TOKEN }), OPENCODE_SERVER_PASSWORD: pw, XDG_CONFIG_HOME: xdg("c"), XDG_DATA_HOME: xdg("d"), XDG_STATE_HOME: xdg("s"), XDG_CACHE_HOME: xdg("k") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    kids.push(oc);
    const base = (await waitLine(oc, /listening on (http:\/\/[\d.:]+)/))[1]!;
    const auth = "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
    const call = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init.headers as object) } });

    const events: any[] = [];
    const ctrl = new AbortController();
    void (async () => {
      const r = await call("/event", { signal: ctrl.signal });
      const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
            if (data) try { events.push(JSON.parse(data)); } catch {}
          }
        }
      } catch {}
    })();
    const until = async <T>(fn: () => T | undefined, ms = 30000): Promise<T> => {
      const t = Date.now();
      while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error("timeout");
    };

    const status = await (async () => { for (let i = 0; i < 50; i++) { const s = await (await call("/mcp")).json(); if (s.secrets?.status === "connected") return s; await new Promise((r) => setTimeout(r, 200)); } return (await call("/mcp")).json(); })();
    expect(status.secrets.status).toBe("connected");

    const ses = await (await call("/session", { method: "POST", body: JSON.stringify({ title: "mcp" }) })).json();
    const r = await call(`/session/${ses.id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "go" }] }) });
    expect(r.status).toBe(204);

    const asked = await until(() => events.find((e) => e.type === "permission.asked" && e.properties.sessionID === ses.id));
    expect(asked.properties.permission).toBe("secrets_draft_message");
    // read_conversation ran without asking (allow) and before the draft
    const readPart = events.find((e) => e.type === "message.part.updated" && e.properties.part?.tool === "secrets_read_conversation" && e.properties.part.state?.status === "completed");
    expect(readPart).toBeTruthy();
    expect(String(readPart.properties.part.state.output)).toContain("see photo");
    expect(events.some((e) => e.type === "permission.asked" && e.properties.permission === "secrets_read_conversation")).toBe(false);

    await call(`/permission/${asked.properties.id}/reply`, { method: "POST", body: JSON.stringify({ reply: "once" }) });
    await until(() => events.find((e) => e.type === "session.idle" && e.properties.sessionID === ses.id));
    const draft = events.find((e) => e.type === "message.part.updated" && e.properties.part?.tool === "secrets_draft_message" && e.properties.part.state?.status === "completed");
    expect(String(draft.properties.part.state.output)).toContain('"sent": false');

    const seen = await (await fetch(`http://127.0.0.1:${llmPort}/seen`)).json();
    expect(seen.tools).toEqual(expect.arrayContaining(["secrets_read_conversation", "secrets_summarize_dock_channel", "secrets_draft_message"]));
    expect(api.requests.length).toBeGreaterThan(0);
    expect(api.requests.every((q) => q.auth === `Bearer ${TOKEN}` && q.method === "GET")).toBe(true);
    ctrl.abort();
    oc.kill();
    llm.kill();
    await api.close();
  }, 90000);
});
