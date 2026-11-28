import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Secrets } from "./types.js";
import { paths } from "./paths.js";
import { readJsonFile, writePrivateJson } from "./secure-file.js";

export interface AuthFile {
  /** Bridge bearer token. */
  token: string;
  secrets: Secrets;
}

export function generateToken(): string {
  return "sai_" + randomBytes(32).toString("base64url");
}

export function readAuthFile(env: NodeJS.ProcessEnv = process.env): AuthFile | null {
  const f = readJsonFile<Partial<AuthFile> | null>(paths.authFile(env), null);
  if (!f || typeof f.token !== "string" || !f.token) return null;
  return { token: f.token, secrets: f.secrets ?? {} };
}

export function writeAuthFile(auth: AuthFile, env: NodeJS.ProcessEnv = process.env): void {
  writePrivateJson(paths.authFile(env), auth);
}

/**
 * Returns the bridge token: $SECRETS_AI_TOKEN if set, else the 0600 auth file (created on first run).
 */
export function ensureToken(env: NodeJS.ProcessEnv = process.env): { token: string; created: boolean } {
  if (env.SECRETS_AI_TOKEN) return { token: env.SECRETS_AI_TOKEN, created: false };
  const existing = readAuthFile(env);
  if (existing) return { token: existing.token, created: false };
  const token = generateToken();
  writeAuthFile({ token, secrets: {} }, env);
  return { token, created: true };
}

/** Store (or clear with "") a secret in the 0600 auth file. */
export function saveSecret(key: keyof Secrets, value: string, env: NodeJS.ProcessEnv = process.env): void {
  const { token } = ensureToken({ ...env, SECRETS_AI_TOKEN: "" });
  const cur = readAuthFile(env) ?? { token, secrets: {} };
  const secrets = { ...cur.secrets };
  if (value) secrets[key] = value;
  else delete secrets[key];
  writeAuthFile({ token: cur.token, secrets }, env);
}

/** Merge secrets: env wins over file. Per-request header overrides are applied by the caller. */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const file = readAuthFile(env)?.secrets ?? {};
  const pick = (...vals: Array<string | undefined>) => vals.find((v) => typeof v === "string" && v.length > 0);
  return {
    openrouterApiKey: pick(env.OPENROUTER_API_KEY, file.openrouterApiKey),
    geminiApiKey: pick(env.GEMINI_API_KEY, env.GOOGLE_GENERATIVE_AI_API_KEY, file.geminiApiKey),
    githubToken: pick(env.GITHUB_TOKEN, env.GITHUB_PERSONAL_ACCESS_TOKEN, file.githubToken),
    secretsToken: pick(env.SECRETS_TOKEN, file.secretsToken),
  };
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function verifyBearer(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
