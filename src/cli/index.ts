#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AiEvent, PermissionDecision } from "../events.js";
import {
  ensureBridgeToken,
  getAuthFilePath,
  readStoredConfig,
  redactSecrets,
  writeStoredConfig,
  type StoredAuthConfig,
} from "../security/auth.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8790";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx);
      const val = arg.slice(eqIdx + 1);
      flags[key] = val;
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const val = flags[name];
  return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  const val = flags[name];
  return val === true || val === "true" || val === "1";
}

function printUsage(): void {
  console.log(`secrets-ai — CLI for ai.secrets

Usage:
  secrets-ai init [--openrouter-key <key>] [--gemini-key <key>] [--github-token <tok>] [--secrets-url <url>] [--secrets-token <tok>]
  secrets-ai auth [--rotate]
  secrets-ai serve [--port 8790] [--host 127.0.0.1]
  secrets-ai models [--free-tools] [--provider openrouter|gemini] [--url ${DEFAULT_BASE_URL}]
  secrets-ai settings [--provider <p>] [--model <m>] [--effort low|medium|high|custom] [--agent-mode true|false] [--url ${DEFAULT_BASE_URL}]
  secrets-ai run "<prompt>" [--url ${DEFAULT_BASE_URL}] [--model <m>] [--auto-approve]
  secrets-ai chat [--url ${DEFAULT_BASE_URL}]
  secrets-ai --help | -h`);
}

