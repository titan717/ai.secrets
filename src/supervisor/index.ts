/**
 * Per-workspace supervisor for `opencode serve`.
 *
 * - Spawns `opencode serve --port 0 --hostname 127.0.0.1` with cwd = workspace, a random
 *   OPENCODE_SERVER_PASSWORD and isolated XDG_* dirs under paths.workspaceStateDir(id), so the
 *   user's own OpenCode config/auth is never read or modified.
 * - OPENCODE_CONFIG points at a generated opencode.json inside that state dir (never in the repo).
 * - Provider keys reach the child only through env from buildProviderEnv(); they are registered
 *   for redaction and never logged.
 * - Parses the port from stdout, polls /global/health, restarts on crash with capped exponential
 *   backoff, and gives up after `maxCrashes` crashes inside `crashWindowMs`.
 * - stop(): SIGTERM, then SIGKILL after `killTimeoutMs`. Children are killed on process exit.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type Logger } from "../core/log.js";
import { paths } from "../core/paths.js";
import { redact, registerSecret } from "../core/redact.js";
import { writePrivateJson } from "../core/secure-file.js";
import type { Secrets, Settings } from "../core/types.js";
import { buildOpenCodeConfig, buildProviderEnv } from "../presets/index.js";
import { OpenCodeClient } from "../opencode/client.js";

export type SupervisorState = "stopped" | "starting" | "running" | "backoff" | "failed";

export interface SupervisorStatus {
  state: SupervisorState;
  message?: string;
  url?: string;
  version?: string;
  crashes: number;
}

export interface SupervisorOptions {
  workspace: string;
  /** Defaults to a hash of the absolute workspace path. */
  workspaceId?: string;
  /** Env used for path resolution (SECRETS_AI_HOME ...) and as the child's base env. */
  env?: NodeJS.ProcessEnv;
  /** opencode binary; default $OPENCODE_BIN or "opencode". A .js/.mjs path is run with the current node. */
  bin?: string;
  getSettings: () => Settings;
  getSecrets: () => Secrets;
  /** Test hook: transform the generated opencode.json before it is written. */
  configOverride?: (cfg: Record<string, unknown>) => Record<string, unknown>;
  /** Extra env for the child (tests only; never secrets). */
  extraEnv?: Record<string, string>;
  logger?: Logger;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
  killTimeoutMs?: number;
  maxCrashes?: number;
  crashWindowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** Env vars that must never leak from the bridge's own environment into the child. */
const STRIP_ENV = [
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "SECRETS_TOKEN",
  "SECRETS_AI_TOKEN",
  "SECRETS_AI_GITHUB_TOKEN",
  "SECRETS_AI_SECRETS_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
];

const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const c of live) killTree(c, "SIGKILL");
  });
}

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

export function workspaceIdFor(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
}

