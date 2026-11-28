/** Renders AiEvents for humans. ANSI colors only when enabled (TTY and no NO_COLOR). */
import type { AiEvent } from "../core/events.js";
import { redact } from "../core/redact.js";
import type { Out } from "./io.js";

export interface Style {
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
}

const wrap = (on: boolean, a: number, b: number) => (s: string) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : s);

export function style(color: boolean): Style {
  return {
    dim: wrap(color, 2, 22),
    bold: wrap(color, 1, 22),
    red: wrap(color, 31, 39),
    yellow: wrap(color, 33, 39),
    green: wrap(color, 32, 39),
    cyan: wrap(color, 36, 39),
  };
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export const emptyUsage = (): TurnUsage => ({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 0 });

export function formatUsage(u: Partial<TurnUsage>): string {
  const n = (x: number | undefined) => (x ?? 0).toLocaleString("en-US");
  let s = `tokens ${n(u.inputTokens)} in / ${n(u.outputTokens)} out`;
  if (u.reasoningTokens) s += ` (${n(u.reasoningTokens)} reasoning)`;
  if (u.cacheReadTokens) s += `, ${n(u.cacheReadTokens)} cached`;
  s += ` | cost $${(u.costUsd ?? 0).toFixed(u.costUsd && u.costUsd < 0.01 ? 4 : 2)}`;
  return s;
}

/** One-line, redacted summary of a tool input/output. */
export function summarize(v: unknown, max = 80): string {
  if (v === undefined || v === null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const key = ["command", "filePath", "path", "url", "pattern", "query", "description"].find((k) => typeof o[k] === "string" && o[k]);
    s = key ? String(o[key]) : JSON.stringify(v);
    if (s === "{}") s = "";
  } else s = String(v);
  s = redact(s).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export interface RendererOptions {
  color: boolean;
  showReasoning: boolean;
}

/** Stateful renderer for one output stream; keeps track of line position between deltas. */
export class Renderer {
  readonly s: Style;
  private atLineStart = true;
  private mode: "text" | "reasoning" | null = null;
  private tools = new Map<string, string>();
  usage: TurnUsage = emptyUsage();

  constructor(
    private readonly out: Out,
    private readonly opts: RendererOptions,
  ) {
    this.s = style(opts.color);
  }

  private write(s: string): void {
    if (!s) return;
    this.out.write(s);
    this.atLineStart = s.endsWith("\n");
  }

  /** Ensure the cursor is at the start of a line. */
  newline(): void {
    if (!this.atLineStart) this.write("\n");
    this.mode = null;
  }

  /** Print a full meta line (tool, permission, ...). */
  line(s: string): void {
    this.newline();
    this.write(s + "\n");
  }

  startTurn(): void {
    this.usage = emptyUsage();
    this.tools.clear();
    this.mode = null;
  }

  event(ev: AiEvent): void {
    const s = this.s;
    switch (ev.type) {
      case "text.delta":
        if (this.mode === "reasoning") this.newline();
        this.mode = "text";
        this.write(ev.text);
        break;
      case "reasoning.delta":
        if (!this.opts.showReasoning) break;
        if (this.mode !== "reasoning") {
          this.newline();
          this.write(s.dim("thinking: "));
        }
        this.mode = "reasoning";
        this.write(s.dim(ev.text));
        break;
      case "tool.start": {
        this.tools.set(ev.callId, ev.name);
        const sum = summarize(ev.input);
        this.line(s.cyan(`> ${ev.name}`) + (sum ? ` ${s.dim(sum)}` : ""));
        break;
      }
      case "tool.end": {
        const name = ev.name ?? this.tools.get(ev.callId) ?? "tool";
        if (ev.error) this.line(s.red(`x ${name} failed: ${summarize(ev.error, 120)}`));
        else {
          const sum = summarize(ev.output, 60);
          this.line(s.green(`= ${name} done`) + (sum ? ` ${s.dim(sum)}` : ""));
        }
        break;
      }
      case "permission.request":
        this.line(s.yellow(`? permission: ${ev.action}`) + (ev.detail.patterns.length ? ` ${summarize(ev.detail.patterns.join(", "), 120)}` : ""));
        break;
      case "permission.resolved":
        this.line(s.dim(`  permission ${ev.reply === "reject" ? "denied" : ev.reply === "always" ? "allowed for session" : "allowed once"}`));
        break;
      case "question": {
        const qs = ev.questions?.length ? ev.questions : [{ question: ev.text, options: ev.options ?? [] }];
        for (const q of qs) {
          this.line(s.yellow(`? ${redact(q.question)}`));
          q.options.forEach((o, i) => this.line(`  ${i + 1}) ${redact(o)}`));
        }
        break;
      }
      case "error":
        this.line(s.red(`error: ${redact(ev.message)}`) + (ev.code ? s.dim(` (${ev.code})`) : ""));
        break;
      case "status":
        if (ev.status === "retry") this.line(s.yellow(`retrying${ev.attempt ? ` (attempt ${ev.attempt})` : ""}${ev.message ? `: ${redact(ev.message)}` : ""}`));
        break;
      case "step":
        if (ev.step > 1) this.line(s.dim(`[step ${ev.step}${ev.maxSteps ? `/${ev.maxSteps}` : ""}]`));
        break;
      case "usage":
        this.usage.inputTokens += ev.inputTokens;
        this.usage.outputTokens += ev.outputTokens;
        this.usage.reasoningTokens += ev.reasoningTokens;
        this.usage.cacheReadTokens += ev.cacheReadTokens;
        this.usage.costUsd += ev.costUsd;
        break;
      case "session.idle":
        this.newline();
        break;
      default:
        break; // unknown additive events are ignored
    }
  }

  /** Usage/cost line printed after each turn. */
  endTurn(): void {
    this.newline();
    this.write(this.s.dim(formatUsage(this.usage)) + "\n");
  }
}