function getBaseUrl(flags: Record<string, string | boolean>): string {
  const raw = stringFlag(flags, "url") ?? process.env.SECRETS_AI_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function getBearerToken(): string | undefined {
  return process.env.SECRETS_AI_TOKEN?.trim() || readStoredConfig()?.bridgeToken;
}

function authHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function collectKnownSecrets(config: StoredAuthConfig | null): (string | undefined)[] {
  return [
    process.env.SECRETS_AI_TOKEN,
    process.env.OPENROUTER_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GITHUB_TOKEN,
    process.env.SECRETS_TOKEN,
    config?.bridgeToken,
    config?.openrouterKey,
    config?.geminiKey,
    config?.githubToken,
    config?.secretsToken,
  ];
}

function logError(message: string, config: StoredAuthConfig | null = readStoredConfig()): void {
  console.error(redactSecrets(message, collectKnownSecrets(config)));
}

async function cmdInit(flags: Record<string, string | boolean>): Promise<number> {
  const existing = readStoredConfig();
  const bridgeToken = ensureBridgeToken();

  let openrouterKey = stringFlag(flags, "openrouter-key");
  let geminiKey = stringFlag(flags, "gemini-key");
  let githubToken = stringFlag(flags, "github-token");
  let secretsApiUrl = stringFlag(flags, "secrets-url");
  let secretsToken = stringFlag(flags, "secrets-token");

  const hasAnyFlag = Boolean(
    openrouterKey || geminiKey || githubToken || secretsApiUrl || secretsToken || boolFlag(flags, "non-interactive")
  );

  if (!hasAnyFlag && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const promptOptional = async (label: string, current: string | undefined): Promise<string | undefined> => {
        const hint = current ? " [configured, Enter to keep]" : " [optional]";
        const ans = (await rl.question(`${label}${hint}: `)).trim();
        return ans || undefined;
      };
      openrouterKey = await promptOptional("OpenRouter API key", existing?.openrouterKey);
      geminiKey = await promptOptional("Gemini API key", existing?.geminiKey);
      githubToken = await promptOptional("GitHub token", existing?.githubToken);
      secretsApiUrl = await promptOptional("Secrets API URL", existing?.secretsApiUrl);
      secretsToken = await promptOptional("Secrets API token", existing?.secretsToken);
    } finally {
      rl.close();
    }
  }

  const nextConfig: StoredAuthConfig = {
    ...(existing ?? {}),
    bridgeToken,
    ...(openrouterKey ? { openrouterKey } : {}),
    ...(geminiKey ? { geminiKey } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(secretsApiUrl ? { secretsApiUrl } : {}),
    ...(secretsToken ? { secretsToken } : {}),
  };

  const filePath = writeStoredConfig(nextConfig);
  console.log(`Initialized secrets-ai config at ${filePath} (mode 0600)`);
  console.log(`  bridgeToken:   configured`);
  console.log(`  openrouterKey: ${nextConfig.openrouterKey ? "configured" : "not set"}`);
  console.log(`  geminiKey:     ${nextConfig.geminiKey ? "configured" : "not set"}`);
  console.log(`  githubToken:   ${nextConfig.githubToken ? "configured" : "not set"}`);
  console.log(`  secretsToken:  ${nextConfig.secretsToken ? "configured" : "not set"}`);
  console.log(`  secretsApiUrl: ${nextConfig.secretsApiUrl ? nextConfig.secretsApiUrl : "not set"}`);
  return 0;
}

async function cmdAuth(flags: Record<string, string | boolean>): Promise<number> {
  const filePath = getAuthFilePath();
  let config = readStoredConfig();

  if (boolFlag(flags, "rotate")) {
    const bridgeToken = `sai_${randomBytes(24).toString("hex")}`;
    config = {
      ...(config ?? {}),
      bridgeToken,
    };
    writeStoredConfig(config);
    console.log(`Rotated bridge Bearer token in ${filePath}`);
  }

  console.log(`Config file: ${filePath}`);
  console.log(`  bridgeToken:   ${config?.bridgeToken ? "configured" : "not set"}`);
  console.log(`  openrouterKey: ${config?.openrouterKey ? "configured" : "not set"}`);
  console.log(`  geminiKey:     ${config?.geminiKey ? "configured" : "not set"}`);
  console.log(`  githubToken:   ${config?.githubToken ? "configured" : "not set"}`);
  console.log(`  secretsToken:  ${config?.secretsToken ? "configured" : "not set"}`);
  console.log(`  secretsApiUrl: ${config?.secretsApiUrl ? config.secretsApiUrl : "not set"}`);
  return 0;
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<number> {
  const portRaw = stringFlag(flags, "port") ?? process.env.PORT ?? "8790";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${portRaw}`);
    return 1;
  }
  const host = stringFlag(flags, "host") ?? process.env.HOST ?? "127.0.0.1";

  ensureBridgeToken();
  const { buildApp } = await import("../app.js");
  const app = await buildApp();

  try {
    await app.listen({ port, host });
  } catch (err) {
    logError(`Failed to start server: ${(err as Error).message}`);
    return 1;
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      app.close().finally(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

async function cmdModels(flags: Record<string, string | boolean>): Promise<number> {
  const baseUrl = getBaseUrl(flags);
  const token = getBearerToken();
  const params = new URLSearchParams();

  const provider = stringFlag(flags, "provider");
  if (provider) {
    if (provider !== "openrouter" && provider !== "gemini" && provider !== "mock") {
      console.error('Invalid --provider. Expected "openrouter" or "gemini".');
      return 1;
    }
    params.set("provider", provider);
  }
  if (boolFlag(flags, "free-tools")) {
    params.set("free_tools", "1");
  }

  const query = params.toString();
  const url = `${baseUrl}/v1/models${query ? `?${query}` : ""}`;

  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    const bodyText = await res.text();
    if (!res.ok) {
      logError(`GET /v1/models failed (${res.status}): ${bodyText}`);
      return 1;
    }
    const data = JSON.parse(bodyText) as { models?: Array<{ id: string; name?: string }> };
    const models = data.models ?? [];
    for (const m of models) {
      console.log(m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id);
    }
    return 0;
  } catch (err) {
    logError(`Request failed: ${(err as Error).message}`);
    return 1;
  }
}

async function cmdSettings(flags: Record<string, string | boolean>): Promise<number> {
  const baseUrl = getBaseUrl(flags);
  const token = getBearerToken();

  const provider = stringFlag(flags, "provider");
  const model = stringFlag(flags, "model");
  const effort = stringFlag(flags, "effort");
  const agentModeRaw = stringFlag(flags, "agent-mode");

  const hasUpdates = Boolean(provider || model || effort || agentModeRaw !== undefined);

  if (!hasUpdates) {
    try {
      const res = await fetch(`${baseUrl}/v1/settings`, { headers: authHeaders(token) });
      const text = await res.text();
      if (!res.ok) {
        logError(`GET /v1/settings failed (${res.status}): ${text}`);
        return 1;
      }
      console.log(JSON.stringify(JSON.parse(text), null, 2));
      return 0;
    } catch (err) {
      logError(`Request failed: ${(err as Error).message}`);
      return 1;
    }
  }

  const payload: Record<string, unknown> = {};
  if (provider) payload.provider = provider;
  if (model) payload.model = model;
  if (effort) {
    if (!["low", "medium", "high", "custom"].includes(effort)) {
      console.error('Invalid --effort. Expected "low", "medium", "high", or "custom".');
      return 1;
    }
    payload.effort = { level: effort };
  }
  if (agentModeRaw !== undefined) {
    if (agentModeRaw !== "true" && agentModeRaw !== "false") {
      console.error('Invalid --agent-mode. Expected "true" or "false".');
      return 1;
    }
    payload.agentMode = agentModeRaw === "true";
  }

  try {
    const res = await fetch(`${baseUrl}/v1/settings`, {
      method: "PUT",
      headers: authHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      logError(`PUT /v1/settings failed (${res.status}): ${text}`);
      return 1;
    }
    console.log(JSON.stringify(JSON.parse(text), null, 2));
    return 0;
  } catch (err) {
    logError(`Request failed: ${(err as Error).message}`);
    return 1;
  }
}

async function respondToPermission(
  baseUrl: string,
  token: string | undefined,
  permissionId: string,
  sessionId: string,
  decision: PermissionDecision
): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/permissions/${encodeURIComponent(permissionId)}/respond`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ decision, sessionId }),
  });
  if (!res.ok) {
    const msg = await res.text();
    logError(`Permission response failed (${res.status}): ${msg}`);
  }
}

