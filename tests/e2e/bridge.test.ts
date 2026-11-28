/**
 * Bridge end-to-end tests: startBridge + the trace-replaying fake opencode (tests/fixtures/fake-opencode.mjs).
 * Fully offline: provider model listing goes to a local mock of the OpenRouter API.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridge } from "../../src/bridge/server.js";
import { api, bodies, readSse, types, until, type Started } from "./helpers.js";

const FAKE_BIN = resolve(__dirname, "../fixtures/fake-opencode.mjs");
const FAKE_KEY = "sk-or-v1-FAKEKEY0123456789abcdefSECRET";
const HEADER_KEY = "sk-or-v1-HEADERKEY987654321SECRET";
const ORIGIN = "https://app.secrets.test";

let mockApi: Server;
let mockUrl = "";
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

async function start(home: string, workspace: string, extraEnv: Record<string, string> = {}) {
  return startBridge({
    port: 0,
    host: "127.0.0.1",
    workspace,
    opencodeBin: FAKE_BIN,
    quiet: true,
    pingMs: 200,
    models: { baseUrls: { openrouter: mockUrl, google: mockUrl } },
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SECRETS_AI_HOME: home, SECRETS_AI_CORS_ORIGINS: ORIGIN, ...extraEnv } as NodeJS.ProcessEnv,
  });
}

beforeAll(async () => {
  mockApi = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/models")) {
      res.end(
        JSON.stringify({
          data: [
            { id: "openai/gpt-5-mini", name: "GPT-5 mini", context_length: 400000, pricing: { prompt: "0.00000025", completion: "0.000002" }, supported_parameters: ["tools", "reasoning"] },
            { id: "meta/free-tools:free", name: "Free", context_length: 8000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
          ],
        }),
      );
    } else if (req.url?.startsWith("/key")) {
      const ok = req.headers.authorization === `Bearer ${FAKE_KEY}`;
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { data: { label: "x" } } : { error: { message: "User not found.", code: 401 } }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => mockApi.listen(0, "127.0.0.1", r));
  mockUrl = `http://127.0.0.1:${(mockApi.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => mockApi.close(r));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("bridge e2e (fake opencode)", () => {
  let h: Started;
  let A: ReturnType<typeof api>;
  const home = tmp("sai-home-");
  const ws = tmp("sai-ws-");

  beforeAll(async () => {
    h = await start(home, ws);
    A = api(h);
    const put = await A.call("PUT", "/v1/secrets", { openrouterApiKey: FAKE_KEY });
    expect(put.status).toBe(200);
    expect(put.json.secrets.openrouter).toBe(true);
  }, 30000);

  afterAll(async () => {
    await h?.close();
  });

  it("serves /health without auth and rejects /v1 without a valid bearer", async () => {
    const health = await fetch(h.url + "/health");
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    expect((await fetch(h.url + "/v1/sessions")).status).toBe(401);
    const bad = await fetch(h.url + "/v1/sessions", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const err = await bad.json();
    expect(err.error.code).toBeTruthy();
    // Legacy route without bearer and without an allowed Origin -> 401.
    const legacy = await fetch(h.url + "/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(legacy.status).toBe(401);
    // A non-legacy route with an allowed Origin still needs the bearer.
    expect((await fetch(h.url + "/v1/sessions", { headers: { origin: ORIGIN } })).status).toBe(401);
  });

  it("creates, lists, gets and deletes sessions", async () => {
    const created = await A.call("POST", "/v1/sessions", { title: "hello" });
    expect(created.status).toBe(200);
    const s = created.json.session;
    expect(s.id).toMatch(/^ses_/);
    expect(s.title).toBe("hello");
    expect(s.workspace).toBe(ws);
    expect(s.status).toBe("idle");
    const list = await A.call("GET", "/v1/sessions");
    expect(list.json.sessions.map((x: any) => x.id)).toContain(s.id);
    expect((await A.call("GET", `/v1/sessions/${s.id}`)).json.session.id).toBe(s.id);
    expect((await A.call("DELETE", `/v1/sessions/${s.id}`)).json.ok).toBe(true);
    const gone = await A.call("GET", `/v1/sessions/${s.id}`);
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBeTruthy();
    expect((await A.call("POST", "/v1/sessions", { workspace: "relative/dir" })).status).toBe(400);
  });

  it("streams a text turn until session.idle with SSE ids", async () => {
    const sid = await A.session();
    const res = await A.send(sid, "scenario:text say hi");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const fs = await readSse(res);
    const t = types(fs);
    expect(t[t.length - 1]).toBe("session.idle");
    expect(t).toContain("text.delta");
    expect(t).toContain("usage");
    expect(fs.every((f) => f.id && f.event === f.data.type && f.data.sessionId === sid)).toBe(true);
    const ids = fs.map((f) => Number(f.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const text = fs.filter((f) => f.data.type === "text.delta").map((f) => f.data.text).join("");
    expect(text.length).toBeGreaterThan(0);
    const s = (await A.call("GET", `/v1/sessions/${sid}`)).json.session;
    expect(s.status).toBe("idle");
    expect(s.usage.inputTokens + s.usage.outputTokens).toBeGreaterThan(0);
  });

  it("tool + permission allow via /v1/permissions/:id/respond", async () => {
    const sid = await A.session();
    let responded: any;
    const fs = await readSse(await A.send(sid, "scenario:basic"), async (f) => {
      if (f.data.type === "permission.request") {
        expect(f.data.action).toBe("bash");
        // Busy session rejects a second prompt.
        expect((await A.send(sid, "again")).status).toBe(409);
        responded = await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "allow" });
      }
    });
    expect(responded.json.ok).toBe(true);
    const t = types(fs);
    expect(t).toEqual(expect.arrayContaining(["tool.start", "permission.request", "permission.resolved", "tool.end", "session.idle"]));
    expect(fs.find((f) => f.data.type === "permission.resolved")!.data.reply).toBe("once");
    expect(fs.find((f) => f.data.type === "tool.end" && f.data.name === "read")!.data.output).toContain("hello");
    const end = fs.find((f) => f.data.type === "tool.end" && f.data.name === "bash")!.data;
    expect(end.error).toBeUndefined();
    const perm = fs.findIndex((f) => f.data.type === "permission.request");
    expect(fs[perm]!.data.detail.callId).toBe(end.callId);
    expect(fs.findIndex((f) => f.data.type === "tool.start" && f.data.callId === end.callId)).toBeLessThan(perm);
    expect(t.indexOf("permission.resolved")).toBeLessThan(fs.findIndex((f) => f.data.type === "tool.end" && f.data.name === "bash"));
    expect(t[t.length - 1]).toBe("session.idle");
    expect((await A.call("POST", "/v1/permissions/per_missing/respond", { decision: "maybe" })).status).toBe(400);
  });

  it("deny rejects the tool call", async () => {
    const sid = await A.session();
    const fs = await readSse(await A.send(sid, "scenario:deny"), async (f) => {
      if (f.data.type === "permission.request") await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "deny" });
    });
    expect(fs.find((f) => f.data.type === "permission.resolved")!.data.reply).toBe("reject");
    const end = fs.find((f) => f.data.type === "tool.end" && f.data.name === "bash")!.data;
    expect(end.error).toMatch(/rejected/);
    expect(types(fs).at(-1)).toBe("session.idle");
  });

  it("allow_session maps to OpenCode reply \"always\"", async () => {
    const sid = await A.session();
    const fs = await readSse(await A.send(sid, "scenario:basic"), async (f) => {
      if (f.data.type === "permission.request") await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "allow_session" });
    });
    expect(fs.find((f) => f.data.type === "permission.resolved")!.data.reply).toBe("always");
    expect(types(fs).at(-1)).toBe("session.idle");
  });

  it("answers a question via /v1/questions/:id/respond", async () => {
    const sid = await A.session();
    let q: any;
    const fs = await readSse(await A.send(sid, "scenario:question"), async (f) => {
      if (f.data.type === "question") {
        q = f.data;
        const r = await A.call("POST", `/v1/questions/${f.data.questionId}/respond`, { answers: [["Blue"]] });
        expect(r.json.ok).toBe(true);
      }
    });
    expect(q.options).toEqual(["Red", "Blue"]);
    expect(q.text.length).toBeGreaterThan(0);
    const t = types(fs);
    expect(t.at(-1)).toBe("session.idle");
    expect(t.indexOf("question")).toBeGreaterThan(-1);
    expect(JSON.stringify(fs.filter((f) => f.data.type === "tool.end" || f.data.type === "text.delta"))).toContain("Blue");
  });

  it("dismisses a question with reject:true", async () => {
    const sid = await A.session();
    const fs = await readSse(await A.send(sid, "scenario:question"), async (f) => {
      if (f.data.type === "question") await A.call("POST", `/v1/questions/${f.data.questionId}/respond`, { reject: true });
    });
    expect(types(fs).at(-1)).toBe("session.idle");
  });

  it("aborts a running turn", async () => {
    const sid = await A.session();
    let aborted = false;
    const fs = await readSse(await A.send(sid, "scenario:abort"), async (f) => {
      if (f.data.type === "text.delta" && !aborted) {
        aborted = true;
        expect((await A.call("POST", `/v1/sessions/${sid}/abort`)).json.ok).toBe(true);
      }
    });
    expect(aborted).toBe(true);
    const err = fs.find((f) => f.data.type === "error")!.data;
    expect(err.code).toBe("MessageAbortedError");
    expect(types(fs).at(-1)).toBe("session.idle");
    expect((await A.call("GET", `/v1/sessions/${sid}`)).json.session.status).toBe("idle");
  });

  it("surfaces a provider error", async () => {
    const sid = await A.session();
    const fs = await readSse(await A.send(sid, "scenario:error"));
    const err = fs.find((f) => f.data.type === "error")!.data;
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.code).toBeTruthy();
    expect(types(fs).at(-1)).toBe("session.idle");
  });

  it("replays missed events on /events with Last-Event-ID", async () => {
    const sid = await A.session();
    // Disconnect at the permission request.
    const first = await readSse(await A.send(sid, "scenario:basic"), until("permission.request"));
    const perm = first.at(-1)!;
    expect(perm.data.type).toBe("permission.request");
    await A.call("POST", `/v1/permissions/${perm.data.permissionId}/respond`, { decision: "allow" });
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${h.url}/v1/sessions/${sid}/events`, { headers: { ...A.H, "last-event-id": perm.id! } });
    expect(res.status).toBe(200);
    const rest = await readSse(res, until("session.idle"));
    const t = types(rest);
    expect(t).not.toContain("permission.request");
    expect(t).toEqual(expect.arrayContaining(["permission.resolved", "tool.end", "session.idle"]));
    expect(rest.every((f) => Number(f.id) > Number(perm.id))).toBe(true);
    // The query-string form works too and replays the same tail.
    const res2 = await fetch(`${h.url}/v1/sessions/${sid}/events?lastEventId=${perm.id}`, { headers: A.H });
    const rest2 = await readSse(res2, until("session.idle"));
    expect(rest2.map((f) => f.id)).toEqual(rest.map((f) => f.id));
  });

  it("uses x-provider-key for one turn only and removes it afterwards", async () => {
    const sid = await A.session();
    let during: string[] = [];
    await readSse(await A.send(sid, "scenario:basic", { "x-provider-key": HEADER_KEY }), async (f) => {
      if (f.data.type === "permission.request") {
        during = (await A.fakeInfo()).authProviders;
        await A.call("POST", `/v1/permissions/${f.data.permissionId}/respond`, { decision: "allow" });
      }
    });
    expect(during).toContain("openrouter");
    await new Promise((r) => setTimeout(r, 100));
    expect((await A.fakeInfo()).authProviders).not.toContain("openrouter");
  });

  it("lists models and tests the connection without leaking the key", async () => {
    const m = await A.call("GET", "/v1/models?provider=openrouter");
    expect(m.status).toBe(200);
    expect(m.json.models.map((x: any) => x.id)).toContain("openai/gpt-5-mini");
    const free = await A.call("GET", "/v1/models?provider=openrouter&free_tools=1");
    expect(free.json.models.map((x: any) => x.id)).toEqual(["meta/free-tools:free"]);
    const tc = await A.call("POST", "/v1/settings/test-connection", { provider: "openrouter" });
    expect(tc.json.ok).toBe(true);
    expect(tc.json.provider).toBe("openrouter");
    // The fake echoes the raw env key in /config/providers, like real opencode.
    const raw = JSON.stringify(await h.bridge.runtime().client.configProviders());
    expect(raw).toContain(FAKE_KEY);
  });

  it("gets and updates settings; a settings change regenerates the opencode config", async () => {
    const before = await A.call("GET", "/v1/settings");
    expect(before.json.settings.provider).toBe("openrouter");
    expect(before.json.secrets).toEqual({ openrouter: true, google: false, github: false, secrets: false });
    const pid1 = (await A.fakeInfo()).pid;
    const put = await A.call("PUT", "/v1/settings", { effort: { level: "high" } });
    expect(put.status).toBe(200);
    expect(put.json.settings.effort.level).toBe("high");
    const sid = await A.session();
    const fs = await readSse(await A.send(sid, "scenario:text"));
    expect(types(fs).at(-1)).toBe("session.idle");
    const info = await A.fakeInfo();
    expect(info.pid).not.toBe(pid1);
    expect(JSON.stringify(info.config)).not.toContain(FAKE_KEY);
    expect(info.envKeys).toContain("OPENROUTER_API_KEY");
    expect((await A.call("PUT", "/v1/settings", { effort: { level: "bogus" } })).status).toBe(400);
  });

  it("legacy /v1/chat with an allowed Origin and no bearer, confirm + done", async () => {
    const res = await fetch(h.url + "/v1/chat", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "scenario:basic" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const runId = res.headers.get("x-run-id")!;
    expect(runId).toBeTruthy();
    const fs = await readSse(res, async (f) => {
      if (f.data.type === "confirm_required") {
        const c = await fetch(`${h.url}/v1/chat/${runId}/confirm`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ call_id: f.data.call_id, approve: true }),
        });
        expect(c.status).toBe(200);
      }
    });
    const t = types(fs);
    expect(t).toEqual(expect.arrayContaining(["tool_call", "confirm_required", "tool_result", "done"]));
    expect(fs.at(-1)!.data).toEqual({ type: "done", reason: "complete" });
    expect(t).not.toContain("tool.start");
  });

  it("legacy /v1/chat stop, gemini mapping and preflight", async () => {
    const pre = await fetch(h.url + "/v1/chat", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const res = await fetch(h.url + "/v1/chat", {
      method: "POST",
      headers: { ...A.H },
      body: JSON.stringify({ provider: "openrouter", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "scenario:slow" }] }),
    });
    const runId = res.headers.get("x-run-id")!;
    let stopped = false;
    const fs = await readSse(res, async (f) => {
      if (f.data.type === "text" && !stopped) {
        stopped = true;
        expect((await fetch(`${h.url}/v1/chat/${runId}/stop`, { method: "POST", headers: A.H })).status).toBe(200);
      }
    });
    expect(fs.at(-1)!.data).toEqual({ type: "done", reason: "stopped" });
    // Legacy model listing accepts provider=gemini (-> google); without a Gemini key it errors cleanly with a message.
    const g = await fetch(h.url + "/v1/models?provider=gemini", { headers: { origin: ORIGIN } });
    const gj = await g.json();
    bodies.push(JSON.stringify(gj));
    expect(g.status).toBeGreaterThanOrEqual(400);
    expect(gj.error.message).toMatch(/gemini/i);
    expect(typeof gj.message).toBe("string");
  });

  it("never returns a provider key in any response body", () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const b of bodies) {
      expect(b).not.toContain(FAKE_KEY);
      expect(b).not.toContain(HEADER_KEY);
    }
  });
});

describe("bridge restart", () => {
  it("persists sessions across a bridge restart", async () => {
    const home = tmp("sai-home-");
    const ws = tmp("sai-ws-");
    const h1 = await start(home, ws);
    const A1 = api(h1);
    const sid = await A1.session();
    const fs = await readSse(await A1.send(sid, "scenario:text"));
    expect(types(fs).at(-1)).toBe("session.idle");
    const usage = (await A1.call("GET", `/v1/sessions/${sid}`)).json.session.usage;
    const token = h1.token;
    await h1.close();

    const h2 = await start(home, ws);
    try {
      expect(h2.token).toBe(token);
      const A2 = api(h2);
      const list = (await A2.call("GET", "/v1/sessions")).json.sessions;
      const s = list.find((x: any) => x.id === sid);
      expect(s).toBeTruthy();
      expect(s.usage).toEqual(usage);
      // The OpenCode session also survived (fake persists under XDG_DATA_HOME), so a new turn works.
      const fs2 = await readSse(await A2.send(sid, "scenario:text again"));
      expect(types(fs2).at(-1)).toBe("session.idle");
    } finally {
      await h2.close();
    }
  }, 30000);
});
