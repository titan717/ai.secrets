import type { OpenCodeConfigInput } from "../core/types.js";
import { githubMcpEntry, mcpPermissions, secretsMcpEntry, GITHUB_SERVER, SECRETS_SERVER } from "../mcp/presets.js";
import { resolveEffort } from "./effort.js";
import { APP_REFERER, APP_TITLE, SMALL_MODELS, modelRef } from "./providers.js";

export const CONFIG_SCHEMA = "https://opencode.ai/config.json";

/** Base permissions for every agent. */
export const BASE_PERMISSION = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  question: "allow",
  external_directory: "ask",
} as const;

/**
 * Build the workspace opencode.json. Never contains secret values: keys reach OpenCode via the
 * child's env (see buildProviderEnv) and are referenced here only as `{env:VAR}`.
 */
export function buildOpenCodeConfig(input: OpenCodeConfigInput): Record<string, unknown> {
  const { settings, available } = input;
  const ref = modelRef(settings);
  const model = `${ref.providerID}/${ref.modelID}`;
  const small = SMALL_MODELS[ref.providerID] ? `${ref.providerID}/${SMALL_MODELS[ref.providerID]}` : model;
  const { steps } = resolveEffort(settings.effort);

  const provider: Record<string, unknown> = {};
  if (ref.providerID === "openrouter") {
    provider.openrouter = { options: { headers: { "HTTP-Referer": APP_REFERER, "X-Title": APP_TITLE } } };
  }

  const mcp: Record<string, unknown> = {};
  const useGithub = Boolean(settings.tools?.github && available.github);
  const useSecrets = Boolean(settings.tools?.secrets && available.secrets && settings.secretsApiUrl);
  if (useGithub) mcp[GITHUB_SERVER] = githubMcpEntry();
  if (useSecrets) mcp[SECRETS_SERVER] = secretsMcpEntry({ nodePath: input.nodePath, entry: input.secretsMcpEntry, apiUrl: settings.secretsApiUrl! });

  const servers = { github: useGithub, secrets: useSecrets };
  const permission = { ...BASE_PERMISSION, ...mcpPermissions(servers, "ask") };

  const build: Record<string, unknown> = { steps };
  const plan: Record<string, unknown> = {
    steps,
    permission: { edit: "deny", bash: "deny", ...mcpPermissions(servers, "deny") },
  };
  const prompt = settings.systemPrompt?.trim();
  if (prompt) {
    build.prompt = prompt;
    plan.prompt = prompt;
  }

  const cfg: Record<string, unknown> = {
    $schema: CONFIG_SCHEMA,
    model,
    small_model: small,
    // Defense in depth: never let an env GitHub token activate the Copilot provider.
    disabled_providers: ["github-copilot"],
    permission,
    agent: { build, plan },
  };
  if (Object.keys(provider).length) cfg.provider = provider;
  if (Object.keys(mcp).length) cfg.mcp = mcp;
  return cfg;
}
