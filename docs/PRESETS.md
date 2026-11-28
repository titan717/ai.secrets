# Provider presets (`src/presets`)

`src/presets/index.ts` exports `PROVIDER_PRESETS`, `buildOpenCodeConfig`, `buildProviderEnv`, `resolveEffort`, `listModels`, `testConnection`, `modelRef`, `sanitizeOpenCodeProviders`, `stepsFor` and the token fingerprints (`secretsTokenFingerprint`, `githubTokenFingerprint`, `mcpCredentialFingerprint`; see [MCP.md](MCP.md#token-rotation-600-s-secrets-tokens)).

## Providers

| id | Child env | Settings key | Default model | small_model |
| --- | --- | --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouterApiKey` | `openrouter/free` | `openrouter/free` |
| `google` (Gemini) | `GEMINI_API_KEY` + `GOOGLE_GENERATIVE_AI_API_KEY` | `geminiApiKey` | `gemini-2.5-flash` | `gemini-2.5-flash-lite` |

opencode 1.19.6 reads Google keys from `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` (verified via `/config/providers`). `modelRef()` strips the `google/` and `models/` prefixes. For OpenRouter, the generated config sets `provider.openrouter.options.headers` to `HTTP-Referer: https://github.com/titan717/secrets` and `X-Title: Secrets` (the override was verified).

## Generated opencode.json (`buildOpenCodeConfig`)

- `model` and `small_model`.
- `disabled_providers: ["github-copilot"]`.
- Permissions: `edit`, `bash`, `webfetch` and `external_directory` are `ask`. `read`, `glob`, `grep`, `list` and `question` are `allow`.
- MCP rules, see [MCP.md](MCP.md).
- `agent.build.steps`. `agent.plan` with `edit`/`bash`/MCP writes denied.
- `mcp`, only when the server is enabled and credentialed.
- No keys, and no variant. The bridge sends `variant` with each prompt.
- `tests/unit/opencode-config.real.test.ts` loads the config into the real binary.

## Effort (`resolveEffort`)

| Level | steps | variant |
| --- | --- | --- |
| low | 3 | nearest to `low` |
| medium | 8 | nearest to `medium` |
| high | 20 | `high`, else `xhigh`, else `max`, else nearest |
| custom | `maxSteps` clamped 1..200 (default 8) | `effort.variant` if the model has it |

`stepsFor(settings | effort, override?)` returns the same steps value that goes into `agent.<mode>.steps`. The normalizer uses it so step events can carry `maxSteps`.

Scale: none < minimal < low < medium < high < xhigh < max. Ties go to the higher variant. If a model has no variants or `reasoning: false`, no variant is sent.

Variants observed in opencode 1.19.6:

| Models | Variants |
| --- | --- |
| gemini-2.5-flash / flash-lite / pro | `high`, `max` |
| gemini-3.1-pro-preview, flash-latest, pro-latest | `low`, `medium`, `high` |
| gemini-3-flash-preview | from `minimal` up |
| openai/gpt-5-mini | `minimal`, `low`, `medium`, `high` |
| anthropic/claude-sonnet-4.5 | `low`, `medium`, `high` |
| openrouter/free | none |

## Model listing (`listModels`, `testConnection`)

The list is cached for 5 minutes and requests time out after 15 s.

| Provider | Models endpoint | Key check |
| --- | --- | --- |
| OpenRouter | `GET https://openrouter.ai/api/v1/models?supported_parameters=tools` (public) ([docs](https://openrouter.ai/docs/api-reference/list-available-models)) | `GET /api/v1/key` with Bearer; a bad key returns 401 ([docs](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)) |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` with `x-goog-api-key`, paged with `pageSize`/`pageToken` ([docs](https://ai.google.dev/api/models)) | The same call; a bad key returns 400 `API_KEY_INVALID` |

Errors map to: "Invalid API key" (400 `API_KEY_INVALID`, 401, 403), "Insufficient credits" (402) and "Rate limited" (429). OpenRouter pricing comes as strings (`"-1"` for routers). Gemini `free` is always `false`.

## sanitizeOpenCodeProviders(payload)

This deep-copies the payload and removes fields whose names look like keys: `key`, `apiKey`, `api_key`, `token`, `access_token`, `refresh_token`, `secret`, `client_secret`, `password`, `authorization`, `x-api-key` and `cookie`. Use it on any `/config/providers` or `/config` payload before it goes to the UI.
