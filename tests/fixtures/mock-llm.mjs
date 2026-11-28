#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible LLM used to drive a REAL `opencode serve` in tests.
 * The scenario is picked from the first user message: "scenario:<name>".
 *   basic    -> reasoning + text + read tool, then bash tool (needs permission), then "DONE"
 *   question -> calls the `question` tool, then echoes the answer
 *   error    -> responds 401 (provider auth error)
 *   slow     -> streams one token every 500ms (for abort tests)
 *   text     -> plain "Hello world" reply (default)
 * Usage: node mock-llm.mjs [port]   (prints "MOCK_LLM_PORT=<port>" on stdout once listening)
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const enc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta, finish = null) => enc({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = enc({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const toolCall = (id, name, args) => chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

function textOf(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) return m.content.map((c) => c.text ?? "").join("");
  return "";
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
    }
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const msgs = body.messages ?? [];
    const userText = msgs.filter((m) => m.role === "user").map(textOf).join("\n");
    const scenario = /scenario:(\w+)/.exec(userText)?.[1] ?? "text";
    const toolResults = msgs.filter((m) => m.role === "tool");
    // Title / summary generation requests have no tools.
    if (!body.tools) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "Mock title" }));
      res.write(chunk({}, "stop"));
      return res.end("data: [DONE]\n\n");
    }
    if (scenario === "error") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid API key (mock)", type: "invalid_request_error", code: 401 } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const dir = process.env.MOCK_DIR ?? process.cwd();
    if (scenario === "basic") {
      if (toolResults.length === 0) {
        res.write(chunk({ role: "assistant", reasoning_content: "Thinking about reading." }));
        res.write(chunk({ content: "Reading file." }));
        res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: `${dir}/a.txt` }) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else if (toolResults.length === 1) {
        res.write(toolCall("call_2", "bash", { command: "echo hi > b.txt", description: "Write b.txt" }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "DO" }));
        res.write(chunk({ content: "NE" }));
        res.write(chunk({}, "stop"));
      }
    } else if (scenario === "question") {
      if (toolResults.length === 0) {
        res.write(toolCall("call_q", "question", { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: `Answer noted: ${textOf(toolResults[0]).slice(0, 120)}` }));
        res.write(chunk({}, "stop"));
      }
    } else if (scenario === "slow") {
      for (let i = 0; i < 60 && !res.destroyed; i++) {
        res.write(chunk({ role: "assistant", content: `tick${i} ` }));
        await new Promise((r) => setTimeout(r, 500));
      }
      res.write(chunk({}, "stop"));
    } else {
      res.write(chunk({ role: "assistant", content: "Hello" }));
      res.write(chunk({ content: " world" }));
      res.write(chunk({}, "stop"));
    }
    if (!res.destroyed) {
      res.write(usage);
      res.end("data: [DONE]\n\n");
    }
  });
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`MOCK_LLM_PORT=${server.address().port}\n`);
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));
