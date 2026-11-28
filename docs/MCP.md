# MCP servers

Secrets AI can give the OpenCode agent two MCP servers. Each one is added to the generated `opencode.json` **only** when the user has enabled it (`settings.tools.github` / `settings.tools.secrets`) **and** a credential is available (plus `settings.secretsApiUrl` for secrets). Tests: `tests/unit/opencode-config.test.ts`.

Credentials never appear in `opencode.json`. The config refers to them as `{env:VAR}`, and the bridge puts them only in the opencode child's environment under private names (`src/presets/env.ts`):

| Server | Child env var | Never used |
| --- | --- | --- |
| github | `SECRETS_AI_GITHUB_TOKEN` | `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` (`GITHUB_TOKEN` would switch on OpenCode's `github-copilot` provider, which is also listed in `disabled_providers` as a second safeguard) |
| secrets | `SECRETS_AI_SECRETS_TOKEN` | n/a |

Warning (verified on opencode 1.19.6): `GET /config` returns MCP headers **after** `{env:}` substitution, so the response contains `Bearer <PAT>`. `GET /config/providers` returns each provider's raw `key`. The bridge must never pass these responses to the UI as-is. Use `sanitizeOpenCodeProviders()` from `src/presets/index.ts` for anything you pass on.

## Tool and permission naming (verified)

OpenCode names MCP tools `<server>_<tool>`, for example `secrets_read_conversation` and `github_issue_read`. Permission keys use the same names, with `*` wildcards. This was verified at runtime against opencode 1.19.6 by `tests/unit/mcp-opencode.real.test.ts` (`OPENCODE_REAL=1`, run after `pnpm build`). In that test:
- the tool list OpenCode sent to the LLM contained `secrets_read_conversation`, `secrets_summarize_dock_channel` and `secrets_draft_message`;
- `secrets_read_conversation` ran without a prompt (rule `allow`);
- `secrets_draft_message` raised `permission.asked` with `permission: "secrets_draft_message"` (rule `ask`).

Note: `/experimental/tool/ids` lists built-in tools only, not MCP tools.

The rules form an ordered list and the **last matching rule wins**. `mcpPermissions()` in `src/mcp/presets.ts` emits them in this order:
1. a catch-all `<server>_*` → `ask`, so unknown and new tools fall back to asking;
2. read rules → `allow`;
3. write tools → `ask`.

The `plan` agent gets write tools as `deny`.

## secrets-mcp (`src/mcp/secrets-mcp.ts`)

This stdio MCP server has no dependencies (newline-delimited JSON-RPC). Run it with `node dist/mcp/secrets-mcp.js`. It exports `createServer(io)` and starts only when it is the main module.

Env: `SECRETS_API_URL` (base URL of `apps/api`) and `SECRETS_TOKEN` (Bearer). In `opencode.json` the entry looks like this:

```json
"secrets": { "type": "local", "command": ["<node>", "<dist>/mcp/secrets-mcp.js"],
  "environment": { "SECRETS_API_URL": "https://…", "SECRETS_TOKEN": "{env:SECRETS_AI_SECRETS_TOKEN}" }, "enabled": true }
```

Protocol support:
- Legacy `initialize`, negotiating 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05. OpenCode uses this path.
- The stateless 2026-07-28 revision ([server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)), using per-request `_meta.protocolVersion` and `clientCapabilities`.
- `ping`, `tools/list` and `tools/call`.

Errors:
- Unknown tool → `-32602`.
- Bad arguments or API failures → `isError: true` results with a hint for 401/403/404/429.
- Parse error → `-32700`; invalid request or batch → `-32600`; unknown method → `-32601`.

The token is never written to stderr or into results. This is tested.

### Tools → api.secrets endpoints

Endpoints come from titan717/secrets `apps/api`. Auth is `Authorization: Bearer <token>`, and bearer requests skip CSRF.

| Tool | Endpoints | Notes |
| --- | --- | --- |
| `read_conversation {conversationId, limit?=50 (max 200)}` | `GET /v1/conversations/:id` (members); `GET /v1/conversations/:id/messages?limit=1..100&before=<msgId>` (newest first, paged with `before` when limit > 100); `GET /v1/docks/:dockId/members` for display names when a channel has no member list | Returns oldest first. Deleted messages are skipped (`limit` counts raw messages). Messages with a `nonce` are shown as `[encrypted message]`. |
| `summarize_dock_channel {channelId, limit?}` | `GET /v1/conversations/:channelId` (must be `kind: "channel"` with `dock_id`), `GET /v1/docks/:dockId` (channel list), messages as above | A channel id is its conversation id. Returns structured data. The model writes the summary itself, and the server makes no LLM call. |
| `draft_message {conversationId, text}` | `GET /v1/conversations/:id` (checks the conversation exists and is accessible) | **No drafts endpoint exists in the API.** The draft is returned locally as `{draft, sent: false}`. Nothing is ever POSTed. The user sends the message from the app. |

API gaps:
- No drafts endpoint (see above).
- `POST /v1/auth/service-token` tokens expire after 600 s. The bridge handles this by restarting, see "Token rotation" below.
- In the prototype `ciphertext` holds the plaintext JSON body. With real E2EE the server can't read messages, so these tools would need client-side decryption.

## Token rotation (600 s Secrets tokens)

secrets-mcp gets `SECRETS_TOKEN` from its environment, and that environment is fixed when `opencode serve` starts. A running MCP child therefore can't pick up a new token. The contract is:

1. The Secrets app sends its current service token as `x-secrets-token` on each bridge turn request. `x-github-token` works the same way.
2. The bridge sets it as a transient per-workspace override (`setSecretOverrides`) and calls `supervisor.reload()`.
3. The supervisor compares `secretsTokenFingerprint(secrets)` (and `githubTokenFingerprint`, or both together as `mcpCredentialFingerprint`) from `src/presets`. **When the fingerprint changes, the bridge restarts that workspace's opencode** with the new value in `SECRETS_AI_SECRETS_TOKEN`. The new opencode then respawns secrets-mcp. A request carrying the same token causes no restart.
4. If a token expires before a new one arrives, the tools return `isError` with HTTP 401 and the hint "send a fresh x-secrets-token". The model sees this and the turn goes on. The next request that carries a fresh token fixes it.

The fingerprints are the first 16 hex characters of a domain-separated SHA-256 hash. They can't be reversed and are safe to log or compare, while the tokens themselves are never logged. A restart interrupts any turn in flight on that workspace, which then ends with `OpenCodeRestarted`. Clients should therefore refresh the token between turns, before it expires, for example whenever less than about 60 s of its lifetime is left.

## GitHub MCP preset (`githubMcpEntry()`)

Source: [github/github-mcp-server README](https://github.com/github/github-mcp-server) and [remote server docs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).

```json
"github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "Authorization": "Bearer {env:SECRETS_AI_GITHUB_TOKEN}", "X-MCP-Toolsets": "context,repos,issues,pull_requests" }, "enabled": true }
```

- **Auth:** the README's PAT example for the remote server is exactly `"Authorization": "Bearer <PAT>"` in the headers. A fine-grained PAT limited to the user's repos is recommended. Not verified live: we have no PAT, and a dummy token gets HTTP 400 on the SSE fallback.
- **Toolsets:**
  - `X-MCP-Toolsets` is a comma-separated list. Unknown names are silently ignored.
  - `/x/{toolset}` takes a **single** toolset only, which is why we use the header.
  - `X-MCP-Tools` lists individual tools (an invalid tool name makes the server fail).
- **Read-only:** add the header `X-MCP-Readonly: true` or use the path `/readonly` (`/x/{toolset}/readonly`). We don't enable it by default because write tools are already gated by `ask`. Users who want hard read-only can add the header.
- `X-MCP-Lockdown` hides public issue details created by users without push access. It is best-effort only.
- **Local alternative:** `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e GITHUB_TOOLSETS=context,repos,issues,pull_requests -e GITHUB_READ_ONLY=1 ghcr.io/github/github-mcp-server` as an OpenCode `local` server. Docker isn't available on Termux, so the remote server is the default. If you use the local server, map the PAT as `GITHUB_PERSONAL_ACCESS_TOKEN: "{env:SECRETS_AI_GITHUB_TOKEN}"` in `environment`, only inside the MCP entry.

Permissions (tool names from the README, Nov 2026):
- **allow:** `github_get_*`, `github_list_*`, `github_search_*`, `github_*_read` (`issue_read`, `pull_request_read`), `github_ui_get`.
- **ask:**
  - repos: `create_branch`, `create_or_update_file`, `delete_file`, `push_files`, `create_repository`, `delete_repository`, `fork_repository`;
  - issues: `issue_write`, `add_issue_comment`, `update_issue_comment`, `sub_issue_write`;
  - pull requests: `create_pull_request`, `update_pull_request`, `update_pull_request_branch`, `merge_pull_request`, `pull_request_review_write`, `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`;
  - legacy names kept for older servers.
- Anything else falls to the `github_*` → `ask` catch-all.
