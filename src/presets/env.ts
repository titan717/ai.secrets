import type { Secrets } from "../core/types.js";
import { GOOGLE_ENV_KEYS } from "./providers.js";

/** Only the env vars OpenCode (and the MCP {env:...} substitutions) need. */
export function buildProviderEnv(secrets: Secrets): Record<string, string> {
  const env: Record<string, string> = {};
  const s = secrets ?? {};
  if (s.openrouterApiKey) env.OPENROUTER_API_KEY = s.openrouterApiKey;
  if (s.geminiApiKey) for (const k of GOOGLE_ENV_KEYS) env[k] = s.geminiApiKey;
  if (s.githubToken) env.GITHUB_TOKEN = s.githubToken;
  if (s.secretsToken) env.SECRETS_TOKEN = s.secretsToken;
  return env;
}
