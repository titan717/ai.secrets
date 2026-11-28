/**
 * secrets-mcp: dependency-free stdio MCP server exposing read-only Secrets tools to OpenCode.
 *
 * Transport: JSON-RPC 2.0, one message per line on stdin/stdout (no embedded newlines); logs go
 * to stderr only and are redacted. Dual-era per the MCP spec 2026-07-28:
 *  - modern: `server/discover` + per-request `_meta["io.modelcontextprotocol/protocolVersion"]`
 *  - legacy: `initialize` / `notifications/initialized` handshake (2025-11-25 and earlier),
 *    which is what OpenCode's MCP client speaks today.
 *
 * Env: SECRETS_API_URL, SECRETS_TOKEN. Run: `node dist/mcp/secrets-mcp.js`.
 * Importing this module never starts the server; call createServer(io) or run it as main.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redact, registerSecret } from "../core/redact.js";
import { SecretsApi, SecretsApiError, openBody, type ApiConversation, type ApiMessage } from "./secrets-api.js";

export const SERVER_INFO = { name: "secrets-mcp", version: "0.2.0" } as const;
export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNSUPPORTED_VERSION: -32022,
} as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ServerIO {
  /** Write one serialized JSON-RPC message (without the trailing newline). */
  send(line: string): void;
  /** Diagnostics (stderr). Already redacted. */
  log?(line: string): void;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean };

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
  run(api: SecretsApi, args: Json): Promise<unknown>;
}

class ArgError extends Error {}

function str(args: Json, key: string, max = 200): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ArgError(`${key} is required and must be a non-empty string`);
  if (v.length > max) throw new ArgError(`${key} must be at most ${max} characters`);
  return v.trim();
}

function limitArg(args: Json): number {
  const v = args.limit;
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new ArgError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  return n;
}

function displayName(u: { username: string; display_name?: string }): string {
  return u.display_name ? `${u.display_name} (@${u.username})` : `@${u.username}`;
}

function transcript(messages: ApiMessage[], names: Map<string, string>) {
  return messages
    .filter((m) => !m.deleted)
    .map((m) => {
      const b = openBody(m);
      const out: Json = { id: m.id, from: names.get(m.sender_id) ?? m.sender_id, at: m.created_at, text: b.text ?? "" };
      if (b.kind === "system") out.system = true;
      if (b.reply_to) out.reply_to = b.reply_to;
      if (b.attachments?.length) out.attachments = b.attachments.map((a) => a.name ?? a.mime);
      if (m.edited_at) out.edited = true;
      if (m.pinned) out.pinned = true;
      return out;
    });
}

async function memberNames(api: SecretsApi, convo: ApiConversation | null): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const u of convo?.members ?? []) names.set(u.id, displayName(u));
  if (convo?.dock_id && names.size === 0) {
    try {
      for (const m of await api.dockMembers(convo.dock_id)) names.set(m.user.id, displayName(m.user));
    } catch {
      /* names are best effort */
    }
  }
  return names;
}

const id = { type: "string", minLength: 1, maxLength: 200 };
const limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: `Number of most recent messages (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})` };