/** Repo/package root (directory containing package.json) of this module, for locating dist/mcp. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpenCodeSupervisor extends EventEmitter {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly stateDir: string;
  readonly configPath: string;
  readonly client: OpenCodeClient;
  private opts: SupervisorOptions;
  private log: Logger;
  private child?: ChildProcess;
  private password = "";
  private status: SupervisorStatus = { state: "stopped", crashes: 0 };
  private crashTimes: number[] = [];
  private wantRunning = false;
  private signature = "";
  private overrides: Secrets = {};
  private startPromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  /** Incremented on every successful (re)start; lets consumers detect a new child. */
  generation = 0;

  constructor(opts: SupervisorOptions) {
    super();
    this.opts = opts;
    this.workspace = resolve(opts.workspace);
    this.workspaceId = opts.workspaceId ?? workspaceIdFor(this.workspace);
    this.stateDir = paths.workspaceStateDir(this.workspaceId, opts.env);
    this.configPath = join(this.stateDir, "opencode.json");
    this.log = opts.logger ?? createLogger(`opencode:${this.workspaceId.slice(0, 6)}`);
    this.client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:0" });
    installExitHook();
  }

  get state(): SupervisorStatus {
    return { ...this.status };
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private setStatus(s: Partial<SupervisorStatus>) {
    this.status = { ...this.status, ...s };
    this.emit("status", this.state);
  }

  /** Per-request secret overrides (in memory only). Applied on the next (re)start. */
  setSecretOverrides(o: Secrets): void {
    this.overrides = Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Secrets;
  }

  private secrets(): Secrets {
    return { ...this.opts.getSecrets(), ...this.overrides };
  }

  /** Generate (and write) opencode.json + the child env. */
  private prepare(): { env: NodeJS.ProcessEnv; signature: string } {
    const secrets = this.secrets();
    const settings = this.opts.getSettings();
    let cfg = buildOpenCodeConfig({
      settings,
      available: { openrouter: !!secrets.openrouterApiKey, google: !!secrets.geminiApiKey, github: !!secrets.githubToken, secrets: !!secrets.secretsToken },
      secretsMcpEntry: join(packageRoot(), "dist", "mcp", "secrets-mcp.js"),
      nodePath: process.execPath,
    });
    if (this.opts.configOverride) cfg = this.opts.configOverride(cfg);
    const providerEnv = buildProviderEnv(secrets);
    for (const v of Object.values(providerEnv)) registerSecret(v);
    const signature = createHash("sha256")
      .update(JSON.stringify(cfg))
      .update(JSON.stringify(Object.entries(providerEnv).sort()))
      .digest("hex");
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    writePrivateJson(this.configPath, cfg);

    const base: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    for (const k of STRIP_ENV) delete base[k];
    const xdg = (n: string) => {
      const d = join(this.stateDir, n);
      mkdirSync(d, { recursive: true, mode: 0o700 });
      return d;
    };
    const env: NodeJS.ProcessEnv = {
      ...base,
      ...(this.opts.extraEnv ?? {}),
      ...providerEnv,
      OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_CONFIG: this.configPath,
      XDG_CONFIG_HOME: xdg("config"),
      XDG_DATA_HOME: xdg("data"),
      XDG_STATE_HOME: xdg("state"),
      XDG_CACHE_HOME: xdg("cache"),
    };
    return { env, signature };
  }

  /** Start (or wait for the in-flight start). Resolves once healthy; rejects if the first start fails. */
  start(): Promise<void> {
    this.wantRunning = true;
    if (this.status.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const p = this.spawnOnce().finally(() => {
      if (this.startPromise === p) this.startPromise = undefined;
    });
    this.startPromise = p;
    return p;
  }

  /** Resolve when running (starting it if needed), or reject after timeoutMs / on failure. */
  async ready(timeoutMs = 30_000): Promise<void> {
    if (this.status.state === "running") return;
    if (this.status.state === "failed") throw new Error(this.status.message ?? "opencode failed");
    if (this.status.state === "stopped") return this.start();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.off("status", on);
        reject(new Error("timed out waiting for opencode"));
      }, timeoutMs);
      const on = (s: SupervisorStatus) => {
        if (s.state === "running") {
          clearTimeout(t);
          this.off("status", on);
          resolve();
        } else if (s.state === "failed" || s.state === "stopped") {
          clearTimeout(t);
          this.off("status", on);
          reject(new Error(s.message ?? `opencode ${s.state}`));
        }
      };
      this.on("status", on);
    });
  }

  private async spawnOnce(): Promise<void> {
    this.password = randomBytes(24).toString("base64url");
    registerSecret(this.password);
    const { env, signature } = this.prepare();
    this.signature = signature;
    // Per-request keys set via PUT /auth are transient: never keep them across child restarts.
    rmSync(join(env.XDG_DATA_HOME!, "opencode", "auth.json"), { force: true });
    const bin = this.opts.bin || this.opts.env?.OPENCODE_BIN || process.env.OPENCODE_BIN || "opencode";
    const args = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
    let cmd = bin;
    let argv = args;
    let shell = false;
    if (/\.(m?js|cjs)$/i.test(bin)) {
      cmd = process.execPath;
      argv = [bin, ...args];
    } else if (process.platform === "win32" && !/\.exe$/i.test(bin)) {
      // npm installs opencode as opencode.cmd on Windows, which needs a shell. Arguments are fixed
      // literals and the command is quoted, so nothing user-controlled reaches the shell.
      shell = true;
      cmd = `"${bin.replace(/"/g, "")}"`;
    }
    this.setStatus({ state: "starting", message: undefined, url: undefined });
    this.log.info(`starting opencode in ${this.workspace}`);
    const child = spawn(cmd, argv, { cwd: this.workspace, env, stdio: ["ignore", "pipe", "pipe"], shell, windowsHide: true });
    this.child = child;
    live.add(child);

    const startTimeout = this.opts.startTimeoutMs ?? 30_000;
    const url = await new Promise<string>((resolveUrl, reject) => {
      let buf = "";
      const timer = setTimeout(() => fail(new Error(`opencode did not report a listening port within ${startTimeout}ms`)), startTimeout);
      const onOut = (d: Buffer) => {
        buf += d.toString("utf8");
        const m = /listening on (https?:\/\/[^\s]+)/.exec(buf);
        if (m) {
          cleanup();
          resolveUrl(m[1]!.replace(/\/+$/, ""));
        }
        if (buf.length > 65536) buf = buf.slice(-4096);
      };
      const onExit = (code: number | null, sig: string | null) => fail(new Error(`opencode exited during startup (code ${code}, signal ${sig})`));
      const onErr = (e: Error) => fail(new Error(`failed to spawn opencode (${bin}): ${e.message}`));
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout!.off("data", onOut);
        child.off("exit", onExit);
        child.off("error", onErr);
      };
      const fail = (e: Error) => {
        cleanup();
        reject(e);
      };
      child.stdout!.on("data", onOut);
      child.once("exit", onExit);
      child.once("error", onErr);
    }).catch((e: Error) => {
      this.onStartFailure(child, e);
      throw e;
    });

    this.pipeLogs(child);
    child.on("exit", (code, sig) => this.onExit(child, code, sig));
    this.client.setTarget(url, this.password);

    const healthTimeout = this.opts.healthTimeoutMs ?? 20_000;
    const deadline = Date.now() + healthTimeout;
    let version: string | undefined;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("opencode exited before becoming healthy");
      }
      try {
        const h = await this.client.health(2000);
        if (h?.healthy) {
          version = h.version;
          break;
        }
      } catch {
        /* not ready yet */
      }
      if (Date.now() > deadline) {
        const e = new Error(`opencode not healthy after ${healthTimeout}ms`);
        this.onStartFailure(child, e);
        throw e;
      }
      await sleep(100);
    }
    this.generation++;
    this.setStatus({ state: "running", url, version, message: undefined });
    this.log.info(`opencode ${version ?? ""} ready at ${url}`);
    this.emit("ready", { url, version, generation: this.generation });
  }

  private onStartFailure(child: ChildProcess, e: Error) {
    this.log.warn(redact(e.message));
    killTree(child, "SIGKILL");
    live.delete(child);
    if (this.child === child) this.child = undefined;
    this.recordCrash(e.message);
  }

  private pipeLogs(child: ChildProcess) {
    const lines = (stream: NodeJS.ReadableStream | null, lvl: "debug" | "warn") => {
      let buf = "";
      stream?.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line) this.log[lvl](`opencode: ${redact(line)}`);
        }
        if (buf.length > 16384) buf = buf.slice(-1024);
      });
    };
    lines(child.stdout, "debug");
    lines(child.stderr, "warn");
  }

  private onExit(child: ChildProcess, code: number | null, sig: string | null) {
    live.delete(child);
    if (this.child !== child) return;
    this.child = undefined;
    this.emit("exit", { code, signal: sig });
    if (!this.wantRunning) {
      this.setStatus({ state: "stopped", url: undefined });
      return;
    }
    this.log.warn(`opencode exited unexpectedly (code ${code}, signal ${sig})`);
    this.recordCrash(`opencode exited (code ${code}, signal ${sig})`);
  }

  private recordCrash(message: string) {
    const now = Date.now();
    const windowMs = this.opts.crashWindowMs ?? 60_000;
    this.crashTimes = this.crashTimes.filter((t) => now - t < windowMs);
    this.crashTimes.push(now);
    const n = this.crashTimes.length;
    const max = this.opts.maxCrashes ?? 5;
    if (!this.wantRunning) return;
    if (n >= max) {
      this.wantRunning = false;
      this.setStatus({ state: "failed", crashes: n, url: undefined, message: `opencode crashed ${n} times within ${Math.round(windowMs / 1000)}s; giving up (${message})` });
      this.log.error(this.status.message!);
      return;
    }
    const delay = Math.min(this.opts.backoffMaxMs ?? 10_000, (this.opts.backoffBaseMs ?? 500) * 2 ** (n - 1));
    this.setStatus({ state: "backoff", crashes: n, url: undefined, message: `${message}; restarting in ${delay}ms` });
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.wantRunning || this.child) return;
      this.start().catch(() => {
        /* recordCrash already scheduled the next attempt */
      });
    }, delay);
  }

  /** Stop the child: SIGTERM, then SIGKILL after killTimeoutMs. */
  async stop(): Promise<void> {
    this.wantRunning = false;
    clearTimeout(this.restartTimer);
    if (this.startPromise) await this.startPromise.catch(() => {});
    const child = this.child;
    if (!child) {
      this.setStatus({ state: "stopped", url: undefined });
      return;
    }
    await new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      const t = setTimeout(() => killTree(child, "SIGKILL"), this.opts.killTimeoutMs ?? 5000);
      child.once("exit", () => {
        clearTimeout(t);
        done();
      });
      if (process.platform === "win32") killTree(child, "SIGKILL");
      else child.kill("SIGTERM");
    });
    this.setStatus({ state: "stopped", url: undefined });
  }

  /** Stop then start a fresh child (new password, regenerated config). */
  async restart(reason = "restart"): Promise<void> {
    this.log.info(`restarting opencode: ${reason}`);
    await this.stop();
    this.crashTimes = [];
    this.setStatus({ crashes: 0 });
    await this.start();
  }

  /**
   * Regenerate opencode.json + env from current settings/secrets. Restarts the child if anything
   * changed. Returns true when a restart happened.
   */
  async reload(): Promise<boolean> {
    const was = this.signature;
    if (this.status.state !== "running" && this.status.state !== "starting") {
      // Not running: just refresh the config on disk for the next start.
      this.signature = this.prepare().signature;
      return false;
    }
    const pw = this.password;
    const next = this.prepare().signature;
    this.password = pw;
    if (next === was) return false;
    await this.restart("config changed");
    return true;
  }
}
