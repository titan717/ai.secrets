import { resolve } from "node:path";
import type { BridgeHandle, StartBridgeOptions } from "../../core/api.js";
import { ensureToken } from "../../core/auth.js";
import { UsageError } from "../args.js";
import { EXIT, flagStr, type Ctx } from "../context.js";
import { writeln } from "../io.js";

type StartBridge = (o?: StartBridgeOptions) => Promise<BridgeHandle>;

/**
 * Resolve startBridge at runtime so the CLI builds before src/bridge lands. The specifier is a
 * variable on purpose: bundlers leave it alone and tsc does not require the module to exist.
 */
export async function loadStartBridge(): Promise<StartBridge> {
  const candidates = ["../bridge/server.js", "../../bridge/server.js", "./bridge/server.js"];
  const errors: string[] = [];
  for (const spec of candidates) {
    try {
      const url = new URL(spec, import.meta.url).href;
      const mod = (await import(url)) as { startBridge?: StartBridge };
      if (typeof mod.startBridge === "function") return mod.startBridge;
      errors.push(`${spec}: no startBridge export`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ERR_MODULE_NOT_FOUND") errors.push(`${spec}: ${(err as Error).message}`);
    }
  }
  throw new BridgeMissingError(errors);
}

export class BridgeMissingError extends Error {
  constructor(details: string[]) {
    super(
      "the bridge server module (bridge/server.js) is not available in this build. " +
        "Rebuild with `pnpm build` from a checkout that includes src/bridge/server.ts." +
        (details.length ? `\n  ${details.join("\n  ")}` : ""),
    );
  }
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function parsePort(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError("--port must be an integer 0..65535");
  return n;
}

export async function serve(ctx: Ctx, deps: { startBridge?: StartBridge; waitForSignal?: () => Promise<string> } = {}): Promise<number> {
  const { io, s } = ctx;
  const host = flagStr(ctx, "host") ?? io.env.HOST ?? "127.0.0.1";
  const port = parsePort(flagStr(ctx, "port")) ?? parsePort(io.env.PORT) ?? 8790;
  const ws = flagStr(ctx, "workspace");
  const opencodeBin = flagStr(ctx, "opencode-bin");
  if (!isLoopback(host)) {
    const bar = "!".repeat(72);
    writeln(io.stderr, s.red(bar));
    writeln(io.stderr, s.red(`WARNING: binding to ${host}, which is NOT loopback. Anyone who can reach this`));
    writeln(io.stderr, s.red("port can try your bearer token. Prefer 127.0.0.1 plus an SSH tunnel or a TLS"));
    writeln(io.stderr, s.red("reverse proxy (see docs/RUN-MODES.md). Never expose it without TLS."));
    writeln(io.stderr, s.red(bar));
  }
  // Make sure a token exists so clients on this machine can authenticate.
  if (!io.env.SECRETS_AI_TOKEN) ensureToken(io.env);
  let start: StartBridge;
  try {
    start = deps.startBridge ?? (await loadStartBridge());
  } catch (err) {
    writeln(io.stderr, s.red(`error: ${(err as Error).message}`));
    return EXIT.error;
  }
  const handle = await start({
    host,
    port,
    workspace: ws ? resolve(io.cwd, ws) : undefined,
    opencodeBin,
    env: io.env,
  });
  writeln(io.stdout, `secrets-ai bridge listening on ${handle.url}`);
  writeln(io.stdout, s.dim("token: stored in the auth file (show it with `secrets-ai auth token`). Ctrl+C to stop."));
  const sig = await (deps.waitForSignal ?? waitForSignal)();
  writeln(io.stdout, `\nreceived ${sig}, shutting down...`);
  const timer = setTimeout(() => {
    writeln(io.stderr, "shutdown timed out after 10s; exiting");
    process.exit(EXIT.error);
  }, 10000);
  timer.unref();
  try {
    await handle.close();
  } finally {
    clearTimeout(timer);
  }
  return EXIT.ok;
}

function waitForSignal(): Promise<string> {
  return new Promise((resolve) => {
    const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    if (process.platform !== "win32") sigs.push("SIGHUP");
    const on = (sig: NodeJS.Signals) => {
      for (const x of sigs) process.removeListener(x, on);
      // A second signal during shutdown exits immediately.
      for (const x of sigs) process.once(x, () => process.exit(EXIT.interrupted));
      resolve(sig);
    };
    for (const x of sigs) process.on(x, on);
  });
}

/** Start a private in-process bridge for `--local` chat/run. */
export async function startLocalBridge(ctx: Ctx): Promise<BridgeHandle> {
  const start = await loadStartBridge();
  const ws = flagStr(ctx, "workspace");
  return start({
    host: "127.0.0.1",
    port: 0,
    quiet: true,
    workspace: ws ? resolve(ctx.io.cwd, ws) : ctx.io.cwd,
    opencodeBin: flagStr(ctx, "opencode-bin"),
    env: ctx.io.env,
  });
}