export const TOOLS: ToolDef[] = [
  {
    name: "read_conversation",
    title: "Read a Secrets conversation",
    description: "Read the most recent messages of a Secrets conversation (DM, group or dock channel), oldest first.",
    inputSchema: { type: "object", properties: { conversationId: { ...id, description: "Conversation id (uuid)" }, limit }, required: ["conversationId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(api, args) {
      const cid = str(args, "conversationId");
      const n = limitArg(args);
      const [convo, msgs] = await Promise.all([api.conversation(cid), api.messages(cid, n)]);
      const names = await memberNames(api, convo);
      return {
        conversation: { id: convo.id, kind: convo.kind, title: convo.title, dockId: convo.dock_id, members: [...names.values()] },
        messages: transcript(msgs, names),
      };
    },
  },
  {
    name: "summarize_dock_channel",
    title: "Fetch a dock channel for summarizing",
    description:
      "Fetch recent messages of a dock channel with dock/channel context, structured so you can summarize them. Returns data only; write the summary yourself.",
    inputSchema: { type: "object", properties: { channelId: { ...id, description: "Channel id (same as its conversation id)" }, limit }, required: ["channelId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(api, args) {
      const chId = str(args, "channelId");
      const n = limitArg(args);
      const convo = await api.conversation(chId);
      if (convo.kind !== "channel" || !convo.dock_id) throw new ArgError(`${chId} is a ${convo.kind} conversation, not a dock channel; use read_conversation`);
      const [dock, msgs, names] = await Promise.all([api.dock(convo.dock_id), api.messages(chId, n), memberNames(api, convo)]);
      const ch = dock.channels?.find((c) => c.id === chId);
      const items = transcript(msgs, names);
      const participants = [...new Set(items.map((m) => String(m.from)))];
      return {
        dock: { id: dock.id, name: dock.name, handle: dock.handle },
        channel: { id: chId, name: ch?.name ?? convo.title, topic: ch?.topic ?? "" },
        period: items.length ? { from: items[0]!.at, to: items[items.length - 1]!.at } : null,
        participants,
        messageCount: items.length,
        messages: items,
        instructions: "Summarize the key topics, decisions, open questions and action items (with owners) from these messages. Quote sparingly.",
      };
    },
  },
  {
    name: "draft_message",
    title: "Draft a message (never sends)",
    description:
      "Prepare a draft message for a Secrets conversation. It NEVER sends anything: it returns the draft so the user can review and send it themselves in the Secrets app.",
    inputSchema: {
      type: "object",
      properties: { conversationId: { ...id, description: "Conversation id (uuid)" }, text: { type: "string", minLength: 1, maxLength: 4000, description: "Draft text" } },
      required: ["conversationId", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(api, args) {
      const cid = str(args, "conversationId");
      const text = str(args, "text", 4000);
      const convo = await api.conversation(cid); // verifies access; nothing is written
      return {
        draft: { conversationId: convo.id, conversationTitle: convo.title, kind: convo.kind, text },
        sent: false,
        note: "Draft only. Nothing was sent. The user must review and send it from the Secrets app.",
      };
    },
  },
];

export function createServer(io: ServerIO) {
  const env = io.env ?? process.env;
  registerSecret(env.SECRETS_TOKEN);
  const api = new SecretsApi(env.SECRETS_API_URL, env.SECRETS_TOKEN, io.fetchImpl ?? fetch);
  let legacyVersion: string | undefined; // set after a legacy `initialize`
  const log = (s: string) => io.log?.(redact(s));

  const send = (msg: Json) => io.send(JSON.stringify(msg));
  const reply = (rid: unknown, result: Json, modern: boolean) =>
    send({ jsonrpc: "2.0", id: rid, result: modern ? { resultType: "complete", ...result, _meta: { ...((result._meta as Json) ?? {}), [META_SERVER]: SERVER_INFO } } : result });
  const fail = (rid: unknown, code: number, message: string, data?: unknown) =>
    send({ jsonrpc: "2.0", id: rid ?? null, error: { code, message: redact(message), ...(data !== undefined ? { data } : {}) } });

  const toolList = () => TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

  async function callTool(params: Json): Promise<ToolResult | { protocolError: [number, string] }> {
    const name = params.name;
    if (typeof name !== "string") return { protocolError: [ERR.INVALID_PARAMS, "params.name must be a string"] };
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { protocolError: [ERR.INVALID_PARAMS, `Unknown tool: ${name.slice(0, 80)}`] };
    const args = params.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { protocolError: [ERR.INVALID_PARAMS, "params.arguments must be an object"] };
    try {
      const data = await tool.run(api, args as Json);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: false };
    } catch (e) {
      const known = e instanceof ArgError || e instanceof SecretsApiError;
      if (!known) log(`tool ${name} crashed: ${(e as Error)?.message}`);
      return { content: [{ type: "text", text: redact(known ? (e as Error).message : `Internal error in ${name}`) }], isError: true };
    }
  }

  async function handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, ERR.INVALID_REQUEST, Array.isArray(msg) ? "Batch requests are not supported" : "Invalid request");
    const m = msg as Json;
    const hasId = "id" in m && m.id !== undefined;
    const rid = m.id;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      if (!hasId && ("result" in m || "error" in m)) return; // a response to us; we never send requests
      return fail(hasId ? rid : null, ERR.INVALID_REQUEST, "Invalid request");
    }
    if (hasId && rid !== null && typeof rid !== "string" && typeof rid !== "number") return fail(null, ERR.INVALID_REQUEST, "id must be a string or integer");
    const method = m.method;
    const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;

    // Notifications: never answered.
    if (!hasId) {
      if (method === "notifications/initialized" || method === "notifications/cancelled" || method.startsWith("notifications/")) return;
      return;
    }

    if (method === "initialize") {
      const req = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      legacyVersion = (LEGACY_VERSIONS as readonly string[]).includes(req) ? req : LEGACY_VERSIONS[0];
      return reply(rid, { protocolVersion: legacyVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: "Read-only tools for the Secrets messenger. draft_message never sends." }, false);
    }

    const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Json;
    const reqVersion = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;
    let modern = false;
    if (reqVersion !== undefined) {
      if (!(MODERN_VERSIONS as readonly string[]).includes(reqVersion)) {
        return fail(rid, ERR.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS], requested: reqVersion });
      }
      if (meta[META_CAPS] === undefined || typeof meta[META_CAPS] !== "object") return fail(rid, ERR.INVALID_PARAMS, `Missing _meta["${META_CAPS}"]`);
      modern = true;
    } else if (!legacyVersion && method !== "ping") {
      return fail(rid, ERR.INVALID_PARAMS, `Missing _meta["${META_VERSION}"] (or send initialize first)`);
    }

    switch (method) {
      case "server/discover":
        return reply(rid, { supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: { listChanged: false } }, instructions: "Read-only tools for the Secrets messenger. draft_message never sends.", ttlMs: 3600000, cacheScope: "public" }, true);
      case "ping":
        return reply(rid, {}, modern);
      case "tools/list":
        return reply(rid, modern ? { tools: toolList(), ttlMs: 300000, cacheScope: "public" } : { tools: toolList() }, modern);
      case "tools/call": {
        const r = await callTool(params);
        if ("protocolError" in r) return fail(rid, r.protocolError[0], r.protocolError[1]);
        return reply(rid, r as unknown as Json, modern);
      }
      default:
        return fail(rid, ERR.METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 80)}`);
    }
  }

  /** Handle one raw line from stdin. */
  async function handleLine(line: string): Promise<void> {
    const t = line.trim();
    if (!t) return;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      return fail(null, ERR.PARSE, "Parse error");
    }
    try {
      await handleMessage(msg);
    } catch (e) {
      log(`internal error: ${(e as Error)?.message}`);
      const rid = msg && typeof msg === "object" && "id" in msg ? (msg as Json).id : null;
      fail(rid, ERR.INTERNAL, "Internal error");
    }
  }

  return { handleLine, handleMessage, tools: toolList };
}

/** Run over process stdin/stdout. Requests are handled concurrently; each response is one line. */
export function runStdio(): void {
  const server = createServer({
    send: (line) => process.stdout.write(line + "\n"),
    log: (line) => process.stderr.write(`[secrets-mcp] ${line}\n`),
  });
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      void server.handleLine(line);
    }
    if (buf.length > 4 * 1024 * 1024) buf = ""; // refuse absurd unterminated input
  });
  process.stdin.on("end", () => {
    if (buf.trim()) void server.handleLine(buf);
    setTimeout(() => process.exit(0), 50).unref();
  });
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) runStdio();
