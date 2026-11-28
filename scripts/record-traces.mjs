#!/usr/bin/env node
/**
 * Records REAL `opencode serve` SSE traces for the test fixtures.
 * Drives OpenCode with the scripted mock LLM (tests/fixtures/mock-llm.mjs), so no API key is needed.
 *
 *   node scripts/record-traces.mjs            # writes tests/fixtures/traces/*.jsonl
 *
 * Each line of a trace is one raw OpenCode event ({ id, type, properties }).
 * Noise events unrelated to a chat turn (plugin.added, catalog.updated, ...) are dropped.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "fixtures", "traces");
mkdirSync(outDir, { recursive: true });
const NOISE = new Set(["plugin.added", "catalog.updated", "integration.updated", "integration.connection.updated", "reference.updated", "server.heartbeat", "file.watcher.updated", "lsp.updated", "mcp.tools.changed", "project.updated", "vcs.branch.updated"]);
const bin = process.env.OPENCODE_BIN || "opencode";
const password = "rec-" + Math.random().toString(36).slice(2);
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

function waitLine(child, re) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const on = (d) => { buf += d; const m = re.exec(buf); if (m) { child.stdout.off("data", on); resolve(m); } };
    child.stdout.on("data", on);
    child.once("exit", (c) => reject(new Error(`exited ${c}: ${buf}`)));
  });
}

const work = mkdtempSync(join(tmpdir(), "oc-rec-"));
writeFileSync(join(work, "a.txt"), "hello\n");
const llm = spawn(process.execPath, [join(here, "..", "tests", "fixtures", "mock-llm.mjs"), "0"], { env: { ...process.env, MOCK_DIR: work }, stdio: ["ignore", "pipe", "inherit"] });
const llmPort = (await waitLine(llm, /MOCK_LLM_PORT=(\d+)/))[1];
writeFileSync(join(work, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: "x" }, models: { "mock-1": { name: "Mock 1", tool_call: true, reasoning: true } } } },
  model: "mock/mock-1", small_model: "mock/mock-1",
  permission: { edit: "ask", bash: "ask", read: "allow", question: "allow" },
}, null, 2));
const oc = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd: work, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: ["ignore", "pipe", "inherit"] });
const base = (await waitLine(oc, /listening on (http:\/\/[\d.:]+)/))[1];
const api = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init.headers ?? {}) } });

const events = [];
const ctrl = new AbortController();
(async () => {
  const res = await api("/event", { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (data) try { events.push(JSON.parse(data)); } catch {}
      }
    }
  } catch {}
})();
await new Promise((r) => setTimeout(r, 500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } throw new Error("timeout"); }

async function scenario(name, opts = {}) {
  const start = events.length;
  const ses = await (await api("/session", { method: "POST", body: JSON.stringify({ title: name }) })).json();
  const r = await api(`/session/${ses.id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: `scenario:${opts.scenario ?? name}` }] }) });
  if (!r.ok) throw new Error(`prompt ${r.status} ${await r.text()}`);
  if (opts.onPermission) {
    const p = await until(() => events.slice(start).find((e) => e.type === "permission.asked" && e.properties.sessionID === ses.id));
    await api(`/permission/${p.properties.id}/reply`, { method: "POST", body: JSON.stringify({ reply: opts.onPermission }) });
  }
  if (opts.onQuestion) {
    const q = await until(() => events.slice(start).find((e) => e.type === "question.asked" && e.properties.sessionID === ses.id));
    await api(`/question/${q.properties.id}/reply`, { method: "POST", body: JSON.stringify({ answers: [[opts.onQuestion]] }) });
  }
  if (opts.abortAfterMs) { await sleep(opts.abortAfterMs); await api(`/session/${ses.id}/abort`, { method: "POST" }); }
  await until(() => events.slice(start).some((e) => e.type === "session.idle" && e.properties.sessionID === ses.id), 30000);
  await sleep(400);
  const trace = events.slice(start).filter((e) => !NOISE.has(e.type) && (!e.properties?.sessionID || e.properties.sessionID === ses.id));
  writeFileSync(join(outDir, `${name}.jsonl`), trace.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`${name}: ${trace.length} events -> ${[...new Set(trace.map((e) => e.type))].join(", ")}`);
}

try {
  await scenario("text");
  await scenario("basic", { onPermission: "once" });
  await scenario("deny", { scenario: "basic", onPermission: "reject" });
  await scenario("question", { onQuestion: "Blue" });
  await scenario("error");
  await scenario("abort", { scenario: "slow", abortAfterMs: 1500 });
} finally {
  ctrl.abort(); oc.kill("SIGTERM"); llm.kill("SIGTERM");
}
process.exit(0);
