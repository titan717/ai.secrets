import { createHash } from "node:crypto";
import type { Effort, Secrets, Settings } from "../core/types.js";
import { resolveEffort } from "./effort.js";

const fp = (label: string, value: string) => createHash("sha256").update(`secrets-ai:${label}:`).update(value).digest("hex").slice(0, 16);

/**
 * Non-reversible 16-hex fingerprint of the Secrets service token (undefined when absent).
 * Service tokens (POST /v1/auth/service-token) expire after 600 s, and secrets-mcp reads its token
 * from env fixed at opencode start, so the supervisor compares fingerprints and restarts the
 * workspace's opencode when a new x-secrets-token arrives. Safe to log; never log the token.
 */
export function secretsTokenFingerprint(secrets: Pick<Secrets, "secretsToken"> | undefined): string | undefined {
  return secrets?.secretsToken ? fp("secrets", secrets.secretsToken) : undefined;
}

/** Same for the GitHub PAT used by the github MCP entry. */
export function githubTokenFingerprint(secrets: Pick<Secrets, "githubToken"> | undefined): string | undefined {
  return secrets?.githubToken ? fp("github", secrets.githubToken) : undefined;
}

/** Combined MCP credential fingerprint: changes iff a value that needs an opencode restart changed. */
export function mcpCredentialFingerprint(secrets: Secrets | undefined): string {
  return fp("mcp", `${githubTokenFingerprint(secrets) ?? "-"}|${secretsTokenFingerprint(secrets) ?? "-"}`);
}

/**
 * Max agent steps for the settings' effort (low 3, medium 8, high 20, custom clamped 1..200).
 * Equals `agent.build.steps` / `agent.plan.steps` in the generated opencode.json, so step events
 * can carry `maxSteps`. Accepts Settings, a bare Effort, or a per-request override.
 */
export function stepsFor(settings: Pick<Settings, "effort"> | Effort | undefined, override?: Effort): number {
  const effort = override ?? (settings && "effort" in settings ? settings.effort : (settings as Effort | undefined));
  return resolveEffort(effort ?? { level: "medium" }).steps;
}
