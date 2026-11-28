/**
 * Tiny in-test fake of the bridge HTTP API (src/core/api.ts) for CLI tests.
 * Scenarios emit AiEvents; `drop` closes the live connection while the turn continues, so
 * clients must resume via GET /v1/sessions/:id/events with Last-Event-ID.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AiEvent } from "../../src/core/events.js";
import type { BridgeSession } from "../../src/core/api.js";
import { DEFAULT_SETTINGS, type ModelInfo, type Settings } from "../../src/core/types.js";

export type Step =
  | { event: { type: AiEvent["type"]; [k: string]: unknown } }
  | { waitPermission: string }
  | { waitQuestion: string }
  | { drop: true }
  | { delay: number };

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

interface Sess {
  info: BridgeSession;
  log: Array<{ id: number; ev: AiEvent }>;
  subs: Set<ServerResponse>;
  seq: number;
}

export interface FakeBridge {
  url: string;
  token: string;
  requests: Recorded[];
  permissionReplies: Array<{ id: string; decision: string }>;
  questionReplies: Array<{ id: string; body: unknown }>;
  aborts: string[];
  settings: Settings;
  close(): Promise<void>;
}

export async function startFakeBridge(opts: {
  token?: string;
  scenario?: (text: string) => Step[];
  models?: ModelInfo[];
} = {}): Promise<FakeBridge> {
  const token = opts.token ?? "sai_testtoken_0123456789abcdefghij";
  const sessions = new Map<string, Sess>();
  const waiters = new Map<string, () => void>();
  const fb: FakeBridge = {
    url: "",
    token,
    requests: [],
    permissionReplies: [],
    questionReplies: [],
    aborts: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    close: async () => {
      for (const s of sessions.values()) for (const r of s.subs) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  let n = 0;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const emit = (s: Sess, ev: AiEvent) => {
    const id = ++s.seq;
    s.log.push({ id, ev });
    for (const r of s.subs) r.write(`id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const attach = (s: Sess, res: ServerResponse, after: number) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": ping\n\n");
    for (const { id, ev } of s.log) if (id > after) res.write(`id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    s.subs.add(res);
    res.on("close", () => s.subs.delete(res));
  };
  const runScenario = async (s: Sess, text: string) => {
    const steps = opts.scenario?.(text) ?? [{ event: { type: "text.delta", text: `echo: ${text}` } }, { event: { type: "session.idle" } }];
    s.info.status = "busy";
    for (const st of steps) {
      if ("event" in st) emit(s, { sessionId: s.info.id, ...st.event } as AiEvent);
      else if ("drop" in st) for (const r of s.subs) r.destroy();
      else if ("delay" in st) await new Promise((r) => setTimeout(r, st.delay));
      else {
        const key = "waitPermission" in st ? st.waitPermission : st.waitQuestion;
        await new Promise<void>((r) => waiters.set(key, r));
      }
    }
    s.info.status = "idle";
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    fb.requests.push({ method: req.method ?? "", path: path + url.search, headers: req.headers, body });
    if (path === "/health") return json(res, 200, { ok: true, version: "0.0.0-fake", opencode: { running: true, version: "1.19.6", workspaces: 1 } });
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: { code: "unauthorized", message: "bad token" } });
    const m = (re: RegExp) => re.exec(path);
    let r: RegExpExecArray | null;
    if (req.method === "POST" && path === "/v1/sessions") {
      const id = `ses_fake${++n}`;
      const b = (body ?? {}) as { title?: string; workspace?: string };
      const info: BridgeSession = { id, title: b.title ?? "", workspace: b.workspace ?? "/ws", createdAt: 1, updatedAt: 1, status: "idle", usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, costUsd: 0.0012 } };
      sessions.set(id, { info, log: [], subs: new Set(), seq: 0 });
      return json(res, 200, { session: info });
    }
    if (req.method === "GET" && path === "/v1/sessions") return json(res, 200, { sessions: [...sessions.values()].map((s) => s.info) });
    if ((r = m(/^\/v1\/sessions\/([^/]+)$/)) && req.method === "GET") {
      const s = sessions.get(r[1]!);
      return s ? json(res, 200, { session: s.info }) : json(res, 404, { error: { code: "not_found", message: "no such session" } });
    }
    if ((r = m(/^\/v1\/sessions\/([^/]+)\/messages$/)) && req.method === "POST") {
      const s = sessions.get(r[1]!);
      if (!s) return json(res, 404, { error: { code: "not_found", message: "no such session" } });
      attach(s, res, s.seq);
      void runScenario(s, (body as { text: string }).text);
      return;
    }
    if ((r = m(/^\/v1\/sessions\/([^/]+)\/events$/)) && req.method === "GET") {
      const s = sessions.get(r[1]!);
      if (!s) return json(res, 404, { error: { code: "not_found", message: "no such session" } });
      attach(s, res, Number(req.headers["last-event-id"] ?? s.seq));
      return;
    }
    if ((r = m(/^\/v1\/sessions\/([^/]+)\/abort$/)) && req.method === "POST") {
      fb.aborts.push(r[1]!);
      const s = sessions.get(r[1]!);
      if (s) {
        emit(s, { type: "error", sessionId: s.info.id, message: "aborted", code: "MessageAbortedError" });
        emit(s, { type: "session.idle", sessionId: s.info.id });
        for (const w of waiters.values()) w();
      }
      return json(res, 200, { ok: true });
    }
    if ((r = m(/^\/v1\/permissions\/([^/]+)\/respond$/)) && req.method === "POST") {
      fb.permissionReplies.push({ id: r[1]!, decision: (body as { decision: string }).decision });
      waiters.get(r[1]!)?.();
      return json(res, 200, { ok: true });
    }
    if ((r = m(/^\/v1\/questions\/([^/]+)\/respond$/)) && req.method === "POST") {
      fb.questionReplies.push({ id: r[1]!, body });
      waiters.get(r[1]!)?.();
      return json(res, 200, { ok: true });
    }
    if (path === "/v1/models") {
      let list = opts.models ?? [];
      if (url.searchParams.get("free_tools") === "1") list = list.filter((x) => x.free && x.toolCall);
      return json(res, 200, { models: list });
    }
    if (path === "/v1/settings" && req.method === "GET") return json(res, 200, { settings: fb.settings, secrets: { openrouter: true, google: false, github: false, secrets: false } });
    if (path === "/v1/settings" && req.method === "PUT") {
      fb.settings = { ...fb.settings, ...(body as Partial<Settings>) };
      return json(res, 200, { settings: fb.settings, secrets: { openrouter: true, google: false, github: false, secrets: false } });
    }
    if (path === "/v1/secrets" && req.method === "PUT") return json(res, 200, { settings: fb.settings, secrets: { openrouter: true, google: false, github: false, secrets: false } });
    return json(res, 404, { error: { code: "not_found", message: `no route ${req.method} ${path}` } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fb.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fb;
}

import { PassThrough } from "node:stream";
import type { Io } from "../../src/cli/io.js";

export interface TestIo extends Io {
  out(): string;
  err(): string;
  /** Write a line to simulated stdin. */
  type(line: string): void;
  end(): void;
}

/** In-memory Io. `input` is written up front; stdin stays open unless `end` is true. */
export function testIo(o: { input?: string; end?: boolean; tty?: boolean; stdoutTty?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {}): TestIo {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stderr = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (o.tty) stdin.isTTY = true;
  if (o.stdoutTty) stdout.isTTY = true;
  let out = "";
  let err = "";
  stdout.on("data", (c: Buffer) => (out += c.toString()));
  stderr.on("data", (c: Buffer) => (err += c.toString()));
  if (o.input !== undefined) stdin.write(o.input);
  if (o.end) stdin.end();
  return {
    stdin,
    stdout,
    stderr,
    env: { NO_COLOR: "1", ...(o.env ?? {}) },
    cwd: o.cwd ?? process.cwd(),
    out: () => out,
    err: () => err,
    type: (l) => void stdin.write(l + "\n"),
    end: () => void stdin.end(),
  };
}
