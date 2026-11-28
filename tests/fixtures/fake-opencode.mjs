#!/usr/bin/env node
/**
 * Fake `opencode serve` for offline tests. Speaks the subset of the OpenCode 1.19.6 HTTP API the bridge
 * uses and, on prompt_async, REPLAYS a real recorded trace from tests/fixtures/traces/*.jsonl.
 *
 *   node fake-opencode.mjs serve --port 0 --hostname 127.0.0.1
 *
 * - Prints "opencode server listening on http://127.0.0.1:<port>" on stdout (same as the real binary).
 * - OPENCODE_SERVER_PASSWORD enables Basic auth (user "opencode" or $OPENCODE_SERVER_USERNAME) on every route.
 * - Scenario = "scenario:<name>" in the prompt text (text|basic|deny|question|error|abort|slow), default "text".
 * - Playback pauses after permission.asked / question.asked until the reply route is called. Rejecting the
 *   basic scenario's permission continues with deny.jsonl. "abort"/"slow" stream a few ticks and wait for abort.
 * - IDs (msg_/prt_/per_/que_/call_) are suffixed per replay so repeated prompts never collide.
 * - FAKE_OPENCODE_CRASH_AFTER_MS=<ms> exits(1) after that long (supervisor restart tests).
 * - FAKE_OPENCODE_DELAY_MS=<ms> delay between replayed events (default 2).
 * - FAKE_OPENCODE_ECHO_SECRETS=1 prints the provider key and password to stderr (redaction tests).
 * - FAKE_OPENCODE_IGNORE_SIGTERM=1 ignores SIGTERM (SIGKILL fallback tests).
 * - GET /__fake/info returns env var NAMES, cwd, config path and auth provider ids (test introspection).
 */
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const TRACES = join(here, "traces");
const args = process.argv.slice(2);
if (args[0] !== "serve") {
  if (args.includes("--version")) {
    process.stdout.write("1.19.6-fake\n");
    process.exit(0);
  }
  process.stderr.write("usage: fake-opencode serve --port N --hostname H\n");
  process.exit(2);
}
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const port = Number(argVal("--port", "0"));
const hostname = argVal("--hostname", "127.0.0.1");
const password = process.env.OPENCODE_SERVER_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const expectedAuth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : null;
const DELAY = Number(process.env.FAKE_OPENCODE_DELAY_MS ?? 2);
const VERSION = "1.19.6";

