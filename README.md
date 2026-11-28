# ai.secrets

AI bridge service and `secrets-ai` CLI for **Secrets**. It supervises the headless OpenCode CLI (`opencode serve`), normalizes its SSE events into a clean `AiEvent` stream, enforces localhost Bearer auth, and exposes both MCP servers (`secrets-mcp` and `github-mcp`).

```
secrets frontend / secrets-ai CLI
        │  HTTP + SSE (Normalized AiEvent)
        ▼
ai.secrets bridge (Fastify, 127.0.0.1:8790, Bearer auth)
        │  HTTP + SSE (/session, /event, /permissions)
        ▼
opencode serve (supervised per workspace, auto-restart)
        │
        ▼
OpenRouter / Gemini + MCP (github-mcp, secrets-mcp)
```

---

## Security & Keys

- Binds to `127.0.0.1:8790` by default.
- Generates a Bearer token on first run in `~/.config/secrets-ai/config.json` (mode `0600`).
- All `/v1/*` routes require `Authorization: Bearer <token>` (set `DISABLE_BRIDGE_AUTH=1` only if needed for local browser dev).
- Keys come from environment variables (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`), `~/.config/secrets-ai/config.json`, or per-request headers (`x-provider-key`).
- Keys and tokens are never written raw to `opencode.json` or logs.
- Write actions (`edit`, `bash`, GitHub writes, `draft_message`) emit `permission.request` events and support `allow`, `deny`, and `allow_session`.

---

## Run Modes

### 1. Terminal (`secrets-ai` CLI, no frontend required)

```bash
pnpm install
pnpm build
node dist/cli/index.js init
node dist/cli/index.js serve        # starts bridge on 127.0.0.1:8790
node dist/cli/index.js chat         # interactive streaming chat with approval prompts
node dist/cli/index.js run "Summarize recent commits"
node dist/cli/index.js models --free-tools
```

### 2. Local Daemon (Termux on Android / macOS / Linux)

On Termux:
```bash
bash scripts/install-termux.sh
secrets-ai serve
```

### 3. VPS (systemd)

```bash
sudo cp deploy/secrets-ai.service /etc/systemd/system/secrets-ai.service
sudo systemctl daemon-reload
sudo systemctl enable --now secrets-ai
```

### 4. Docker

```bash
docker build -t ai.secrets .
docker run -d -p 127.0.0.1:8790:8790 \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  -e SECRETS_AI_TOKEN=your-bridge-token \
  ai.secrets
```

---

## Bridge API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/v1/sessions` | Create workspace session |
| `GET` | `/v1/sessions` | List sessions |
| `POST` | `/v1/sessions/:id/messages` | Send prompt, stream normalized `AiEvent` SSE |
| `POST` | `/v1/sessions/:id/abort` | Abort running session |
| `POST` | `/v1/permissions/:id/respond` | Respond `{ decision: "allow" \| "deny" \| "allow_session" }` |
| `GET` | `/v1/models` | List models (`?provider=openrouter&free_tools=1`) |
| `GET` / `PUT` | `/v1/settings` | Read or update provider, model, effort, tools, systemPrompt |
| `POST` | `/v1/settings/test-connection` | Verify provider API key |

Legacy `/v1/chat`, `/v1/chat/:runId/confirm`, and `/v1/chat/:runId/stop` endpoints remain available for backward compatibility.

---

## Development & Tests

```bash
pnpm typecheck
pnpm test       # Vitest suite against tests/fake-opencode.mjs
pnpm build
```