async function promptPermissionDecision(rl: ReadlineInterface, action: string, detail: unknown): Promise<PermissionDecision> {
  const detailText = detail !== undefined ? ` (${JSON.stringify(detail)})` : "";
  process.stdout.write(`\nPermission requested: ${action}${detailText}\n`);
  const ans = (await rl.question("[a]llow / [d]eny / allow_[s]ession: ")).trim().toLowerCase();
  if (ans === "a" || ans === "allow") return "allow";
  if (ans === "s" || ans === "allow_session") return "allow_session";
  return "deny";
}

interface StreamOptions {
  baseUrl: string;
  token: string | undefined;
  sessionId: string;
  prompt: string;
  model?: string;
  autoApprove?: boolean;
  rl?: ReadlineInterface;
}

async function streamMessageEvents(opts: StreamOptions): Promise<number> {
  const res = await fetch(`${opts.baseUrl}/v1/sessions/${encodeURIComponent(opts.sessionId)}/messages`, {
    method: "POST",
    headers: authHeaders(opts.token, {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    }),
    body: JSON.stringify({
      content: opts.prompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.autoApprove !== undefined ? { autoApprove: opts.autoApprove } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    logError(`POST /v1/sessions/${opts.sessionId}/messages failed (${res.status}): ${errText}`);
    return 1;
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let wroteOutput = false;
  let exitCode = 0;

  const handleEvent = async (event: AiEvent): Promise<"continue" | "idle" | "error"> => {
    switch (event.type) {
      case "text.delta":
        process.stdout.write(event.text);
        wroteOutput = true;
        return "continue";
      case "reasoning.delta":
        process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
        wroteOutput = true;
        return "continue";
      case "tool.start":
        process.stdout.write(`\n[tool: ${event.name}]\n`);
        wroteOutput = true;
        return "continue";
      case "tool.end":
        if (event.error) {
          logError(`[tool error] ${event.error}`);
        }
        return "continue";
      case "permission.request": {
        let decision: PermissionDecision;
        if (opts.rl) {
          decision = await promptPermissionDecision(opts.rl, event.action, event.detail);
        } else {
          decision = opts.autoApprove ? "allow" : "deny";
        }
        await respondToPermission(opts.baseUrl, opts.token, event.permissionId, event.sessionId, decision);
        return "continue";
      }
      case "question":
        process.stdout.write(`\n[question] ${event.text}\n`);
        wroteOutput = true;
        return "continue";
      case "error":
        logError(`Error: ${event.message}`);
        exitCode = 1;
        return "error";
      case "session.idle":
        return "idle";
      case "usage":
        return "continue";
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex = buffer.indexOf("\n");
    while (sepIndex !== -1) {
      const line = buffer.slice(0, sepIndex).replace(/\r$/, "");
      buffer = buffer.slice(sepIndex + 1);

      if (line.startsWith("data:")) {
        const rawJson = line.slice(5).trim();
        if (rawJson) {
          let parsed: AiEvent | null = null;
          try {
            parsed = JSON.parse(rawJson) as AiEvent;
          } catch {
            // Ignore malformed SSE event chunks
          }
          if (parsed) {
            const status = await handleEvent(parsed);
            if (status === "idle" || status === "error") {
              await reader.cancel().catch(() => {});
              if (wroteOutput) process.stdout.write("\n");
              return exitCode;
            }
          }
        }
      }
      sepIndex = buffer.indexOf("\n");
    }
  }

  if (wroteOutput) process.stdout.write("\n");
  return exitCode;
}

async function createSession(baseUrl: string, token: string | undefined, model?: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(model ? { model } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    logError(`POST /v1/sessions failed (${res.status}): ${text}`);
    return null;
  }
  const parsed = JSON.parse(text) as { id?: string; session?: { id?: string } };
  const id = parsed.id ?? parsed.session?.id;
  if (!id) {
    console.error("Server did not return a session id.");
    return null;
  }
  return id;
}

async function cmdRun(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error('Missing prompt. Usage: secrets-ai run "<prompt>"');
    return 1;
  }

  const baseUrl = getBaseUrl(flags);
  const token = getBearerToken();
  const model = stringFlag(flags, "model");
  const autoApprove = boolFlag(flags, "auto-approve");

  try {
    const sessionId = await createSession(baseUrl, token, model);
    if (!sessionId) return 1;
    return await streamMessageEvents({ baseUrl, token, sessionId, prompt, model, autoApprove });
  } catch (err) {
    logError(`Run failed: ${(err as Error).message}`);
    return 1;
  }
}

async function cmdChat(flags: Record<string, string | boolean>): Promise<number> {
  const baseUrl = getBaseUrl(flags);
  const token = getBearerToken();

  let sessionId: string | null = null;
  try {
    sessionId = await createSession(baseUrl, token);
  } catch (err) {
    logError(`Failed to create session: ${(err as Error).message}`);
    return 1;
  }
  if (!sessionId) return 1;

  console.log(`Connected to session ${sessionId}. Type /exit to quit.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question("> ");
      } catch {
        break;
      }
      const prompt = line.trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;

      await streamMessageEvents({ baseUrl, token, sessionId, prompt, rl });
    }
  } finally {
    rl.close();
  }

  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || positional.length === 0) {
    printUsage();
    return 0;
  }

  const [command, ...rest] = positional;
  switch (command) {
    case "init":
      return cmdInit(flags);
    case "auth":
      return cmdAuth(flags);
    case "serve":
      return cmdServe(flags);
    case "models":
      return cmdModels(flags);
    case "settings":
      return cmdSettings(flags);
    case "run":
      return cmdRun(rest, flags);
    case "chat":
      return cmdChat(flags);
    case "help":
      printUsage();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      logError(`Fatal error: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
