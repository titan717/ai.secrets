#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible LLM for the secrets-mcp + real OpenCode test.
 * Turn 1: records the tool names OpenCode offers, calls secrets_read_conversation.
 * Turn 2: calls secrets_draft_message (permission "ask"). Turn 3: replies "DONE".
 * GET /seen returns { tools: string[] } from the first tool-bearing request.
 * Env: MOCK_CONV_ID. Prints MOCK_LLM_PORT=<port>.
 */
import http from "node:http";

const enc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta, finish = null) => enc({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] });
const conv = process.env.MOCK_CONV_ID ?? "x";
let seen = [];

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/seen") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tools: seen }));
      }
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
      }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!body.tools) {
        res.write(chunk({ role: "assistant", content: "Mock title" }));
        res.write(chunk({}, "stop"));
        return res.end("data: [DONE]\n\n");
      }
      if (!seen.length) seen = body.tools.map((t) => t.function?.name ?? t.name);
      const results = (body.messages ?? []).filter((m) => m.role === "tool").length;
      const call = (id, name, args) => chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      if (results === 0) res.write(call("call_1", "secrets_read_conversation", { conversationId: conv, limit: 2 }));
      else if (results === 1) res.write(call("call_2", "secrets_draft_message", { conversationId: conv, text: "draft text" }));
      if (results < 2) {
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "DONE" }));
        res.write(chunk({}, "stop"));
      }
      res.write(enc({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      res.end("data: [DONE]\n\n");
    });
  })
  .listen(0, "127.0.0.1", function () {
    process.stdout.write(`MOCK_LLM_PORT=${this.address().port}\n`);
  });
