import { statSync } from "node:fs";
import { ensureToken, generateToken, loadSecrets, readAuthFile, saveSecret, writeAuthFile } from "../../core/auth.js";
import { configDir, paths } from "../../core/paths.js";
import { loadSettings, mergeSettings, saveSettings } from "../../core/settings.js";
import type { Secrets } from "../../core/types.js";
import { SECRET_ARGV_MESSAGE, UsageError } from "../args.js";
import { BridgeUnreachableError } from "../client.js";
import { EXIT, flagBool, flagStr, type Ctx } from "../context.js";
import { readAllStdin, readSecret, writeln } from "../io.js";

export const SECRET_NAMES = { openrouter: "openrouterApiKey", google: "geminiApiKey", github: "githubToken", secrets: "secretsToken" } as const;
export type SecretName = keyof typeof SECRET_NAMES;
const LABEL: Record<SecretName, string> = {
  openrouter: "OpenRouter API key",
  google: "Google Gemini API key",
  github: "GitHub token",
  secrets: "Secrets API session token",
};

function isSecretName(s: string | undefined): s is SecretName {
  return !!s && s in SECRET_NAMES;
}

/** Read a secret from stdin (--key-stdin / piped) or a hidden prompt. Never from argv. */
async function obtainSecret(ctx: Ctx, name: SecretName): Promise<string> {
  const { io } = ctx;
  if (flagBool(ctx, "key-stdin") || !io.stdin.isTTY) return readAllStdin(io.stdin);
  return readSecret(io, `${LABEL[name]} (input hidden): `);
}

/** Store a secret on the bridge when reachable (applies live), else in the local 0600 auth file. */
async function storeSecret(ctx: Ctx, name: SecretName, value: string): Promise<string> {
  const key = SECRET_NAMES[name];
  try {
    await ctx.client().putSecrets({ [key]: value } as Partial<Secrets>);
    return `bridge at ${ctx.args.global.url}`;
  } catch (err) {
    if (!(err instanceof BridgeUnreachableError)) throw err;
    saveSecret(key, value, ctx.io.env);
    return `${paths.authFile(ctx.io.env)} (bridge not running; it will be picked up on next start)`;
  }
}

export async function auth(ctx: Ctx): Promise<number> {
  const { io, s } = ctx;
  const [sub, ...rest] = ctx.args.positionals;
  switch (sub) {
    case "token": {
      if (rest.length) throw new UsageError("usage: secrets-ai auth token [--show]");
      if (!io.stdout.isTTY && !flagBool(ctx, "show")) {
        writeln(io.stderr, "refusing to print the token to a non-terminal; add --show if you really want that (e.g. to pipe it into a secret store).");
        return EXIT.usage;
      }
      const tok = ctx.args.global.token ?? io.env.SECRETS_AI_TOKEN ?? ensureToken(io.env).token;
      writeln(io.stdout, tok);
      return EXIT.ok;
    }
    case "set": {
      const name = rest[0];
      if (rest.length > 1) throw new UsageError(SECRET_ARGV_MESSAGE);
      if (!isSecretName(name)) throw new UsageError("usage: secrets-ai auth set <openrouter|google|github|secrets> [--key-stdin]");
      const value = await obtainSecret(ctx, name);
      if (!value) {
        writeln(io.stderr, "no value given; nothing changed (to clear a secret use `secrets-ai auth clear <name>`).");
        return EXIT.usage;
      }
      const where = await storeSecret(ctx, name, value);
      writeln(io.stdout, s.green(`${LABEL[name]} saved`) + ` to ${where}.`);
      return EXIT.ok;
    }
    case "clear": {
      const name = rest[0];
      if (!isSecretName(name) || rest.length > 1) throw new UsageError("usage: secrets-ai auth clear <openrouter|google|github|secrets>");
      const where = await storeSecret(ctx, name, "");
      writeln(io.stdout, `${LABEL[name]} cleared on ${where}.`);
      return EXIT.ok;
    }
    case "status":
    case undefined: {
      let configured: Record<SecretName, boolean>;
      let source: string;
      try {
        configured = (await ctx.client().getSettings()).secrets;
        source = `bridge at ${ctx.args.global.url}`;
      } catch (err) {
        if (!(err instanceof BridgeUnreachableError)) throw err;
        const sec = loadSecrets(io.env);
        configured = { openrouter: !!sec.openrouterApiKey, google: !!sec.geminiApiKey, github: !!sec.githubToken, secrets: !!sec.secretsToken };
        source = "local config + environment (bridge not running)";
      }
      writeln(io.stdout, `secrets (${source}):`);
      for (const n of Object.keys(SECRET_NAMES) as SecretName[]) {
        writeln(io.stdout, `  ${n.padEnd(11)} ${configured[n] ? s.green("configured") : s.dim("not set")}`);
      }
      const hasToken = !!(ctx.args.global.token ?? io.env.SECRETS_AI_TOKEN ?? readAuthFile(io.env)?.token);
      writeln(io.stdout, `  ${"bridge token".padEnd(11)} ${hasToken ? s.green("present") : s.yellow("missing (run `secrets-ai init`)")}`);
      return EXIT.ok;
    }
    case "rotate": {
      const cur = readAuthFile(io.env);
      writeAuthFile({ token: generateToken(), secrets: cur?.secrets ?? {} }, io.env);
      writeln(io.stdout, s.green("new bridge token written") + ` to ${paths.authFile(io.env)}.`);
      writeln(io.stdout, "Restart the bridge (`secrets-ai serve` / systemctl restart) and update any client that stored the old token.");
      if (io.env.SECRETS_AI_TOKEN) writeln(io.stdout, s.yellow("note: SECRETS_AI_TOKEN is set in your environment and overrides the file."));
      return EXIT.ok;
    }
    default:
      throw new UsageError("usage: secrets-ai auth <token|set|clear|status|rotate>");
  }
}

