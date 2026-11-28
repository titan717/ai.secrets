import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredAuthConfig {
  bridgeToken: string;
  openrouterKey?: string;
  geminiKey?: string;
  githubToken?: string;
  secretsToken?: string;
  secretsApiUrl?: string;
}

export function getConfigDir(): string {
  return process.env.SECRETS_AI_CONFIG_DIR || join(homedir(), ".config", "secrets-ai");
}

export function getAuthFilePath(): string {
  return join(getConfigDir(), "config.json");
}

export function getSessionsFilePath(): string {
  return join(getConfigDir(), "sessions.json");
}

export function readStoredSessions<T = unknown>(): T[] {
  const filePath = getSessionsFilePath();
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function writeStoredSessions(sessions: unknown[]): void {
  ensureConfigDir();
  const filePath = getSessionsFilePath();
  writeFileSync(filePath, JSON.stringify(sessions, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort
  }
}

export function ensureConfigDir(): string {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function readStoredConfig(): StoredAuthConfig | null {
  const filePath = getAuthFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredAuthConfig>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.bridgeToken !== "string" || !parsed.bridgeToken) return null;
    return parsed as StoredAuthConfig;
  } catch {
    return null;
  }
}

export function writeStoredConfig(config: StoredAuthConfig): string {
  ensureConfigDir();
  const filePath = getAuthFilePath();
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms that ignore POSIX chmod (e.g. Windows)
  }
  return filePath;
}

/**
 * Loads or generates the local bridge Bearer token in ~/.config/secrets-ai/config.json (mode 0600).
 */
export function ensureBridgeToken(): string {
  const envToken = process.env.SECRETS_AI_TOKEN?.trim();
  if (envToken) return envToken;

  const existing = readStoredConfig();
  if (existing?.bridgeToken) return existing.bridgeToken;

  const bridgeToken = `sai_${randomBytes(24).toString("hex")}`;
  writeStoredConfig({
    ...(existing ?? {}),
    bridgeToken,
  });
  return bridgeToken;
}

export function verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Redacts API keys and Bearer tokens from strings before logging.
 */
export function redactSecrets(input: string, extraSecrets: (string | undefined)[] = []): string {
  let out = input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk-or-v1-[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|sai_[0-9a-f]{16,})\b/g, "[redacted]");
  for (const s of extraSecrets) {
    if (s && s.length >= 6) {
      out = out.split(s).join("[redacted]");
    }
  }
  return out;
}
