/** Argument parsing for `secrets-ai` (node:util parseArgs, no dependencies). */
import { parseArgs } from "node:util";
import { validateSettingsPatch, SettingsError } from "../core/settings.js";
import type { Effort, Settings } from "../core/types.js";
import { DEFAULT_URL } from "./client.js";

export class UsageError extends Error {}

const OPTIONS = {
  // global
  url: { type: "string" },
  token: { type: "string" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  // command-specific
  provider: { type: "string" },
  model: { type: "string" },
  "key-stdin": { type: "boolean" },
  show: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  workspace: { type: "string" },
  "opencode-bin": { type: "string" },
  session: { type: "string" },
  effort: { type: "string" },
  "show-reasoning": { type: "boolean" },
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "deny-all": { type: "boolean" },
  "free-tools": { type: "boolean" },
  local: { type: "boolean" },
} as const;

type OptName = keyof typeof OPTIONS;
const GLOBAL: OptName[] = ["url", "token", "no-color", "help", "version"];

export const COMMANDS: Record<string, OptName[]> = {
  init: ["provider", "model", "key-stdin"],
  auth: ["show", "key-stdin"],
  serve: ["host", "port", "workspace", "opencode-bin"],
  chat: ["session", "model", "effort", "show-reasoning", "workspace", "local", "opencode-bin"],
  run: ["json", "yes", "deny-all", "session", "model", "effort", "show-reasoning", "workspace", "local", "opencode-bin"],
  models: ["provider", "free-tools", "json"],
  settings: ["json"],
  status: ["json", "opencode-bin"],
  doctor: ["json", "opencode-bin"],
  help: [],
};

/** Option names that look like someone is trying to pass a secret on the command line. */
const SECRET_FLAG = /^--?(?:[a-z-]*-)?(?:key|api-?key|apikey|secret|password|passwd|pat|github-token|openrouter|gemini|google-key)(?:=|$)/i;

export const SECRET_ARGV_MESSAGE =
  "API keys are never accepted as command-line arguments (they leak into shell history and `ps`). " +
  "Use `secrets-ai auth set <openrouter|google|github|secrets>` (hidden prompt) or pipe the key on stdin with --key-stdin.";

export interface Parsed {
  command: string;
  positionals: string[];
  flags: Partial<Record<OptName, string | boolean>>;
  global: { url: string; token?: string; noColor: boolean; help: boolean; version: boolean };
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = {}): Parsed {
  for (const a of argv) {
    if (a === "--") break;
    if (SECRET_FLAG.test(a) && !/^--key-stdin$/.test(a)) throw new UsageError(SECRET_ARGV_MESSAGE);
  }
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false }) as {
      values: Record<string, string | boolean | undefined>;
      positionals: string[];
    });
  } catch (err) {
    throw new UsageError(sanitize((err as Error).message));
  }
  const command = positionals[0] ?? (values.version ? "version" : "help");
  const rest = positionals.slice(1);
  const allowed = new Set<string>([...GLOBAL, ...(COMMANDS[command] ?? [])]);
  if (command !== "version" && !(command in COMMANDS)) throw new UsageError(`unknown command '${sanitize(command)}'. Run \`secrets-ai --help\`.`);
  const flags: Parsed["flags"] = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (!(k in OPTIONS)) throw new UsageError(`unknown option --${sanitize(k)}`);
    if (!allowed.has(k)) throw new UsageError(`option --${k} is not valid for '${command}'`);
    const def = OPTIONS[k as OptName];
    if (def.type === "string" && typeof v !== "string") throw new UsageError(`option --${k} requires a value`);
    if (def.type === "boolean" && typeof v !== "boolean") throw new UsageError(`option --${k} does not take a value`);
    flags[k as OptName] = v;
  }
  const url = (str(flags.url) ?? env.SECRETS_AI_URL ?? DEFAULT_URL).trim();
  if (!/^https?:\/\//i.test(url)) throw new UsageError("--url must start with http:// or https://");
  return {
    command,
    positionals: rest,
    flags,
    global: {
      url,
      token: str(flags.token) ?? (env.SECRETS_AI_TOKEN || undefined),
      noColor: flags["no-color"] === true,
      help: flags.help === true,
      version: flags.version === true,
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Strip anything after `=` so a mistyped `--foo=<secret>` is never echoed back. */
function sanitize(s: string): string {
  return s.replace(/=\S*/g, "=…").slice(0, 80);
}

/** Parse `low|medium|high|custom:<steps>[:<variant>]`. */
export function parseEffort(s: string): Effort {
  const [level, steps, variant] = s.trim().split(":");
  if (level === "low" || level === "medium" || level === "high") {
    if (steps !== undefined) throw new UsageError(`effort '${level}' takes no parameters`);
    return { level };
  }
  if (level === "custom") {
    const n = Number(steps);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new UsageError("custom effort needs steps 1..200, e.g. custom:12 or custom:12:high");
    const e: Effort = { level: "custom", maxSteps: n };
    if (variant) e.variant = variant;
    return e;
  }
  throw new UsageError("effort must be low|medium|high|custom:<steps>[:<variant>]");
}

export function formatEffort(e: Effort): string {
  if (e.level !== "custom") return e.level;
  return `custom:${e.maxSteps ?? "?"}${e.variant ? `:${e.variant}` : ""}`;
}

function parseBool(key: string, v: string): boolean {
  if (/^(true|1|yes|on)$/i.test(v)) return true;
  if (/^(false|0|no|off)$/i.test(v)) return false;
  throw new UsageError(`${key} must be true or false`);
}

const SETTINGS_KEYS = ["provider", "model", "effort", "agentMode", "tools.github", "tools.secrets", "systemPrompt", "secretsApiUrl"];

/**
 * Parse `key=value` assignments into a validated settings patch. `tools.*` keys come back as a
 * partial `tools` object; merge with current settings before sending (validateSettingsPatch
 * resets omitted toggles to false).
 */
export function parseSettingsAssignments(items: string[]): { patch: Record<string, unknown>; tools: Partial<Settings["tools"]> } {
  if (items.length === 0) throw new UsageError("usage: secrets-ai settings set key=value [key=value ...]");
  const patch: Record<string, unknown> = {};
  const tools: Partial<Settings["tools"]> = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new UsageError(`expected key=value, got '${item.slice(0, 40)}'`);
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1);
    switch (key) {
      case "provider":
      case "model":
      case "agentMode":
        patch[key] = value.trim();
        break;
      case "effort":
        patch.effort = parseEffort(value);
        break;
      case "tools.github":
      case "tools.secrets":
        tools[key.slice(6) as "github" | "secrets"] = parseBool(key, value.trim());
        break;
      case "systemPrompt":
        patch.systemPrompt = value === "" ? null : value;
        break;
      case "secretsApiUrl":
        patch.secretsApiUrl = value.trim() === "" ? null : value.trim();
        break;
      default:
        throw new UsageError(`unknown setting '${key.slice(0, 40)}'. Known: ${SETTINGS_KEYS.join(", ")}`);
    }
  }
  try {
    validateSettingsPatch(patch);
  } catch (err) {
    if (err instanceof SettingsError) throw new UsageError(err.message);
    throw err;
  }
  return { patch, tools };
}

export const HELP = `secrets-ai - terminal client and server for the ai.secrets OpenCode bridge

Usage: secrets-ai <command> [options]

Commands:
  init [--provider openrouter|google] [--model ID] [--key-stdin]
                           create the config dir and bridge token, optionally store a provider key
  auth token [--show]      print the bridge token (only to a terminal unless --show)
  auth set <openrouter|google|github|secrets> [--key-stdin]
                           store a key (hidden prompt or stdin; never argv)
  auth status              show which secrets are configured
  auth rotate              create a new bridge token
  serve [--host H] [--port P] [--workspace DIR] [--opencode-bin PATH]
                           run the bridge in the foreground
  chat [--session ID] [--model M] [--effort E] [--show-reasoning] [--local]
                           interactive chat (slash commands: /help)
  run "<prompt>" [--json] [--yes|--deny-all] [--session ID] [--model M] [--effort E] [--local]
                           one-shot prompt; --json prints AiEvent NDJSON
  models [--provider P] [--free-tools] [--json]
                           list models
  settings [get] [--json]  show settings
  settings set key=value ...
                           provider, model, effort=low|medium|high|custom:<steps>[:<variant>],
                           agentMode=build|plan, tools.github=true, tools.secrets=true,
                           systemPrompt=..., secretsApiUrl=...
  status | doctor [--json] check bridge, token, opencode binary, node, platform, config perms

Global options:
  --url URL        bridge URL (default $SECRETS_AI_URL or ${DEFAULT_URL})
  --token TOKEN    bridge token (default $SECRETS_AI_TOKEN or the auth file)
  --no-color       disable colors (NO_COLOR is honoured too)
  -h, --help       show help
  -v, --version    show version

--local (chat/run) starts a private bridge in-process for the duration of the command.
Permissions in \`run\`: prompts on a terminal; denied by default when stdin is not a TTY unless --yes.
Exit codes: 0 ok, 1 turn/API error, 2 usage error, 3 bridge unreachable, 130 interrupted.
`;
