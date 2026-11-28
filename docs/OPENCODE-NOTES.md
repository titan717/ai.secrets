# OpenCode integration notes (verified)

Verified on 2026-11-28 against **opencode-ai 1.19.6** (latest on npm, published 2026-11-17) by running the real binary in a sandbox, reading its live OpenAPI spec (`GET /doc`, 472 schemas) and recording real event traces. Sources: the binary itself, [OpenCode server docs](https://opencode.ai/docs/server/), [config docs](https://opencode.ai/docs/config/), [config JSON schema](https://opencode.ai/config.json), [OpenRouter API reference](https://openrouter.ai/docs/api-reference/list-available-models).

Every claim marked **(verified)** was observed against the real binary, not taken from docs.

## 1. `opencode serve`

```
opencode serve [--port 0] [--hostname 127.0.0.1] [--cors <origin>...] [--mdns] [--log-level DEBUG|INFO|WARN|ERROR] [--print-logs] [--pure]
```

- `--port 0` (default) picks a free port. On start it prints `opencode server listening on http://127.0.0.1:<port>` to **stdout** **(verified)**. The supervisor parses that line, which avoids port races.
- Default hostname is `127.0.0.1` **(verified)**.
- `OPENCODE_SERVER_PASSWORD=<pw>` enables HTTP Basic auth (user `opencode`, override with `OPENCODE_SERVER_USERNAME`). With it set, **every** route, including `/doc` and `/global/health`, returns 401 without credentials **(verified)**. Without it, OpenCode warns `server is unsecured`. **The supervisor always sets a random per-child password.**
- Health: `GET /global/health` → `{"healthy":true,"version":"1.19.6"}` **(verified)**.
- OpenAPI 3.1 spec: `GET /doc` **(verified)**.
- `cwd` of the child = workspace directory. Most routes also accept `?directory=` to target another project.
- Config is read from `<cwd>/opencode.json` (project) merged over global `~/.config/opencode/opencode.json`. We isolate global state by giving each child its own `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` under `~/.config/secrets-ai/workspaces/<id>/`. That way we never read or modify the user's personal OpenCode auth. The opencode.json path can also be forced with `OPENCODE_CONFIG=<file>`.

## 2. HTTP routes the bridge uses (verified in /doc)

| Purpose | Route | Body / notes |
| --- | --- | --- |
| Create session | `POST /session` | `{ title?, parentID?, agent?, model?: {id, providerID, variant?}, permission? }` → `Session {id:"ses_…", directory, title, cost, tokens, time}` |
| List sessions | `GET /session` | `Session[]` |
| Get / delete / rename | `GET/DELETE/PATCH /session/{id}` | |
| Prompt (blocking) | `POST /session/{id}/message` | returns the final assistant message when the turn completes |
| **Prompt (async)** | `POST /session/{id}/prompt_async` | **204**; progress arrives on `/event`. Body: `{ parts: [{type:"text", text}], model?: {providerID, modelID}, agent?, system?, variant?, tools?: {name: bool}, messageID?, noReply? }` |
| Abort | `POST /session/{id}/abort` | → `true` |
| Messages | `GET /session/{id}/message` | history `{info, parts}[]` (used for reconnect/replay) |
| Status | `GET /session/status` | `{ [sessionID]: {type:"idle"|"busy"|"retry", …} }` |
| Pending permissions | `GET /permission` | `PermissionRequest[]` |
| **Reply permission** | `POST /permission/{requestID}/reply` | `{ reply: "once" \| "always" \| "reject", message? }` |
| Pending questions | `GET /question` | |
| Answer question | `POST /question/{requestID}/reply` | `{ answers: string[][] }` (one array of selected labels per question) |
| Reject question | `POST /question/{requestID}/reject` | |
| Providers + models | `GET /config/providers` | `{ providers: Provider[], default: {providerID: modelID} }`. Each model has `capabilities.toolcall`, `cost`, `limit`, `variants` |
| Set provider key | `PUT /auth/{providerID}` | `{ type:"api", key }`, persisted in the child's isolated `XDG_DATA_HOME` |
| Events | `GET /event` | SSE, `data: {id:"evt_…", type, properties}` |

The legacy `POST /session/{id}/permissions/{permissionID}` still exists, but `/permission/{id}/reply` is the current route. The `/api/*` tree is a newer, experimental v2 API that we do not use yet.

## 3. Event stream (verified with recorded traces)

The first event is `server.connected`, followed by periodic `server.heartbeat` events. Events are global, so the bridge filters by `properties.sessionID`. Recorded real traces live in `tests/fixtures/traces/*.jsonl` (scenarios: text, basic tool + permission allow, deny, question, provider error, abort).

Turn lifecycle, observed in this order:

1. `message.updated` (user message, `info.role:"user"`) → `message.part.updated` (its text part; **ignore it**, because this is the user's own prompt).
2. `session.status {status:{type:"busy"}}`.
3. `message.updated` (assistant message, tokens 0).
4. `message.part.updated part.type:"step-start"`.
5. `message.part.updated part.type:"reasoning"|"text"` with empty text, which **announces the part id and type**.
6. `message.part.delta {sessionID, messageID, partID, field:"text", delta}`. **The delta does not carry the part type.** The normalizer must remember `partID → type` from step 5 (the main bug in the previous implementation).
7. `message.part.updated` again with the full accumulated `text` (and `time.end`). Do not re-emit it. Only emit any suffix that was not already streamed as a delta, because some providers do not stream.
8. Tool parts: `message.part.updated part.type:"tool"` with `tool`, `callID`, `state.status`: `pending` (input `{}`) → `running` (input filled; may repeat) → `completed` (`state.output`, `state.title`, `state.metadata`) or `error` (`state.error`, e.g. `"The user rejected permission to use this specific tool call."`).
9. Permission: `permission.asked {id:"per_…", sessionID, permission:"bash", patterns:["echo hi > b.txt"], metadata:{command}, always:["echo *"], tool:{messageID, callID}}`, then `permission.replied {sessionID, requestID, reply}`.
10. Question tool: `question.asked {id:"que_…", sessionID, questions:[{question, header, options:[{label, description}], multiple?, custom?}], tool}`, then `question.replied {requestID, answers}`.
11. `message.part.updated part.type:"step-finish"`, then `message.updated` (assistant) with `finish:"tool-calls"|"stop"`, `tokens:{total,input,output,reasoning,cache:{read,write}}`, `cost`, and finally `time.completed`. A completed assistant message is the usage event.
12. Multi-step turns repeat 3–11 per step.
13. End of turn: `session.status {type:"idle"}`, then **`session.idle {sessionID}`**.
14. Errors: `session.error {sessionID, error:{name, data:{message, statusCode?, isRetryable?, responseBody?, responseHeaders?}}}`. Names: `ProviderAuthError`, `APIError`, `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError` (on abort), `ContextOverflowError`, `ContentFilterError`, `StructuredOutputError`. `session.idle` still follows. **Never forward `responseBody`/`responseHeaders`**, because they can echo request details.
15. Retries: `session.status {type:"retry", attempt, message, next, action?}`. Observed live with OpenCode's own free tier: `"Free usage exceeded, subscribe to Go"`.

Other part types seen: `patch` (file diff summary after edits), `file`, `subtask`, `agent`, `compaction`. Other events: `session.diff`, `session.updated`, `session.created`, `todo.updated`, `file.edited`.

## 4. opencode.json (verified with the 1.19.6 binary)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/openai/gpt-5-mini",        // "<providerID>/<modelID>"
  "small_model": "openrouter/openai/gpt-5-mini",  // used for titles/summaries
  "provider": {
    "openrouter": { "options": { "headers": { "HTTP-Referer": "...", "X-Title": "Secrets" } } },
    "mock": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://127.0.0.1:PORT/v1", "apiKey": "x" },
              "models": { "mock-1": { "name": "Mock", "tool_call": true, "reasoning": true } } }
  },
  "permission": { "edit": "ask", "bash": "ask", "webfetch": "ask", "read": "allow", "question": "allow", "<mcp>_*": "ask" },
  "agent": { "build": { "steps": 8, "prompt": "...", "permission": { ... } }, "plan": { "steps": 8 } },
  "mcp": {
    "secrets": { "type": "local", "command": ["node", "/abs/dist/mcp/secrets-mcp.js"], "environment": { "SECRETS_API_URL": "..." }, "enabled": true },
    "github":  { "type": "remote", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }, "enabled": true }
  }
}
```

- `agent.<name>.steps` = maximum agentic iterations before forcing a text-only answer (`maxSteps` is deprecated). This is how Low/Medium/High/Custom map to 3/8/20/N.
- Permission values: `"allow" | "ask" | "deny"`, or an object of glob pattern → action (for example `bash: {"git status*": "allow", "*": "ask"}`).
- `{env:VAR}` substitution is supported in config strings, which keeps secrets off disk.
- The published schema at opencode.ai is already moving to plural keys (`agents`, `permissions`, `providers`, all marked as the future). The singular keys above are what 1.19.6 accepts and are still in the schema (deprecated but supported). Revisit this when upgrading.

## 5. API keys

- OpenRouter: env `OPENROUTER_API_KEY` (provider `env` list in `/config/providers`) **(verified)**.
- Google/Gemini: provider id `google`, env `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` **(verified)**.
- Runtime injection without restart: `PUT /auth/{providerID} {type:"api", key}` (stored in the child's isolated data dir, which is 0700 under our config dir).
- The bridge passes keys only via the child's environment or `/auth`. It never writes them into opencode.json.

## 6. Reasoning effort = model variants (verified)

OpenCode exposes per-model `variants` in `/config/providers`. Each variant is a named set of provider options:

| Model (OpenRouter) | Variants |
| --- | --- |
| `openai/gpt-5-mini` | minimal, low, medium, high → `{reasoning:{effort}}` |
| `anthropic/claude-sonnet-4.5` | low, medium, high |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | none, medium, high |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | high, max → `{reasoning:{max_tokens}}` |
| `particle-ai/particle-1:free` | none, minimal, low, medium, high, xhigh, max |
| `openrouter/free`, `liquid/lfm-3-1.7b:free` | none |

The variant is selected per prompt (`variant` in the `prompt_async` body) or per agent (`agent.build.variant`). The effort mapping therefore must choose the **nearest available** variant for the selected model (see `src/presets/effort.ts`), and omit it when the model has none.

## 7. Testing without keys

- `tests/fixtures/mock-llm.mjs` is a scripted OpenAI-compatible server. Configured as a custom `@ai-sdk/openai-compatible` provider, it lets the **real** OpenCode run full agent loops (tools, permissions, questions, errors, abort) offline. `scripts/record-traces.mjs` uses it to record the fixtures.
- `tests/fixtures/fake-opencode.mjs` replays those recorded traces and implements the routes above, so CI runs without the opencode binary.
- `OPENCODE_REAL=1 pnpm test:real` runs the e2e suite against the real binary and the mock LLM.

## 8. SDK

`@opencode-ai/sdk` exists, but we use plain `fetch` with a small typed client (`src/opencode/client.ts`) to avoid coupling to SDK release cadence and to keep the Termux install light. The client only touches the routes listed in section 2.
