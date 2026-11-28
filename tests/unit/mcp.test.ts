import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startStubApi } from "../fixtures/mcp/stub-secrets-api.mjs";
import { createServer, ERR, SUPPORTED_VERSIONS } from "../../src/mcp/secrets-mcp.js";

const TOKEN = "sai_" + "T".repeat(40);
const ENTRY = fileURLToPath(new URL("../../src/mcp/secrets-mcp.ts", import.meta.url));
const DIST = fileURLToPath(new URL("../../dist/mcp/secrets-mcp.js", import.meta.url));
const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } };

let api: Awaited<ReturnType<typeof startStubApi>>;
beforeAll(async () => {
  api = await startStubApi({ token: TOKEN });
});
afterAll(async () => {
  await api?.close();
});

/** Spawned stdio client (the real process, run through tsx). */
class Client {
  proc: ChildProcessWithoutNullStreams;
  stderr = "";
  stdout = "";
  private pending = new Map<unknown, (m: any) => void>();
  private nextId = 1;
  lines: any[] = [];
  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, ["--import", "tsx", ENTRY], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.proc.stdout.setEncoding("utf8").on("data", (d: string) => {
      this.stdout += d;
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        this.lines.push(m);
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      }
    });
    this.proc.stderr.setEncoding("utf8").on("data", (d: string) => (this.stderr += d));
  }
  raw(line: string) {
    this.proc.stdin.write(line + "\n");
  }
  request(method: string, params?: unknown, id: unknown = this.nextId++): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }
  notify(method: string, params?: unknown) {
    this.raw(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }));
  }
  async init(version = "2025-06-18") {
    const r = await this.request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    this.notify("notifications/initialized");
    return r;
  }
  close() {
    this.proc.stdin.end();
    return new Promise<number | null>((r) => this.proc.once("exit", (c) => r(c)));
  }
}

const env = () => ({ SECRETS_API_URL: api.url, SECRETS_TOKEN: TOKEN });
const call = (c: Client, name: string, args: unknown) => c.request("tools/call", { name, arguments: args });