const rid = (p) => `${p}_${Date.now().toString(16)}${randomBytes(6).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadTrace = (name) =>
  readFileSync(join(TRACES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ---------- state ----------
const dataDir = join(process.env.XDG_DATA_HOME || join(process.cwd(), ".fake-opencode"), "fake-opencode");
const sessionsFile = join(dataDir, "sessions.json");
/** @type {Map<string, any>} */
const sessions = new Map();
try {
  if (existsSync(sessionsFile)) for (const s of JSON.parse(readFileSync(sessionsFile, "utf8"))) sessions.set(s.id, s);
} catch {}
const persist = () => {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(sessionsFile, JSON.stringify([...sessions.values()]));
  } catch {}
};
const messages = new Map(); // sessionID -> Map<msgID,{info,parts:Map}>
const status = new Map(); // sessionID -> {type}
const pendingPermissions = new Map(); // id -> {req, resolve}
const pendingQuestions = new Map();
const runs = new Map(); // sessionID -> {aborted, wake}
const authProviders = new Map();
const clients = new Set();

function broadcast(ev) {
  const e = { id: ev.id ?? rid("evt"), type: ev.type, properties: ev.properties };
  const p = e.properties;
  // track history for GET /session/:id/message
  if (e.type === "message.updated" && p.info?.id) {
    const m = messages.get(p.sessionID) ?? new Map();
    messages.set(p.sessionID, m);
    const cur = m.get(p.info.id) ?? { info: p.info, parts: new Map() };
    cur.info = p.info;
    m.set(p.info.id, cur);
  } else if (e.type === "message.part.updated" && p.part?.messageID) {
    const m = messages.get(p.sessionID) ?? new Map();
    messages.set(p.sessionID, m);
    const cur = m.get(p.part.messageID) ?? { info: { id: p.part.messageID, sessionID: p.sessionID, role: "assistant" }, parts: new Map() };
    cur.parts.set(p.part.id, p.part);
    m.set(p.part.messageID, cur);
  } else if (e.type === "session.status") {
    status.set(p.sessionID, p.status);
  }
  const frame = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(frame);
}

// ---------- replay ----------
let replayCounter = 0;
function rewriter(fromSession, toSession, suffix, idMap = {}) {
  return (ev) => {
    let s = JSON.stringify(ev);
    for (const [a, b] of Object.entries(idMap)) s = s.split(a).join(b);
    s = s.split(fromSession).join(toSession);
    s = s.replace(/\b(msg|prt|per|que|evt)_([A-Za-z0-9]+)/g, `$1_$2${suffix}`);
    s = s.replace(/"(call_[A-Za-z0-9]+)"/g, `"$1_${suffix}"`);
    return JSON.parse(s);
  };
}
const traceSession = (trace) => trace.find((e) => e.properties?.sessionID)?.properties.sessionID;

async function emitAll(run, list, rw) {
  for (const raw of list) {
    if (run.aborted) return "aborted";
    if (raw.type === "session.created") continue;
    const ev = rw(raw);
    if (ev.type === "permission.replied" && run.lastReply) ev.properties.reply = run.lastReply;
    if (ev.type === "question.replied" && run.lastAnswers) ev.properties.answers = run.lastAnswers;
    let waiter = null;
    if (ev.type === "permission.asked" || ev.type === "question.asked") {
      const map = ev.type === "permission.asked" ? pendingPermissions : pendingQuestions;
      // Register before broadcasting so a fast reply never races the pending entry.
      waiter = new Promise((resolve) => {
        map.set(ev.properties.id, { req: ev.properties, resolve });
        run.wake = () => resolve("__abort__");
      });
    }
    broadcast(ev);
    if (DELAY) await sleep(DELAY);
    if (ev.type === "permission.asked") {
      const reply = await waiter;
      if (reply === "__abort__" || run.aborted) return "aborted";
      run.lastReply = reply;
      if (reply === "reject" && run.onReject) return run.onReject(ev);
    }
    if (ev.type === "question.asked") {
      const ans = await waiter;
      if (ans === "__abort__" || run.aborted) return "aborted";
      if (ans === "__reject__") {
        broadcast({ type: "question.rejected", properties: { sessionID: ev.properties.sessionID, requestID: ev.properties.id } });
        return "idle";
      }
      run.lastAnswers = ans;
    }
  }
  return "done";
}

function endTurn(sessionID) {
  broadcast({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
  broadcast({ type: "session.idle", properties: { sessionID } });
}

async function replay(sessionID, text) {
  const scenario = /scenario:(\w+)/.exec(text)?.[1] ?? "text";
  const suffix = `r${++replayCounter}`;
  const run = { aborted: false, wake: null, lastReply: null, lastAnswers: null, onReject: null };
  runs.set(sessionID, run);
  let result;
  try {
    if (scenario === "abort" || scenario === "slow") {
      const t = loadTrace("abort");
      const rw = rewriter(traceSession(t), sessionID, suffix);
      const cut = t.findIndex((e) => e.type === "session.error");
      result = await emitAll(run, t.slice(0, cut), rw);
      if (result !== "aborted") {
        await new Promise((resolve) => {
          run.wake = resolve;
          if (run.aborted) resolve();
        });
        result = "aborted";
      }
    } else {
      const name = ["text", "basic", "deny", "question", "error"].includes(scenario) ? (scenario === "deny" ? "basic" : scenario) : "text";
      const t = loadTrace(name);
      const rw = rewriter(traceSession(t), sessionID, suffix);
      if (name === "basic") {
        run.onReject = async (askedEv) => {
          // continue with the recorded deny trace after its permission.asked
          const d = loadTrace("deny");
          const i = d.findIndex((e) => e.type === "permission.asked");
          const askedOrig = askedEv.properties.id.slice(0, -suffix.length);
          const rwd = rewriter(traceSession(d), sessionID, suffix, { [d[i].properties.id]: askedOrig });
          return emitAll({ ...run, onReject: null, get aborted() { return run.aborted; } }, d.slice(i + 1), rwd);
        };
      }
      result = await emitAll(run, t, rw);
    }
  } catch (e) {
    process.stderr.write(`fake-opencode replay failed: ${e?.stack ?? e}\n`);
    result = "idle";
  }
  if (result === "aborted") {
    for (const [id, p] of pendingPermissions) if (p.req.sessionID === sessionID) pendingPermissions.delete(id);
    for (const [id, q] of pendingQuestions) if (q.req.sessionID === sessionID) pendingQuestions.delete(id);
    broadcast({ type: "session.error", properties: { sessionID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
    endTurn(sessionID);
  } else if (result === "idle") {
    endTurn(sessionID);
  }
  if (runs.get(sessionID) === run) runs.delete(sessionID);
}

// ---------- http ----------
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });

function readConfig() {
  try {
    return process.env.OPENCODE_CONFIG ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, "utf8")) : {};
  } catch {
    return {};
  }
}

function providersPayload() {
  const variants = (names) => Object.fromEntries(names.map((n) => [n, {}]));
  const model = (id, name, v = []) => ({ id, name, capabilities: { toolcall: true, reasoning: v.length > 0 }, cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 }, variants: variants(v) });
  const providers = [
    { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: { "openai/gpt-5-mini": model("openai/gpt-5-mini", "GPT-5 mini", ["minimal", "low", "medium", "high"]), "openrouter/free": model("openrouter/free", "Free router") } },
    { id: "google", name: "Google", env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], models: { "gemini-2.5-flash": model("gemini-2.5-flash", "Gemini 2.5 Flash", ["low", "high"]) } },
  ];
  // Real OpenCode 1.19.6 returns env-sourced RAW keys in `key`; mimic it so leak tests are meaningful.
  if (process.env.OPENROUTER_API_KEY) providers[0].key = process.env.OPENROUTER_API_KEY;
  if (process.env.GEMINI_API_KEY) providers[1].key = process.env.GEMINI_API_KEY;
  const cfg = readConfig();
  for (const [id, p] of Object.entries(cfg.provider ?? {})) {
    if (providers.some((x) => x.id === id) || !p?.models) continue;
    providers.push({ id, name: p.name ?? id, env: [], models: Object.fromEntries(Object.entries(p.models).map(([mid, m]) => [mid, model(mid, m.name ?? mid)])) });
  }
  return { providers, default: { openrouter: "openrouter/free" } };
}

const server = http.createServer(async (req, res) => {
  if (expectedAuth && req.headers.authorization !== expectedAuth) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="opencode"' });
    return res.end("Unauthorized");
  }
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  const at = (...segs) => segs.length === parts.length && segs.every((s, i) => s === "*" || s === parts[i]);

  if (m === "GET" && at("global", "health")) return json(res, 200, { healthy: true, version: VERSION });
  if (m === "GET" && at("doc")) return json(res, 200, { openapi: "3.1.0", info: { title: "fake-opencode", version: VERSION }, paths: {} });
  if (m === "GET" && at("__fake", "info"))
    return json(res, 200, {
      pid: process.pid,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env).sort(),
      xdg: { config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.XDG_STATE_HOME, cache: process.env.XDG_CACHE_HOME },
      configPath: process.env.OPENCODE_CONFIG ?? null,
      config: readConfig(),
      authProviders: [...authProviders.keys()],
    });
  if (m === "GET" && at("event")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ id: rid("evt"), type: "server.connected", properties: {} })}\n\n`);
    clients.add(res);
    const hb = setInterval(() => res.write(`data: ${JSON.stringify({ id: rid("evt"), type: "server.heartbeat", properties: {} })}\n\n`), 10000);
    req.on("close", () => {
      clearInterval(hb);
      clients.delete(res);
    });
    return;
  }
  if (at("session") && m === "GET") return json(res, 200, [...sessions.values()]);
  if (at("session") && m === "POST") {
    const body = (await readBody(req)) ?? {};
    const now = Date.now();
    const s = { id: rid("ses"), slug: "fake", version: VERSION, projectID: "global", directory: process.cwd(), title: body.title || "New session", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now } };
    sessions.set(s.id, s);
    persist();
    broadcast({ type: "session.created", properties: { sessionID: s.id, info: s } });
    return json(res, 200, s);
  }
  if (at("session", "status") && m === "GET") {
    const out = {};
    for (const [id, st] of status) if (st.type !== "idle") out[id] = st;
    return json(res, 200, out);
  }
  if (parts[0] === "session" && parts.length >= 2) {
    const s = sessions.get(parts[1]);
    if (!s) return json(res, 404, { name: "NotFoundError", data: { message: `Session not found: ${parts[1]}` } });
    if (parts.length === 2) {
      if (m === "GET") return json(res, 200, s);
      if (m === "DELETE") {
        sessions.delete(s.id);
        persist();
        broadcast({ type: "session.deleted", properties: { sessionID: s.id, info: s } });
        return json(res, 200, true);
      }
      if (m === "PATCH") {
        const body = (await readBody(req)) ?? {};
        if (body.title) s.title = body.title;
        persist();
        return json(res, 200, s);
      }
    }
    if (at("session", "*", "prompt_async") && m === "POST") {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.parts)) return json(res, 400, { name: "BadRequest", data: { message: "parts required" } });
      if (runs.has(s.id)) return json(res, 400, { name: "BusyError", data: { message: "session is busy" } });
      const text = body.parts.map((p) => p.text ?? "").join("\n");
      res.writeHead(204);
      res.end();
      void replay(s.id, text);
      return;
    }
    if (at("session", "*", "abort") && m === "POST") {
      const run = runs.get(s.id);
      if (run) {
        run.aborted = true;
        run.wake?.();
      }
      return json(res, 200, true);
    }
    if (at("session", "*", "message") && m === "GET") {
      const mm = messages.get(s.id) ?? new Map();
      return json(res, 200, [...mm.values()].map((x) => ({ info: x.info, parts: [...x.parts.values()] })));
    }
  }
  if (at("permission") && m === "GET") return json(res, 200, [...pendingPermissions.values()].map((p) => p.req));
  if (at("permission", "*", "reply") && m === "POST") {
    const p = pendingPermissions.get(parts[1]);
    const body = await readBody(req);
    if (!body || !["once", "always", "reject"].includes(body.reply)) return json(res, 400, { name: "BadRequest", data: { message: "invalid reply" } });
    if (!p) return json(res, 404, { name: "NotFoundError", data: { message: "permission not found" } });
    pendingPermissions.delete(parts[1]);
    p.resolve(body.reply);
    return json(res, 200, true);
  }
  if (at("question") && m === "GET") return json(res, 200, [...pendingQuestions.values()].map((q) => q.req));
  if (at("question", "*", "reply") && m === "POST") {
    const q = pendingQuestions.get(parts[1]);
    const body = await readBody(req);
    if (!body || !Array.isArray(body.answers)) return json(res, 400, { name: "BadRequest", data: { message: "answers required" } });
    if (!q) return json(res, 404, { name: "NotFoundError", data: { message: "question not found" } });
    pendingQuestions.delete(parts[1]);
    q.resolve(body.answers);
    return json(res, 200, true);
  }
  if (at("question", "*", "reject") && m === "POST") {
    const q = pendingQuestions.get(parts[1]);
    if (!q) return json(res, 404, { name: "NotFoundError", data: { message: "question not found" } });
    pendingQuestions.delete(parts[1]);
    q.resolve("__reject__");
    return json(res, 200, true);
  }
  if (at("config", "providers") && m === "GET") return json(res, 200, providersPayload());
  if (at("config") && m === "GET") return json(res, 200, readConfig());
  if (at("auth", "*") && m === "PUT") {
    const body = await readBody(req);
    if (!body || body.type !== "api" || typeof body.key !== "string") return json(res, 400, { name: "BadRequest", data: { message: "invalid auth" } });
    authProviders.set(parts[1], body.key);
    return json(res, 200, true);
  }
  if (at("auth", "*") && m === "DELETE") {
    authProviders.delete(parts[1]);
    return json(res, 200, true);
  }
  json(res, 404, { name: "NotFoundError", data: { message: `no route ${m} ${url.pathname}` } });
});

server.listen(port, hostname, () => {
  const a = server.address();
  process.stdout.write(`opencode server listening on http://${hostname}:${a.port}\n`);
  if (!password) process.stderr.write("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n");
  // Simulates a chatty child that leaks secrets into its logs; the supervisor must redact them.
  if (process.env.FAKE_OPENCODE_ECHO_SECRETS === "1")
    process.stderr.write(`debug provider key=${process.env.OPENROUTER_API_KEY ?? ""} raw ${process.env.OPENROUTER_API_KEY ?? ""} password ${password ?? ""}\n`);
});

const crashMs = Number(process.env.FAKE_OPENCODE_CRASH_AFTER_MS ?? 0);
if (crashMs > 0)
  setTimeout(() => {
    process.stderr.write("fake-opencode: simulated crash\n");
    process.exit(1);
  }, crashMs);

const shutdown = () => {
  for (const c of clients) c.end();
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.env.FAKE_OPENCODE_IGNORE_SIGTERM === "1") process.removeAllListeners("SIGTERM").on("SIGTERM", () => {});
