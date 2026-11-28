/** Terminal I/O helpers: injectable streams (for tests), a queued line reader and hidden secret input. */
import { createInterface, type Interface } from "node:readline";

export type In = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
export type Out = NodeJS.WritableStream & { isTTY?: boolean };

export interface Io {
  stdin: In;
  stdout: Out;
  stderr: Out;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function processIo(): Io {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
}

export function useColor(out: Out, env: NodeJS.ProcessEnv, noColorFlag = false): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return Boolean(out.isTTY);
}

/**
 * Line reader that never loses lines: input arriving before `next()` is queued
 * (readline's `question()` drops lines from piped stdin otherwise).
 */
export class LineReader {
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private waiters: Array<(l: string | null) => void> = [];
  private closed = false;
  private sigintHandler: (() => void) | undefined;

  constructor(
    private readonly input: In,
    private readonly output: Out,
  ) {
    this.rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), crlfDelay: Infinity });
    this.rl.on("line", (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.queue.push(l);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
    this.rl.on("SIGINT", () => this.sigintHandler?.());
  }

  /** Called on Ctrl+C when the terminal is in readline mode. */
  onSigint(fn: () => void): void {
    this.sigintHandler = fn;
  }

  /** Print a prompt and resolve with the next line, or null on EOF. */
  next(prompt = ""): Promise<string | null> {
    if (prompt) this.output.write(prompt);
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.rl.close();
  }
}

/** Read all of stdin (for --key-stdin / piped secrets); trims a trailing newline. */
export async function readAllStdin(input: In): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input as AsyncIterable<Buffer | string>) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "").trim();
}

/**
 * Read a secret without echo. TTY: raw mode, prints `*` per char; non-TTY: first line of stdin.
 * Never logs or returns the value anywhere except to the caller.
 */
export async function readSecret(io: Pick<Io, "stdin" | "stderr">, prompt: string): Promise<string> {
  const input = io.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") return readAllStdin(input);
  io.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const setRaw = input.setRawMode!.bind(input);
    setRaw(true);
    input.resume();
    const done = (err?: Error) => {
      input.removeListener("data", onData);
      setRaw(false);
      input.pause();
      io.stderr.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (buf: Buffer | string) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            io.stderr.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        io.stderr.write("*");
      }
    };
    input.on("data", onData);
  });
}

export function writeln(out: Out, s = ""): void {
  out.write(s + "\n");
}
