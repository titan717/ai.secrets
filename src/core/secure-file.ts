import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Read JSON or return fallback when missing/corrupt. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomically write JSON with mode 0600 (dir 0700). On Windows chmod is a no-op;
 * the file lives in the per-user profile which is already ACL-protected.
 */
export function writePrivateJson(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}
