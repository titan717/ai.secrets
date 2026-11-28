import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** Redacting stderr logger. Never prints secrets: every line goes through redact(). */
export function createLogger(scope: string, level: LogLevel = (process.env.SECRETS_AI_LOG as LogLevel) || "info"): Logger {
  const min = ORDER[level] ?? 20;
  const write = (lvl: LogLevel, msg: string, extra?: unknown) => {
    if (ORDER[lvl] < min) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase()} [${scope}] ${msg}`;
    if (extra !== undefined) {
      const e = extra instanceof Error ? extra.message : typeof extra === "string" ? extra : safeJson(extra);
      line += ` ${e}`;
    }
    process.stderr.write(redact(line) + "\n");
  };
  return {
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
