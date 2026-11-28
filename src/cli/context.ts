/** Shared command context: parsed args, I/O, client construction and exit codes. */
import { readAuthFile } from "../core/auth.js";
import type { Parsed } from "./args.js";
import { BridgeClient } from "./client.js";
import { useColor, type Io } from "./io.js";
import { style, type Style } from "./render.js";

export const EXIT = { ok: 0, error: 1, usage: 2, unreachable: 3, interrupted: 130 } as const;

export interface Ctx {
  io: Io;
  args: Parsed;
  color: boolean;
  s: Style;
  /** Token from --token, $SECRETS_AI_TOKEN or the auth file (undefined if none). */
  token(): string | undefined;
  client(override?: { url: string; token: string }): BridgeClient;
  /** Inject fetch for tests. */
  fetch?: typeof fetch;
}

export function makeCtx(io: Io, args: Parsed, fetchImpl?: typeof fetch): Ctx {
  const color = useColor(io.stdout, io.env, args.global.noColor);
  const ctx: Ctx = {
    io,
    args,
    color,
    s: style(color),
    fetch: fetchImpl,
    token: () => args.global.token ?? readAuthFile(io.env)?.token,
    client: (o) => new BridgeClient({ url: o?.url ?? args.global.url, token: o?.token ?? ctx.token(), fetch: fetchImpl }),
  };
  return ctx;
}

export function flagStr(ctx: Ctx, name: keyof Parsed["flags"]): string | undefined {
  const v = ctx.args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(ctx: Ctx, name: keyof Parsed["flags"]): boolean {
  return ctx.args.flags[name] === true;
}