export async function init(ctx: Ctx): Promise<number> {
  const { io, s } = ctx;
  if (ctx.args.positionals.length) throw new UsageError(SECRET_ARGV_MESSAGE);
  const env = { ...io.env, SECRETS_AI_TOKEN: "" };
  const { created } = ensureToken(env);
  const dir = configDir(io.env);
  writeln(io.stdout, `${created ? s.green("created") : "using existing"} config in ${dir} (token file is private, mode 0600)`);

  const provider = flagStr(ctx, "provider");
  const model = flagStr(ctx, "model");
  if (provider && provider !== "openrouter" && provider !== "google") throw new UsageError("--provider must be openrouter or google");
  if (provider || model) {
    const cur = loadSettings(io.env);
    const next = mergeSettings(cur, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    if (provider && !model && provider !== cur.provider) next.model = provider === "google" ? "gemini-2.5-flash" : "openrouter/free";
    saveSettings(next, io.env);
    writeln(io.stdout, `provider ${next.provider}, model ${next.model}`);
  }

  let stored = false;
  const keyName: SecretName = (provider ?? loadSettings(io.env).provider) === "google" ? "google" : "openrouter";
  if (flagBool(ctx, "key-stdin")) {
    const value = await readAllStdin(io.stdin);
    if (!value) throw new UsageError("--key-stdin given but stdin was empty");
    saveSecret(SECRET_NAMES[keyName], value, io.env);
    stored = true;
  } else if (io.stdin.isTTY && provider) {
    const value = await readSecret(io, `${LABEL[keyName]} (input hidden, empty to skip): `);
    if (value) {
      saveSecret(SECRET_NAMES[keyName], value, io.env);
      stored = true;
    }
  }
  if (stored) writeln(io.stdout, s.green(`${LABEL[keyName]} saved`) + ` to ${paths.authFile(io.env)}`);
  if (process.platform !== "win32") {
    try {
      const mode = statSync(paths.authFile(io.env)).mode & 0o777;
      if (mode !== 0o600) writeln(io.stderr, s.yellow(`warning: ${paths.authFile(io.env)} has mode ${mode.toString(8)}, expected 600`));
    } catch {
      /* ignore */
    }
  }
  writeln(io.stdout, "");
  writeln(io.stdout, "Next steps:");
  if (!stored) writeln(io.stdout, `  1. store a provider key:   secrets-ai auth set ${keyName}`);
  writeln(io.stdout, `  ${stored ? 1 : 2}. start the bridge:        secrets-ai serve`);
  writeln(io.stdout, `  ${stored ? 2 : 3}. chat in another shell:   secrets-ai chat     (or: secrets-ai run "hello")`);
  writeln(io.stdout, `  check everything with:     secrets-ai doctor`);
  return EXIT.ok;
}