describe("secrets-mcp over stdio (legacy initialize)", () => {
  let c: Client;
  beforeAll(async () => {
    c = new Client(env());
  });
  afterAll(async () => {
    await c.close();
  });

  it("negotiates the requested legacy version and advertises tools", async () => {
    const r = await c.init("2025-06-18");
    expect(r.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "secrets-mcp" } });
    expect(r.result.resultType).toBeUndefined();
  });

  it("tools/list returns the three tools with schemas and annotations", async () => {
    const r = await c.request("tools/list");
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["read_conversation", "summarize_dock_channel", "draft_message"]);
    for (const t of r.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    expect(r.result.tools[0].inputSchema.required).toEqual(["conversationId"]);
    expect(r.result.tools[2].inputSchema.required).toEqual(["conversationId", "text"]);
  });

  it("read_conversation returns chronological, named, non-deleted messages", async () => {
    const r = await call(c, "read_conversation", { conversationId: IDS.dm });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.conversation).toMatchObject({ id: IDS.dm, kind: "dm", members: ["Alice (@alice)", "@bob"] });
    expect(s.messages.map((m: any) => m.text)).toEqual(["hi bob", "hey! lunch?", "see photo"]);
    expect(s.messages[0].from).toBe("Alice (@alice)");
    expect(s.messages[2].attachments).toEqual(["pic.png"]);
    expect(JSON.parse(r.result.content[0].text)).toEqual(s);
    const last = api.requests.filter((q) => q.path.endsWith("/messages")).pop()!;
    expect(last.query.limit).toBe("50");
    expect(last.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("read_conversation pages past the API cap of 100", async () => {
    const before = api.requests.length;
    const r = await call(c, "read_conversation", { conversationId: IDS.channel, limit: 120 });
    const s = r.result.structuredContent;
    expect(s.messages).toHaveLength(120);
    expect(s.messages[0].text).toBe("channel message 31");
    expect(s.messages[119].text).toBe("channel message 150");
    const pages = api.requests.slice(before).filter((q) => q.path.endsWith("/messages"));
    expect(pages.map((p) => p.query.limit)).toEqual(["100", "20"]);
    expect(pages[1]!.query.before).toBeTruthy();
    expect(s.messages[0].from).toBe("Alice (@alice)"); // names from dock members for channels
  });

  it("summarize_dock_channel returns dock/channel context and instructions", async () => {
    const r = await call(c, "summarize_dock_channel", { channelId: IDS.channel, limit: 10 });
    const s = r.result.structuredContent;
    expect(s.dock).toEqual({ id: IDS.dock, name: "Team Dock", handle: "team" });
    expect(s.channel).toEqual({ id: IDS.channel, name: "general", topic: "Everything" });
    expect(s.messageCount).toBe(10);
    expect(s.participants.sort()).toEqual(["@bob", "Alice (@alice)"]);
    expect(s.period.from < s.period.to).toBe(true);
    expect(s.instructions).toMatch(/Summarize/);
  });

  it("summarize_dock_channel rejects a DM with a tool error", async () => {
    const r = await call(c, "summarize_dock_channel", { channelId: IDS.dm });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/not a dock channel/);
  });

  it("draft_message only drafts and never POSTs", async () => {
    const before = api.requests.length;
    const r = await call(c, "draft_message", { conversationId: IDS.dm, text: "Sounds good, 1pm?" });
    expect(r.result.structuredContent).toMatchObject({ draft: { conversationId: IDS.dm, text: "Sounds good, 1pm?" }, sent: false });
    const reqs = api.requests.slice(before);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((q) => q.method === "GET")).toBe(true);
  });

  it("argument validation errors are tool errors (isError), not protocol errors", async () => {
    for (const [name, args, re] of [
      ["read_conversation", {}, /conversationId is required/],
      ["read_conversation", { conversationId: IDS.dm, limit: 0 }, /limit must be an integer/],
      ["read_conversation", { conversationId: IDS.dm, limit: 201 }, /limit must be an integer/],
      ["draft_message", { conversationId: IDS.dm }, /text is required/],
    ] as const) {
      const r = await call(c, name, args);
      expect(r.error).toBeUndefined();
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(re);
    }
  });

  it("API errors become actionable tool errors", async () => {
    const r404 = await call(c, "read_conversation", { conversationId: "55555555-5555-4555-8555-555555555555" });
    expect(r404.result.isError).toBe(true);
    expect(r404.result.content[0].text).toMatch(/failed \(404\): not found/);
    const r403 = await call(c, "read_conversation", { conversationId: IDS.forbidden });
    expect(r403.result.content[0].text).toMatch(/403.*don't have access/);
  });

  it("protocol errors: unknown tool, bad arguments, unknown method, parse error, invalid request", async () => {
    expect((await call(c, "nope", {})).error).toMatchObject({ code: ERR.INVALID_PARAMS, message: "Unknown tool: nope" });
    expect((await c.request("tools/call", { name: "read_conversation", arguments: [1] })).error.code).toBe(ERR.INVALID_PARAMS);
    expect((await c.request("resources/list")).error.code).toBe(ERR.METHOD_NOT_FOUND);
    const n = c.lines.length;
    c.raw("{not json");
    c.raw(JSON.stringify([{ jsonrpc: "2.0", id: 99, method: "ping" }]));
    c.raw(JSON.stringify({ jsonrpc: "1.0", id: 98, method: "ping" }));
    await c.request("ping"); // flush
    const errs = c.lines.slice(n).filter((l) => l.error);
    expect(errs.map((e) => [e.id, e.error.code])).toEqual([
      [null, ERR.PARSE],
      [null, ERR.INVALID_REQUEST],
      [98, ERR.INVALID_REQUEST],
    ]);
  });

  it("notifications get no response and every stdout line is one JSON message", async () => {
    const n = c.lines.length;
    c.notify("notifications/cancelled", { requestId: 1 });
    c.notify("notifications/whatever");
    expect((await c.request("ping")).result).toEqual({});
    expect(c.lines.length).toBe(n + 1);
    for (const line of c.stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("never prints the token on stdout or stderr", () => {
    expect(c.stdout).not.toContain(TOKEN);
    expect(c.stderr).not.toContain(TOKEN);
  });
});

describe("secrets-mcp version negotiation", () => {
  it("unknown legacy version falls back to the latest legacy version", async () => {
    const c = new Client(env());
    expect((await c.init("2024-01-01")).result.protocolVersion).toBe("2025-11-25");
    await c.close();
  });

  it("modern clients: server/discover and per-request _meta", async () => {
    const c = new Client(env());
    const d = await c.request("server/discover", { _meta: MODERN_META });
    expect(d.result).toMatchObject({ resultType: "complete", supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, cacheScope: "public" });
    expect(d.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "secrets-mcp", version: "0.2.0" });
    const l = await c.request("tools/list", { _meta: MODERN_META });
    expect(l.result).toMatchObject({ resultType: "complete", ttlMs: 300000, cacheScope: "public" });
    const r = await c.request("tools/call", { _meta: MODERN_META, name: "read_conversation", arguments: { conversationId: IDS.dm, limit: 3 } });
    expect(r.result.resultType).toBe("complete");
    expect(r.result.structuredContent.messages).toHaveLength(2); // newest 3, one deleted
    await c.close();
  });

  it("unsupported modern version -> -32022 with supported list; missing meta -> -32602", async () => {
    const c = new Client(env());
    const r = await c.request("tools/list", { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    expect(r.error).toMatchObject({ code: -32022, message: "Unsupported protocol version", data: { supported: SUPPORTED_VERSIONS, requested: "1900-01-01" } });
    expect((await c.request("tools/list", {})).error.code).toBe(ERR.INVALID_PARAMS);
    const noCaps = await c.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    expect(noCaps.error.code).toBe(ERR.INVALID_PARAMS);
    await c.close();
  });
});

describe("secrets-mcp configuration errors", () => {
  it("missing env -> clear tool errors, no crash", async () => {
    const c = new Client({});
    await c.init();
    const r = await call(c, "read_conversation", { conversationId: IDS.dm });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/SECRETS_API_URL is not set/);
    await c.close();
  });
  it("bad token -> 401 hint, token never echoed", async () => {
    const bad = "sai_" + "B".repeat(40);
    const c = new Client({ SECRETS_API_URL: api.url, SECRETS_TOKEN: bad });
    await c.init();
    const r = await call(c, "read_conversation", { conversationId: IDS.dm });
    expect(r.result.content[0].text).toMatch(/401.*sign in to Secrets again/);
    await c.close();
    expect(c.stdout + c.stderr).not.toContain(bad);
  });
  it("unreachable API -> network tool error", async () => {
    const c = new Client({ SECRETS_API_URL: "http://127.0.0.1:9", SECRETS_TOKEN: TOKEN });
    await c.init();
    const r = await call(c, "read_conversation", { conversationId: IDS.dm });
    expect(r.result.content[0].text).toMatch(/Could not reach the Secrets API/);
    await c.close();
  });
});

describe("createServer (in-process)", () => {
  it("importing the module does not start a server, and createServer handles lines", async () => {
    const out: string[] = [];
    const s = createServer({ send: (l) => out.push(l), env: {} });
    await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
    await s.handleLine("");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).result.protocolVersion).toBe("2025-11-25");
  });
  it("unexpected exceptions become isError without leaking internals", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => { throw new Error("boom " + TOKEN); } })) as unknown as typeof fetch;
    const s = createServer({ send: (l) => out.push(l), log: (l) => logs.push(l), env: { SECRETS_API_URL: "http://x.test", SECRETS_TOKEN: TOKEN }, fetchImpl });
    await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "draft_message", arguments: { conversationId: "x", text: "y" } } }));
    const r = JSON.parse(out[1]!);
    expect(r.result).toMatchObject({ isError: true, content: [{ text: "Internal error in draft_message" }] });
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe.skipIf(!existsSync(DIST))("built dist/mcp/secrets-mcp.js", () => {
  it("runs as `node dist/mcp/secrets-mcp.js`", async () => {
    const p = spawn(process.execPath, [DIST], { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    p.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) + "\n");
    await new Promise((r) => p.once("exit", r));
    expect(JSON.parse(out.trim()).result.serverInfo.name).toBe("secrets-mcp");
  });
});
