#!/usr/bin/env node
/**
 * Fake `opencode serve` binary for integration & E2E tests.
 * Supports: `serve --port <port> --hostname <host>`
 * Replays recorded OpenCode SSE events on `GET /event` when `POST /session/:id/prompt` is called.
 */
import http from "node:http";

const args = process.argv.slice(2);
let port = 4096;
let hostname = "127.0.0.1";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
  if (args[i] === "--hostname" && args[i + 1]) hostname = args[++i];
}

const sessions = new Map();
const sseClients = new Set();
const pendingPermissions = new Map();

function broadcast(type, properties) {
  const payload = `event: message\ndata: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) {
    if (!res.writableEnded) res.write(payload);
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${hostname}:${port}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/doc") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ openapi: "3.1.0", info: { title: "Fake OpenCode", version: "0.0.0-test" } }));
    return;
  }

  if (req.method === "GET" && path === "/event") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: message\ndata: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && path === "/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([...sessions.values()]));
    return;
  }

  if (req.method === "POST" && path === "/session") {
    const body = await readJson(req);
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const session = { id, title: body.title || "Test Session", directory: body.location?.directory || process.cwd() };
    sessions.set(id, session);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(session));
    return;
  }

  const promptMatch = /^\/session\/([^/]+)\/prompt$/.exec(path);
  if (req.method === "POST" && promptMatch) {
    const sessionId = decodeURIComponent(promptMatch[1]);
    const body = await readJson(req);
    const text = String(body.text || "");

    if (text.includes("__crash__")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(1), 20);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    setTimeout(async () => {
      broadcast("message.part.delta", {
        sessionID: sessionId,
        part: { type: "reasoning", delta: "Thinking about request..." },
      });
      broadcast("part.updated", {
        sessionID: sessionId,
        part: { type: "tool", callID: "call_1", tool: "read_file", state: { status: "running", input: { path: "README.md" } } },
      });
      broadcast("part.updated", {
        sessionID: sessionId,
        part: { type: "tool", callID: "call_1", tool: "read_file", state: { status: "completed", output: "ok" } },
      });

      if (text.includes("permission") || text.includes("write")) {
        const permId = `perm_${Date.now().toString(36)}`;
        const decisionPromise = new Promise((resolve) => pendingPermissions.set(permId, resolve));
        broadcast("permission.asked", {
          sessionID: sessionId,
          id: permId,
          permission: "edit",
          patterns: ["README.md"],
        });
        const decision = await decisionPromise;
        broadcast("message.part.delta", {
          sessionID: sessionId,
          part: { type: "text", delta: `Permission ${decision}. Done.` },
        });
      } else {
        broadcast("message.part.delta", {
          sessionID: sessionId,
          part: { type: "text", delta: `Echo: ${text}` },
        });
      }

      broadcast("message.updated", {
        sessionID: sessionId,
        info: { tokens: { input: 12, output: 8 }, cost: 0.0001 },
      });
      broadcast("session.idle", { sessionID: sessionId });
    }, 20);
    return;
  }

  const permMatch = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(path);
  if (req.method === "POST" && permMatch) {
    const permId = decodeURIComponent(permMatch[2]);
    const body = await readJson(req);
    const resolve = pendingPermissions.get(permId);
    if (resolve) {
      pendingPermissions.delete(permId);
      resolve(body.response || "once");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(true));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
    return;
  }

  const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(path);
  if (req.method === "POST" && abortMatch) {
    const sessionId = decodeURIComponent(abortMatch[1]);
    broadcast("session.idle", { sessionID: sessionId });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(true));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, hostname, () => {
  // Ready
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
