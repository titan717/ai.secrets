/**
 * `secrets-ai`: terminal client + server launcher for the ai.secrets bridge.
 * Zero runtime dependencies beyond Node 20 built-ins.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redact } from "../core/redact.js";
import { HELP, parseCli, UsageError } from "./args.js";
import { ApiError, BridgeUnreachableError } from "./client.js";
import { auth, init } from "./commands/auth.js";
import { chat } from "./commands/chat.js";
import { doctor } from "./commands/doctor.js";
import { models } from "./commands/models.js";
import { run } from "./commands/run.js";
import { BridgeMissingError, serve } from "./commands/serve.js";
import { settings } from "./commands/settings.js";
import { EXIT, makeCtx } from "./context.js";
import { processIo, writeln, type Io } from "./io.js";
import { StreamDroppedError } from "./sse.js";
import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version: string }).version;

export interface MainDeps {
  fetch?: typeof fetch;
}

export async function main(argv: string[], io: Io = processIo(), deps: MainDeps = {}): Promise<number> {
  try {
    const args = parseCli(argv, io.env);
    if (args.global.version || args.command === "version") {
      writeln(io.stdout, VERSION);
      return EXIT.ok;
    }
    if (args.global.help || args.command === "help") {
      io.stdout.write(HELP);
      return EXIT.ok;
    }
    const ctx = makeCtx(io, args, deps.fetch);
    switch (args.command) {
      case "init":
        return await init(ctx);
      case "auth":
        return await auth(ctx);
      case "serve":
        return await serve(ctx);
      case "chat":
        return await chat(ctx);
      case "run":
        return await run(ctx);
      case "models":
        return await models(ctx);
      case "settings":
        return await settings(ctx);
      case "status":
      case "doctor":
        return await doctor(ctx);
      default:
        throw new UsageError(`unknown command '${args.command}'`);
    }
  } catch (err) {
    const msg = redact((err as Error)?.message ?? String(err));
    if (err instanceof UsageError) {
      writeln(io.stderr, `secrets-ai: ${msg}`);
      return EXIT.usage;
    }
    if (err instanceof BridgeUnreachableError) {
      writeln(io.stderr, `secrets-ai: ${msg}`);
      return EXIT.unreachable;
    }
    if (err instanceof ApiError || err instanceof StreamDroppedError || err instanceof BridgeMissingError) {
      writeln(io.stderr, `secrets-ai: ${msg}`);
      return EXIT.error;
    }
    writeln(io.stderr, `secrets-ai: unexpected error: ${msg}`);
    if (io.env.SECRETS_AI_DEBUG) writeln(io.stderr, redact(String((err as Error)?.stack ?? "")));
    return EXIT.error;
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // REPL/readline handles may linger; exit explicitly once output is flushed.
      process.stdout.write("", () => process.exit(code));
    },
    (err: unknown) => {
      process.stderr.write(`secrets-ai: ${redact(String(err))}\n`);
      process.exit(EXIT.error);
    },
  );
}
