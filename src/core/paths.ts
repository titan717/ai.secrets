import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config dir: $SECRETS_AI_HOME, else $XDG_CONFIG_HOME/secrets-ai, else ~/.config/secrets-ai.
 * Windows uses %APPDATA%\secrets-ai. Termux's $HOME works with the default.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SECRETS_AI_HOME) return env.SECRETS_AI_HOME;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "secrets-ai");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "secrets-ai");
  return join(homedir(), ".config", "secrets-ai");
}

export const paths = {
  /** 0600: { token, secrets } */
  authFile: (env?: NodeJS.ProcessEnv) => join(configDir(env), "auth.json"),
  /** 0600: Settings JSON (no secrets, but kept private anyway). */
  settingsFile: (env?: NodeJS.ProcessEnv) => join(configDir(env), "settings.json"),
  /** 0600: persisted bridge sessions index. */
  sessionsFile: (env?: NodeJS.ProcessEnv) => join(configDir(env), "sessions.json"),
  /** Per-workspace OpenCode state (isolated XDG dirs so we never touch the user's own opencode auth). */
  workspaceStateDir: (workspaceId: string, env?: NodeJS.ProcessEnv) => join(configDir(env), "workspaces", workspaceId),
};
