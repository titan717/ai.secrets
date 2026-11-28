import { resolve } from "node:path";
import type { SendMessageRequest } from "../../core/api.js";
import type { Effort } from "../../core/types.js";
import { formatEffort, parseEffort, UsageError } from "../args.js";
import type { BridgeClient } from "../client.js";
import { EXIT, flagBool, flagStr, type Ctx } from "../context.js";
import { LineReader, writeln } from "../io.js";
import { askPermission, askQuestion } from "../prompts.js";
import { formatUsage, Renderer } from "../render.js";
import { startTurn, type TurnControl } from "../turn.js";
import { connect } from "./run.js";

export const CHAT_HELP = `commands:
  /model [id]        show or set the model for this chat
  /effort [e]        show or set effort: low|medium|high|custom:<steps>[:<variant>]
  /new               start a new session
  /sessions [id]     list sessions, or switch to one
  /abort             abort the running turn
  /usage             token usage and cost of this session
  /help              this help
  /exit              quit (Ctrl+D works too)
Ctrl+C during a turn aborts it; a second Ctrl+C exits.`;

/** REPL state machine, separated from the terminal so tests can drive it. */
export class Chat {
  sessionId: string | undefined;
  model: string | undefined;
  effort: Effort | undefined;
  private turn: TurnControl | undefined;
  private interrupts = 0;
  exitRequested = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly client: BridgeClient,
    private readonly lines: LineReader,
    private readonly r: Renderer,
    private readonly turnOpts: { backoff?: (n: number) => number } = {},
  ) {
    this.sessionId = flagStr(ctx, "session");
    this.model = flagStr(ctx, "model");
    const e = flagStr(ctx, "effort");
    this.effort = e ? parseEffort(e) : undefined;
  }

  private out(s = ""): void {
    this.r.line(s);
  }

  /** Ctrl+C: abort a running turn; when idle (or on the second press) exit. */
  interrupt(): void {
    if (this.turn && this.interrupts === 0) {
      this.interrupts++;
      this.out(this.r.s.yellow("aborting... (Ctrl+C again to exit)"));
      void this.turn.abort();
      return;
    }
    this.exitRequested = true;
    this.lines.close();
  }

  private async ensureSession(title: string): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const ws = flagStr(this.ctx, "workspace");
    const s = await this.client.createSession({ title: title.slice(0, 60), ...(ws ? { workspace: resolve(this.ctx.io.cwd, ws) } : {}) });
    this.sessionId = s.id;
    this.out(this.r.s.dim(`session ${s.id} (${s.workspace})`));
    return s.id;
  }

  /** Handle one input line. Returns false when the REPL should exit. */
  async handle(line: string): Promise<boolean> {
    const t = line.trim();
    if (!t) return true;
    if (t.startsWith("/")) return this.command(t);
    await this.send(t);
    return !this.exitRequested;
  }

  async send(text: string): Promise<void> {
    const sessionId = await this.ensureSession(text);
    const req: SendMessageRequest = { text };
    if (this.model) req.model = this.model;
    if (this.effort) req.effort = this.effort;
    this.r.startTurn();
    this.interrupts = 0;
    this.turn = startTurn(
      this.client,
      sessionId,
      req,
      {
        onEvent: (ev) => this.r.event(ev),
        decidePermission: (ev) => askPermission(this.lines, ev),
        answerQuestion: (ev) => askQuestion(this.lines, ev),
        onReconnect: (n) => this.out(this.r.s.yellow(`connection dropped, reconnecting (attempt ${n})...`)),
      },
      this.turnOpts,
    );
    try {
      const res = await this.turn.done;
      if (res.aborted) this.out(this.r.s.yellow("turn aborted"));
    } catch (err) {
      this.out(this.r.s.red(`error: ${(err as Error).message}`));
    } finally {
      this.turn = undefined;
      this.r.endTurn();
    }
  }

  private async command(t: string): Promise<boolean> {
    const [cmd, ...args] = t.split(/\s+/);
    const arg = args.join(" ");
    const s = this.r.s;
    try {
      switch (cmd) {
        case "/exit":
        case "/quit":
          return false;
        case "/help":
          this.out(CHAT_HELP);
          break;
        case "/model":
          if (arg) this.model = arg;
          this.out(`model: ${this.model ?? "(bridge default)"}`);
          break;
        case "/effort":
          if (arg) this.effort = parseEffort(arg);
          this.out(`effort: ${this.effort ? formatEffort(this.effort) : "(bridge default)"}`);
          break;
        case "/new":
          this.sessionId = undefined;
          this.out("new session will start with your next message");
          break;
        case "/sessions": {
          if (arg) {
            this.sessionId = (await this.client.getSession(arg)).id;
            this.out(`switched to ${this.sessionId}`);
            break;
          }
          const list = await this.client.listSessions();
          if (!list.length) this.out("no sessions");
          for (const x of list) this.out(`${x.id === this.sessionId ? "*" : " "} ${x.id}  ${x.status.padEnd(4)}  ${x.title}`);
          break;
        }
        case "/abort":
          if (!this.sessionId) this.out("no session");
          else {
            await this.client.abort(this.sessionId);
            this.out("abort requested");
          }
          break;
        case "/usage":
          if (!this.sessionId) this.out("no session yet");
          else this.out(formatUsage((await this.client.getSession(this.sessionId)).usage));
          break;
        default:
          this.out(s.yellow(`unknown command ${cmd}; try /help`));
      }
    } catch (err) {
      this.out(s.red(err instanceof UsageError ? err.message : `error: ${(err as Error).message}`));
    }
    return true;
  }

  async loop(): Promise<void> {
    for (;;) {
      const line = await this.lines.next(this.r.s.bold("> "));
      if (line === null || this.exitRequested) return;
      if (!(await this.handle(line))) return;
    }
  }
}

export async function chat(ctx: Ctx): Promise<number> {
  const { io } = ctx;
  const { client, local } = await connect(ctx);
  const lines = new LineReader(io.stdin, io.stdout);
  const r = new Renderer(io.stdout, { color: ctx.color, showReasoning: flagBool(ctx, "show-reasoning") });
  const c = new Chat(ctx, client, lines, r);
  // Fail fast with a friendly error when the bridge is down.
  await client.health();
  if (c.sessionId) c.sessionId = (await client.getSession(c.sessionId)).id;
  writeln(io.stdout, r.s.dim(`connected to ${client.url}. /help for commands, /exit to quit.`));
  lines.onSigint(() => c.interrupt());
  const onSig = () => c.interrupt();
  process.on("SIGINT", onSig);
  try {
    await c.loop();
  } finally {
    process.removeListener("SIGINT", onSig);
    lines.close();
    await local?.close();
  }
  return EXIT.ok;
}
