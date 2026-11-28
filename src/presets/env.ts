import type { Secrets } from "../core/types.js";
import { GOOGLE_ENV_KEYS } from "./providers.js";
import { GITHUB_TOKEN_ENV, SECRETS_TOKEN_ENV } from "../mcp/presets.js";

/**
 * Only the env vars OpenCode (and the MCP {env:...} substitutions) need. MCP credentials use
 * private names: a plain GITHUB_TOKEN would auto-activate OpenCode's github-copilot provider
 * (verified in 1.19.6) and attach the PAT to it.
 */
export function buildProviderEnv(secrets: Secrets): Record<string, string> {
  const env: Record<string, string> = {};
  const s = secrets ?? {};
  if (s.openrouterApiKey) env.OPENROUTER_API_KEY = s.openrouterApiKey;
  if (s.geminiApiKey) for (const k of GOOGLE_ENV_KEYS) env[k] = s.geminiApiKey;
  if (s.githubToken) env[GITHUB_TOKEN_ENV] = s.githubToken;
  if (s.secretsToken) env[SECRETS_TOKEN_ENV] = s.secretsToken;
  return env;
}
