import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeClient, OpenCodeHttpError, RECONNECT_EVENT, parseSse, type RawEvent } from "../../src/opencode/client.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
async function collect<T>(it: AsyncIterable<T>, n = Infinity): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

describe("parseSse", () => {
  it("parses frames split across chunks, CRLF, comments and multi-line data", async () => {
    const s = streamOf(['data: {"a"', ":1}\n\n: ping\n\n", "id: 3\r\nevent: x\r\ndata: line1\r\ndata: line2\r\n\r\n", 'data:{"b":2}\n\n', "data: trailing-no-terminator"]);
    expect(await collect(parseSse(s))).toEqual(['{"a":1}', "line1\nline2", '{"b":2}']);
  });

  it("handles a multi-byte UTF-8 character split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"héllo"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    expect(await collect(parseSse(s))).toEqual(['{"t":"héllo"}']);
  });
});

describe("OpenCodeClient", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });
  const listen = (handler: http.RequestListener) =>
    new Promise<string>((resolve) => {
      server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });

  it("sends Basic auth and JSON bodies, and maps routes", async () => {
    const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        if (req.url === "/session/ses_1/prompt_async") {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url === "/global/health" ? '{"healthy":true,"version":"1.19.6"}' : "true");
      });
    });
    const c = new OpenCodeClient({ baseUrl: url + "/", password: "pw" });
    expect(await c.health()).toEqual({ healthy: true, version: "1.19.6" });
    await c.promptAsync("ses_1", { parts: [{ type: "text", text: "hi" }], model: { providerID: "openrouter", modelID: "openai/gpt-5-mini" }, agent: "build", variant: "low" });
    await c.replyPermission("per_1", "always");
    await c.replyQuestion("que_1", [["Blue"]]);
    await c.rejectQuestion("que_2");
    await c.setAuth("openrouter", "k");
    await c.deleteAuth("openrouter");
    await c.abort("ses_1");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /global/health",
      "POST /session/ses_1/prompt_async",
      "POST /permission/per_1/reply",
      "POST /question/que_1/reply",
      "POST /question/que_2/reject",
      "PUT /auth/openrouter",
      "DELETE /auth/openrouter",
      "POST /session/ses_1/abort",
    ]);
    expect(seen.every((s) => s.auth === "Basic " + Buffer.from("opencode:pw").toString("base64"))).toBe(true);
    expect(JSON.parse(seen[1]!.body)).toEqual({ parts: [{ type: "text", text: "hi" }], model: { providerID: "openrouter", modelID: "openai/gpt-5-mini" }, agent: "build", variant: "low" });
    expect(JSON.parse(seen[2]!.body)).toEqual({ reply: "always" });
    expect(JSON.parse(seen[3]!.body)).toEqual({ answers: [["Blue"]] });
    expect(JSON.parse(seen[5]!.body)).toEqual({ type: "api", key: "k" });
  });

  it("throws OpenCodeHttpError with status and a redacted body on failures", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401);
      res.end("bad key sk-or-v1-0123456789abcdef");
    });
    const c = new OpenCodeClient({ baseUrl: url, password: "pw" });
    const err = (await c.listSessions().catch((e) => e)) as OpenCodeHttpError;
    expect(err).toBeInstanceOf(OpenCodeHttpError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("0123456789abcdef");
  });

  it("events() parses the stream, reconnects with a marker, and stops on abort", async () => {
    let conns = 0;
    const url = await listen((req, res) => {
      expect(req.url).toBe("/event");
      conns++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      if (conns === 1) {
        res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "s1" } })}\n\ndata: not json\n\n`);
        setTimeout(() => res.destroy(), 20);
      } else if (conns === 2) {
        res.write(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "s2" } })}\n\n`);
      }
    });
    const c = new OpenCodeClient({ baseUrl: url, password: "pw" });
    const ctrl = new AbortController();
    const got: RawEvent[] = [];
    for await (const ev of c.events({ signal: ctrl.signal, backoffMs: 10 })) {
      got.push(ev);
      if (got.length === 5) ctrl.abort();
    }
    expect(got.map((e) => e.type)).toEqual(["server.connected", "session.idle", RECONNECT_EVENT, "server.connected", "session.idle"]);
    expect(got[4]!.properties.sessionID).toBe("s2");
    expect(conns).toBe(2);
  });

  it("events() keeps retrying while the server is down", async () => {
    const c = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", password: "pw" });
    const ctrl = new AbortController();
    let errors = 0;
    const it = c.events({ signal: ctrl.signal, backoffMs: 5, maxBackoffMs: 10, onError: () => (++errors >= 3 ? ctrl.abort() : undefined) });
    expect(await collect(it)).toEqual([]);
    expect(errors).toBeGreaterThanOrEqual(3);
  });
});
