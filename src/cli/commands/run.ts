import { resolve } from "node:path";
import type { BridgeHandle, SendMessageRequest } from "../../core/api.js";
import type { PermissionDecision } from "../../core/events.js";
import { parseEffort, UsageError } from "../args.js";
import type { BridgeClient } from "../client.js";
import { EXIT, flagBool, flagStr, type Ctx } from "../context.js";
import { LineReader, readAllStdin, writeln } from "../io.js";
import { askPermission, askQuestion } from "../prompts.js";
import { Renderer } from "../render.js";
import { startTurn } from "../turn.js";
import { startLocalBridge } from "./serve.js";

export function turnRequest(ctx: Ctx, text: string): SendMessageRequest {
  const req: SendMessageRequest = { text };
  const model = flagStr(ctx, "model");
  const effort = flagStr(ctx, "effort");
  if (model) req.model = model;
  if (effort) req.effort = parseEffort(effort);
  return req;
}

/** Returns a client (and a local bridge handle for --local). */
export async function connect(ctx: Ctx): Promise<{ client: BridgeClient; local?: BridgeHandle }> {
  if (!flagBool(ctx, "local")) return { client: ctx.client() };
  const local = await startLocalBridge(ctx);
  return { client: ctx.client({ url: local.url, token: local.token }), local };
}

export async function ensureSession(ctx: Ctx, client: BridgeClient, title: string): Promise<string> {
  const id = flagStr(ctx, "session");
  if (id) return (await client.getSession(id)).id;
  const ws = flagStr(ctx, "workspace");
  return (await client.createSession({ title: title.slice(0, 60), ...(ws ? { workspace: resolve(ctx.io.cwd, ws) } : {}) })).id;
}

export async function run(ctx: Ctx, opts: { backoff?: (n: number) => number } = {}): Promise<number> {
  const { io } = ctx;
  const json = flagBool(ctx, "json");
  const yes = flagBool(ctx, "yes");
  const denyAll = flagBool(ctx, "deny-all");
  if (yes && denyAll) throw new UsageError("--yes and --deny-all are mutually exclusive");
  let text = ctx.args.positionals.join(" ").trim();
  if (text === "-") text = await readAllStdin(io.stdin);
  if (!text) throw new UsageError('usage: secrets-ai run "<prompt>" (use "-" to read the prompt from stdin)');
  const req = turnRequest(ctx, text);
  const interactive = Boolean(io.stdin.isTTY) && !yes && !denyAll && ctx.args.positionals[0] !== "-";
  const policy: PermissionDecision | "ask" = yes ? "allow" : denyAll ? "deny" : interactive ? "ask" : "deny";

  const { client, local } = await connect(ctx);
  let lines: LineReader | undefined;
  try {
    const sessionId = await ensureSession(ctx, client, text);
    // Text goes to stdout; everything else to stderr so `run` output can be piped.
    const textR = new Renderer(io.stdout, { color: ctx.color, showReasoning: false });
    const metaR = new Renderer(io.stderr, { color: ctx.color && Boolean(io.stderr.isTTY), showReasoning: flagBool(ctx, "show-reasoning") });
    const getLines = () => (lines ??= new LineReader(io.stdin, io.stderr));
    let interrupts = 0;
    const turn = startTurn(
      client,
      sessionId,
      req,
      {
        onEvent: (ev) => {
          if (json) return void io.stdout.write(JSON.stringify(ev) + "\n");
          if (ev.type === "text.delta") textR.event(ev);
          else if (ev.type === "session.idle") textR.newline();
          else metaR.event(ev);
        },
        decidePermission: async (ev) => {
          if (policy !== "ask") {
            if (!json) metaR.line(metaR.s.dim(`  ${policy === "allow" ? "auto-allowed (--yes)" : denyAll ? "denied (--deny-all)" : "denied (non-interactive; pass --yes to allow)"}`));
            return policy;
          }
          return askPermission(getLines(), ev);
        },
        answerQuestion: async (ev) => (interactive ? askQuestion(getLines(), ev) : { reject: true }),
        onReconnect: (n) => {
          if (!json) metaR.line(metaR.s.yellow(`connection dropped, reconnecting (attempt ${n})...`));
        },
      },
      opts,
    );
    const onSig = () => {
      interrupts++;
      if (interrupts > 1) process.exit(EXIT.interrupted);
      writeln(io.stderr, "\naborting (Ctrl+C again to quit)...");
      void turn.abort();
    };
    process.on("SIGINT", onSig);
    let result;
    try {
      result = await turn.done;
    } finally {
      process.removeListener("SIGINT", onSig);
    }
    if (!json) {
      metaR.endTurn();
      writeln(io.stderr, metaR.s.dim(`session ${sessionId}`));
    }
    if (result.aborted) return EXIT.interrupted;
    return result.ok ? EXIT.ok : EXIT.error;
  } finally {
    lines?.close();
    await local?.close();
  }
}
