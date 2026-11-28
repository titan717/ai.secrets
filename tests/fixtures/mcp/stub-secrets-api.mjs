/**
 * Stub of the Secrets API (github.com/titan717/secrets apps/api) for secrets-mcp tests.
 * Shapes follow packages/shared/src/types.ts; ciphertext is plaintext JSON (prototype envelope).
 * Exports startStubApi({ token }) -> { url, requests, close }.
 */
import http from "node:http";

export const IDS = {
  dm: "11111111-1111-4111-8111-111111111111",
  channel: "22222222-2222-4222-8222-222222222222",
  dock: "33333333-3333-4333-8333-333333333333",
  alice: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  bob: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  forbidden: "44444444-4444-4444-8444-444444444444",
};
const alice = { id: IDS.alice, username: "alice", display_name: "Alice", about: "", avatar_url: null, accent: null, created_at: "2026-11-01T00:00:00.000Z" };
const bob = { id: IDS.bob, username: "bob", display_name: "", about: "", avatar_url: null, accent: null, created_at: "2026-11-01T00:00:00.000Z" };

function msg(conv, n, sender, body, extra = {}) {
  const id = `${conv.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, conversation_id: conv, sender_id: sender, device_id: "dev", ciphertext: JSON.stringify(body), nonce: null, created_at: new Date(Date.UTC(2026, 10, 27, 10, n)).toISOString(), client_msg_id: `c${n}`, reactions: [], edited_at: null, deleted: false, pinned: false, ...extra };
}

// Stored oldest -> newest; the API returns newest first.
const MESSAGES = {
  [IDS.dm]: [
    msg(IDS.dm, 1, IDS.alice, { text: "hi bob" }),
    msg(IDS.dm, 2, IDS.bob, { text: "hey! lunch?" }),
    msg(IDS.dm, 3, IDS.alice, { text: "deleted" }, { deleted: true }),
    msg(IDS.dm, 4, IDS.alice, { text: "see photo", attachments: [{ id: "f1", url: "/v1/attachments/f1", mime: "image/png", size: 3, name: "pic.png" }] }),
  ],
  [IDS.channel]: Array.from({ length: 150 }, (_, i) => msg(IDS.channel, i + 1, i % 2 ? IDS.bob : IDS.alice, { text: `channel message ${i + 1}` })),
};
const CONVS = {
  [IDS.dm]: { id: IDS.dm, kind: "dm", title: null, avatar_url: null, dock_id: null, members: [alice, bob], last_message: null, unread_count: 0, created_at: "2026-11-01T00:00:00.000Z" },
  [IDS.channel]: { id: IDS.channel, kind: "channel", title: "general", avatar_url: null, dock_id: IDS.dock, members: [], last_message: null, unread_count: 0, created_at: "2026-11-01T00:00:00.000Z" },
};
const DOCK = { id: IDS.dock, name: "Team Dock", handle: "team", description: "", icon_url: null, visibility: "private", owner_id: IDS.alice, member_count: 2, my_role: "member", channels: [{ id: IDS.channel, dock_id: IDS.dock, name: "general", topic: "Everything", position: 0 }], created_at: "2026-11-01T00:00:00.000Z" };

export function startStubApi({ token }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized", message: "Invalid or expired session" });
    if (req.method !== "GET") return send(405, { error: "method_not_allowed", message: "stub is read-only" });
    let m;
    if ((m = /^\/v1\/conversations\/([^/]+)$/.exec(url.pathname))) {
      if (m[1] === IDS.forbidden) return send(403, { error: "forbidden", message: "You don't have permission to do that" });
      return CONVS[m[1]] ? send(200, CONVS[m[1]]) : send(404, { error: "not_found", message: "Conversation not found" });
    }
    if ((m = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(url.pathname))) {
      const all = MESSAGES[m[1]];
      if (!all) return send(404, { error: "not_found", message: "Conversation not found" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
      let list = [...all].reverse();
      const before = url.searchParams.get("before");
      if (before) { const i = list.findIndex((x) => x.id === before); if (i < 0) return send(400, { error: "bad_request", message: "before cursor not found in this conversation" }); list = list.slice(i + 1); }
      return send(200, list.slice(0, limit));
    }
    if (url.pathname === `/v1/docks/${IDS.dock}`) return send(200, DOCK);
    if (url.pathname === `/v1/docks/${IDS.dock}/members`) return send(200, [{ user: alice, role: "owner", joined_at: "2026-11-01T00:00:00.000Z" }, { user: bob, role: "member", joined_at: "2026-11-01T00:00:00.000Z" }]);
    return send(404, { error: "not_found", message: "Not found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(() => r())) })));
}
