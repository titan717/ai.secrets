import { redact } from "../core/redact.js";

/** Field names that may carry credentials in OpenCode payloads (e.g. `provider.key`, `options.apiKey`). */
const SECRET_FIELD = /^(key|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|authorization|x-api-key|cookie)$/i;

/**
 * Deep copy of an OpenCode payload (`GET /config/providers` carries RAW keys in `provider.key`;
 * `GET /config` returns MCP headers with {env:} already substituted). Works for both:
 * credential-like fields are removed and remaining strings redacted.
 */
export function sanitizeOpenCodeProviders<T = unknown>(payload: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32) return undefined;
    if (typeof v === "string") return redact(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_FIELD.test(k)) continue;
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(payload, 0) as T;
}
