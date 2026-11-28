# OpenCode CLI & Bridge Research Notes

_Verified: 2026-11-28_

This document records the OpenCode CLI (`opencode serve`), `@opencode-ai/sdk`, `opencode.json` schema, reasoning effort mapping, API key injection, and MCP configuration used by `ai.secrets`.

---

## 1. `opencode serve` Command

OpenCode runs a headless HTTP + SSE server exposing an OpenAPI 3.1 specification.

### Flags
| Flag | Description | Default |
|---|---|---|
| `--port <number>` | Port to listen on | `4096` |
| `--hostname <string>` | Interface to bind | `127.0.0.1` |
| `--mdns` | Enable mDNS discovery | `false` |
| `--mdns-domain <string>` | Custom mDNS domain | `opencode.local` |
| `--cors <origin>` | Additional CORS origin(s), repeatable | `[]` |

### Server Authentication (Env Vars)
- `OPENCODE_SERVER_PASSWORD`: Enables HTTP Basic auth when set.
- `OPENCODE_SERVER_USERNAME`: Overrides username (default `opencode`).

---

## 2. HTTP & SSE Endpoints (`opencode serve`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/doc` | OpenAPI 3.1 JSON specification (also used as health check) |
| `GET` | `/session` | List active/saved sessions |
| `POST` | `/session` | Create a new session (`{ location: { directory } }`) |
| `GET` | `/session/:id` | Get session details |
| `POST` | `/session/:id/prompt` | Send a prompt/message (`{ text, model?, variant? }`) |
| `POST` | `/session/:id/abort` | Abort a running session turn |
| `GET` | `/session/:id/messages` | Get message history |
| `POST` | `/session/:id/permissions/:permissionId` | Respond to a permission prompt (`{ response: "once" | "always" | "reject" }`) |
| `GET` | `/event` | Global SSE event stream (`Accept: text/event-stream`) |

### SSE Wire Format
```http
event: message
data: {"type":"message.part.delta","properties":{...}}
```

### Core OpenCode Event Types
- `server.connected` — SSE stream established
- `server.heartbeat` — keep-alive ping
- `session.updated` — session metadata/status changed (`idle`, `busy`, `retry`)
- `session.idle` — session finished current turn
- `session.error` — error during session execution
- `message.created` — new user or assistant message created
- `message.part.delta` — incremental text or reasoning token delta (`part.type === "text" | "reasoning"`)
- `part.updated` — tool call lifecycle (`pending` → `running` → `completed` | `error`)
- `permission.asked` / `permission.updated` — tool/bash/edit permission request awaiting user approval
- `question.asked` — interactive question from agent
- `config.updated` — runtime config updated

---

## 3. `@opencode-ai/sdk` Usage

```ts
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({
  baseUrl: "http://127.0.0.1:4096",
});

const session = await client.session.create({
  body: { location: { directory: workspaceDir } },
});

const events = await client.event.subscribe({ signal });
for await (const ev of events) {
  // ev.type, ev.properties
}
```

Note: `ai.secrets` supervises `opencode serve` directly via `child_process.spawn` on a dynamically allocated localhost port per workspace, health-checks `GET /doc`, and connects over HTTP + SSE.

---

## 4. `opencode.json` Schema

Generated per workspace by the `ai.secrets` supervisor:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/auto",
  "autoupdate": false,
  "provider": {
    "openrouter": {
      "apiKey": "{env:OPENROUTER_API_KEY}",
      "models": {
        "openrouter/auto": {
          "options": {
            "reasoningEffort": "medium"
          }
        }
      }
    },
    "google": {
      "apiKey": "{env:GEMINI_API_KEY}"
    }
  },
  "permissions": [
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "edit", "resource": "*", "effect": "ask" },
    { "action": "bash", "resource": "*", "effect": "ask" }
  ],
  "mcp": {
    "servers": {
      "secrets": {
        "type": "local",
        "command": ["node", "/path/to/dist/mcp/secrets-mcp.js"],
        "enabled": true
      },
      "github": {
        "type": "local",
        "command": ["node", "/path/to/dist/mcp/github-mcp.js"],
        "enabled": true
      }
    }
  },
  "agent": {
    "build": {
      "model": "openrouter/auto",
      "reasoningEffort": "medium"
    }
  }
}
```

---

## 5. Reasoning Effort & Step Limits

OpenCode supports effort tiers (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) via:
1. `provider.<id>.models.<model>.options.reasoningEffort` (OpenRouter / OpenAI-compatible)
2. `provider.anthropic.models.<model>.options.thinking` (`{ type: "enabled", budgetTokens }`)
3. `agent.build.reasoningEffort`
4. `--variant <tier>` on CLI

`ai.secrets` maps Secrets effort levels to both OpenCode reasoning options and max agent steps:

| Secrets Effort | Max Agent Steps | OpenRouter `reasoningEffort` | Custom Thinking Budget |
|---|---|---|---|
| `low` | `3` | `"low"` | — |
| `medium` | `8` | `"medium"` | — |
| `high` | `20` | `"high"` | — |
| `custom` | `effort.maxSteps` (1–100) | `"none"` if budget ≤ 0, else `"medium"` + `budgetTokens` | `effort.thinkingBudget` |

---

## 6. API Key Injection

- Keys are **never** written raw to `opencode.json` or logged.
- `opencode.json` uses `{env:OPENROUTER_API_KEY}` / `{env:GEMINI_API_KEY}` references.
- The supervisor injects the active key into the spawned `opencode serve` child process environment (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `SECRETS_TOKEN`, `SECRETS_API_URL`).
- Key resolution priority in `ai.secrets`:
  1. Per-session/request header (`x-provider-key`)
  2. Environment variable (`OPENROUTER_API_KEY` / `GEMINI_API_KEY`)
  3. Local config file `~/.config/secrets-ai/config.json` (mode `0600`)
