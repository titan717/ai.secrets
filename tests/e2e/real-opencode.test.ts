/**
 * Bridge end-to-end against the REAL `opencode serve`, driven by the scripted mock LLM
 * (tests/fixtures/mock-llm.mjs) as a custom OpenAI-compatible provider. No API keys and no network LLM.
 *
 * Runs only with OPENCODE_REAL=1 and an opencode binary ($OPENCODE_BIN or `opencode` on PATH):
 *   OPENCODE_REAL=1 npx vitest run tests/e2e/real-opencode.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridge } from "../../src/bridge/server.js";
import { api, readSse, types, type Started } from "./helpers.js";

function findOpencode(): string | undefined {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" });
  const p = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : undefined;
  return p && existsSync(p) ? p : undefined;
}

const BIN = process.env.OPENCODE_REAL === "1" ? findOpencode() : undefined;
const MOCK = resolve(__dirname, "../fixtures/mock-llm.mjs");
const ORIGIN = "https://app.secrets.test";

type Override = (cfg: Record<string, unknown>) => Record<string, unknown>;
let lastOverride: Override | undefined;

describe.skipIf(!BIN)("bridge e2e (real opencode + mock LLM)", () => {
  let llm: ChildProcess;
  let h: Started;
  let A: ReturnType<typeof api>;
  const home = mkdtempSync(join(tmpdir(), "sai-real-home-"));
  const ws = mkdtempSync(join(tmpdir(), "sai-real-ws-"));

  beforeAll(async () => {
    writeFileSync(join(ws, "a.txt"), "hello\n");
    llm = spawn(process.execPath, [MOCK, "0"], { env: { ...process.env, MOCK_DIR: ws }, stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((res, rej) => {
      let out = "";
      llm.stdout!.on("data", (c) => {
        out += c;
        const m = /MOCK_LLM_PORT=(\d+)/.exec(out);
        if (m) res(m[1]!);
      });
      llm.on("exit", (code) => rej(new Error(`mock llm exited ${code}`)));
    });
    h = await startBridge({
      port: 0,
      workspace: ws,
      opencodeBin: BIN,
      quiet: true,
      env: { ...process.env, SECRETS_AI_HOME: home, SECRETS_AI_CORS_ORIGINS: ORIGIN, OPENROUTER_API_KEY: "", GEMINI_API_KEY: "" },
      modelOverride: { providerID: "mock", modelID: "mock-1" },
      supervisor: {
        healthTimeoutMs: 60000,
        configOverride: (lastOverride = (cfg) => {
          const { mcp: _mcp, ...rest } = cfg as Record<string, unknown>;
          return {
            ...rest,
            provider: {
              ...((cfg as any).provider ?? {}),
              mock: {
                npm: "@ai-sdk/openai-compatible",
                name: "Mock",
                options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x" },
                models: { "mock-1": { name: "Mock 1", tool_call: true, reasoning: true } },
              },
            },
            model: "mock/mock-1",
            small_model: "mock/mock-1",
            permission: { ...((cfg as any).permission ?? {}), edit: "ask", bash: "ask", read: "allow", question: "allow" },
          };
        }),
      },
    });
    A = api(h);
  }, 90000);

  afterAll(async () => {
    await h?.close();
    llm?.kill();
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  it("health reports a running opencode", async () => {
    await h.bridge.runtime().waitConnected(60000);
    const j = await (await fetch(h.url + "/health")).json();
    expect(j.ok).toBe(true);
    expect(j.opencode.running).toBe(true);
    expect((await fetch(h.url + "/v1/sessions")).status).toBe(401);
  }, 70000);

  it("text turn streams Hello world and ends with session.idle", async () => {
    const sid = await A.session();
    expect(sid).toMatch(/^ses_/);
    const fs = await readSse(await A.send(sid, "scenario:text"), undefined, 60000);
    const t = types(fs);
    expect(fs.filter((f) => f.data.type === "text.delta").map((f) => f.data.text).join("")).toBe("Hello world");
    expect(t).toContain("usage");
    expect(t.at(-1)).toBe("session.idle");
    expect(t.filter((x) => x === "session.idle")).toHaveLength(1);
    const s = (await A.call("GET", `/v1/sessions/${sid}`)).json.session;
    expect(s.usage.inputTokens).toBeGreaterThan(0);
    expect(s.status).toBe("idle");
  }, 70000);

  it("read tool + bash permission allow runs the command", async () => {
    const sid = await A.session();
    const fs = await readSse(
      await A.send(sid, "scenario:basic"),
      async (f) => {
        if (f.data.type === "permission.request") {
          expect(f.data.action).toBe("bash");
          await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "allow" });
        }
      },
      60000,
    );
    const t = types(fs);
    expect(t).toEqual(expect.arrayContaining(["reasoning.delta", "text.delta", "tool.start", "permission.request", "permission.resolved", "tool.end", "session.idle"]));
    expect(fs.find((f) => f.data.type === "tool.end" && f.data.name === "read")!.data.output).toContain("hello");
    const bash = fs.find((f) => f.data.type === "tool.end" && f.data.name === "bash")!.data;
    expect(bash.error).toBeUndefined();
    expect(fs.find((f) => f.data.type === "permission.resolved")!.data.reply).toBe("once");
    expect(fs.filter((f) => f.data.type === "text.delta").map((f) => f.data.text).join("")).toContain("DONE");
    expect(readFileSync(join(ws, "b.txt"), "utf8").trim()).toBe("hi");
    expect(t.at(-1)).toBe("session.idle");
  }, 70000);

  it("deny rejects the bash call", async () => {
    rmSync(join(ws, "b.txt"), { force: true });
    const sid = await A.session();
    const fs = await readSse(
      await A.send(sid, "scenario:basic"),
      async (f) => {
        if (f.data.type === "permission.request") await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "deny" });
      },
      60000,
    );
    expect(fs.find((f) => f.data.type === "permission.resolved")!.data.reply).toBe("reject");
    expect(fs.find((f) => f.data.type === "tool.end" && f.data.name === "bash")!.data.error).toMatch(/reject/i);
    expect(existsSync(join(ws, "b.txt"))).toBe(false);
    expect(types(fs).at(-1)).toBe("session.idle");
  }, 70000);

  it("question is answered through the bridge", async () => {
    const sid = await A.session();
    let q: any;
    const fs = await readSse(
      await A.send(sid, "scenario:question"),
      async (f) => {
        if (f.data.type === "question") {
          q = f.data;
          await A.call("POST", `/v1/questions/${f.data.questionId}/respond`, { answers: [["Blue"]] });
        }
      },
      60000,
    );
    expect(q.text).toBe("Which color?");
    expect(q.options).toEqual(["Red", "Blue"]);
    expect(fs.filter((f) => f.data.type === "text.delta").map((f) => f.data.text).join("")).toContain("Blue");
    expect(types(fs).at(-1)).toBe("session.idle");
  }, 70000);

  it("provider error surfaces as an error event", async () => {
    const sid = await A.session();
    const fs = await readSse(await A.send(sid, "scenario:error"), undefined, 60000);
    const err = fs.find((f) => f.data.type === "error")!.data;
    expect(err.message).toMatch(/Invalid API key/);
    expect(types(fs).at(-1)).toBe("session.idle");
  }, 70000);

  it("abort stops a slow turn", async () => {
    const sid = await A.session();
    let aborted = false;
    const fs = await readSse(
      await A.send(sid, "scenario:slow"),
      async (f) => {
        if (f.data.type === "text.delta" && !aborted) {
          aborted = true;
          expect((await A.call("POST", `/v1/sessions/${sid}/abort`)).json.ok).toBe(true);
        }
      },
      60000,
    );
    expect(aborted).toBe(true);
    expect(fs.find((f) => f.data.type === "error")!.data.code).toBe("MessageAbortedError");
    expect(types(fs).at(-1)).toBe("session.idle");
  }, 70000);

  it("reconnects via /events with Last-Event-ID", async () => {
    const sid = await A.session();
    const first = await readSse(await A.send(sid, "scenario:basic"), (f) => (f.data.type === "permission.request" ? "stop" : undefined), 60000);
    const perm = first.at(-1)!;
    await A.call("POST", `/v1/permissions/${perm.data.permissionId}/respond`, { decision: "allow" });
    const rest = await readSse(
      await fetch(`${h.url}/v1/sessions/${sid}/events`, { headers: { ...A.H, "last-event-id": perm.id! } }),
      (f) => (f.data.type === "session.idle" ? "stop" : undefined),
      60000,
    );
    const t = types(rest);
    expect(t).not.toContain("permission.request");
    expect(t).toEqual(expect.arrayContaining(["permission.resolved", "tool.end", "session.idle"]));
  }, 70000);

  it("legacy /v1/chat with Origin auth, confirm and done", async () => {
    const res = await fetch(h.url + "/v1/chat", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", model: "x", messages: [{ role: "user", content: "scenario:basic" }] }),
    });
    expect(res.status).toBe(200);
    const runId = res.headers.get("x-run-id")!;
    const fs = await readSse(
      res,
      async (f) => {
        if (f.data.type === "confirm_required") {
          await fetch(`${h.url}/v1/chat/${runId}/confirm`, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/json" },
            body: JSON.stringify({ call_id: f.data.call_id, approve: true }),
          });
        }
      },
      60000,
    );
    const t = types(fs);
    expect(t).toEqual(expect.arrayContaining(["reasoning", "text", "tool_call", "confirm_required", "tool_result", "done"]));
    expect(fs.at(-1)!.data).toEqual({ type: "done", reason: "complete" });
  }, 70000);

  // Runs last: OpenCode keeps an "always" approval for the rest of the server process, across sessions.
  it("allow_session replies always", async () => {
    const sid = await A.session();
    const fs = await readSse(
      await A.send(sid, "scenario:basic"),
      async (f) => {
        if (f.data.type === "permission.request") await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "allow_session" });
      },
      60000,
    );
    expect(fs.find((f) => f.data.type === "permission.resolved")!.data.reply).toBe("always");
    expect(types(fs).at(-1)).toBe("session.idle");
  }, 70000);

  it("sessions survive a bridge restart", async () => {
    const before = (await A.call("GET", "/v1/sessions")).json.sessions.map((s: any) => s.id);
    expect(before.length).toBeGreaterThan(0);
    await h.close();
    h = await startBridge({
      port: 0,
      workspace: ws,
      opencodeBin: BIN,
      quiet: true,
      env: { ...process.env, SECRETS_AI_HOME: home, SECRETS_AI_CORS_ORIGINS: ORIGIN, OPENROUTER_API_KEY: "", GEMINI_API_KEY: "" },
      modelOverride: { providerID: "mock", modelID: "mock-1" },
      supervisor: { healthTimeoutMs: 60000, configOverride: lastOverride },
    });
    A = api(h);
    const after = (await A.call("GET", "/v1/sessions")).json.sessions.map((s: any) => s.id);
    expect(after).toEqual(expect.arrayContaining(before));
    const fs = await readSse(await A.send(before[0], "scenario:text"), undefined, 60000);
    expect(types(fs).at(-1)).toBe("session.idle");
  }, 90000);
});

