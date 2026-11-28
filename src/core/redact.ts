/**
 * Secret redaction for logs and error messages. Every log line and every error that leaves
 * the bridge goes through `redact()`.
 */

const PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sai_[A-Za-z0-9_-]{20,}/g, // bridge token
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /("?(?:api[_-]?key|apikey|token|password|secret|authorization|x-provider-key|x-github-token|x-secrets-token)"?\s*[:=]\s*)"?[^\s",}]{4,}"?/gi,
];

const extra = new Set<string>();

/** Register a runtime secret (e.g. a key from a header) so it is scrubbed even if it matches no pattern. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) extra.add(value);
}

export function redact(input: string): string {
  let out = input;
  for (const s of extra) out = out.split(s).join("[REDACTED]");
  for (const re of PATTERNS) {
    out = out.replace(re, (m, prefix?: string) =>
      typeof prefix === "string" && m.startsWith(prefix) && prefix.length < m.length ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

/** Deep-redact any value into a JSON-safe copy. */
export function redactValue<T>(v: T): T {
  try {
    return JSON.parse(redact(JSON.stringify(v))) as T;
  } catch {
    return v;
  }
}
