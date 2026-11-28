import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from "../events.js";
import { generateOpenCodeConfig, writeOpenCodeConfig } from "./config.js";

const FORWARDED_SECRET_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "SECRETS_TOKEN",
  "SECRETS_API_URL",
] as const;

const SAFE_BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "SECRETS_AI_CONFIG_DIR",
] as const;

/**
 * Finds an available ephemeral TCP port on 127.0.0.1.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      const port = addr?.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (typeof port !== "number") {
          reject(new Error("Failed to allocate free port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `GET ${baseUrl}/doc` until `res.ok` or `timeoutMs` elapses.
 */
export async function waitForHealth(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl.replace(/\/+$/, "")}/doc`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Server not ready yet; retry until deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(150, remaining));
  }

  throw new Error(`OpenCode health check timed out after ${timeoutMs}ms (${url})`);
}

export interface OpenCodeSupervisorOptions {
  workspaceDir: string;
  command?: string;
  argsPrefix?: string[];
  env?: Record<string, string>;
  settings?: BridgeSettings;
  maxRestarts?: number;
  onCrash?: (code: number | null, signal: string | null) => void;
  onRestart?: (port: number) => void;
  secretsMcpPath?: string;
  githubMcpPath?: string;
}

/**
 * Manages the lifecycle of a local `opencode serve` process.
 */
export class OpenCodeSupervisor {
  private readonly workspaceDir: string;
  private readonly command: string;
  private readonly argsPrefix: string[];
  private readonly maxRestarts: number;
  private readonly onCrash?: (code: number | null, signal: string | null) => void;
  private readonly onRestart?: (port: number) => void;
  private readonly secretsMcpPath?: string;
  private readonly githubMcpPath?: string;

  private env: Record<string, string>;
  private settings: BridgeSettings;
  private child: ChildProcess | null = null;
  private _port: number | null = null;
  private _baseUrl: string | null = null;
  private stopped = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OpenCodeSupervisorOptions) {
    this.workspaceDir = options.workspaceDir;
    this.command = options.command || process.env.OPENCODE_BIN || "opencode";
    this.argsPrefix = options.argsPrefix ?? [];
    this.env = { ...(options.env ?? {}) };
    this.settings = options.settings ?? DEFAULT_BRIDGE_SETTINGS;
    this.maxRestarts = options.maxRestarts ?? 5;
    this.onCrash = options.onCrash;
    this.onRestart = options.onRestart;
    this.secretsMcpPath = options.secretsMcpPath;
    this.githubMcpPath = options.githubMcpPath;
  }

  get baseUrl(): string | null {
    return this._baseUrl;
  }

  get port(): number | null {
    return this._port;
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<{ port: number; baseUrl: string }> {
    if (this.isRunning && this._port !== null && this._baseUrl !== null) {
      return { port: this._port, baseUrl: this._baseUrl };
    }

    this.stopped = false;
    this.restartCount = 0;
    return this.spawnAndWait();
  }

  async updateSettings(settings: BridgeSettings, env?: Record<string, string>): Promise<void> {
    this.settings = settings;

    let envChanged = false;
    if (env) {
      for (const key of FORWARDED_SECRET_ENV_KEYS) {
        if ((env[key] ?? "") !== (this.env[key] ?? "")) {
          envChanged = true;
          break;
        }
      }
      this.env = { ...this.env, ...env };
    }

    this.writeConfig();

    if (envChanged && this.isRunning) {
      await this.stop();
      await this.start();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    this.child = null;
    this._port = null;
    this._baseUrl = null;

    if (!child || child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };

      child.once("exit", finish);

      const killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        finish();
      }, 3000);

      child.kill("SIGTERM");
    });
  }

  private writeConfig(): void {
    const config = generateOpenCodeConfig({
      settings: this.settings,
      secretsMcpPath: this.secretsMcpPath,
      githubMcpPath: this.githubMcpPath,
    });
    writeOpenCodeConfig(this.workspaceDir, config);
  }

  private buildSanitizedEnv(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const key of SAFE_BASE_ENV_KEYS) {
      const val = process.env[key];
      if (val !== undefined) out[key] = val;
    }
    for (const key of FORWARDED_SECRET_ENV_KEYS) {
      const val = this.env[key] ?? process.env[key];
      if (val !== undefined && val !== "") {
        out[key] = val;
      }
    }
    return out;
  }

  private async spawnAndWait(): Promise<{ port: number; baseUrl: string }> {
    this.writeConfig();
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = [...this.argsPrefix, "serve", "--port", String(port), "--hostname", "127.0.0.1"];

    const child = spawn(this.command, args, {
      cwd: this.workspaceDir,
      env: this.buildSanitizedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    this._port = port;
    this._baseUrl = baseUrl;

    let exitedEarly = false;
    let earlyExitDetail = "";

    const onEarlyExit = (code: number | null, signal: string | null) => {
      exitedEarly = true;
      earlyExitDetail = `code=${code ?? "null"}, signal=${signal ?? "null"}`;
    };
    child.once("exit", onEarlyExit);

    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopped) return;

      this.onCrash?.(code, signal);

      if (this.restartCount < this.maxRestarts) {
        this.restartCount += 1;
        const backoffMs = Math.min(200 * this.restartCount, 2000);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.stopped) return;
          void this.spawnAndWait()
            .then((info) => {
              this.onRestart?.(info.port);
            })
            .catch(() => {
              // Crash/restart cycle will be handled if process exited.
            });
        }, backoffMs);
      }
    });

    // Drain stdout/stderr so child pipes never block.
    child.stdout?.resume();
    child.stderr?.resume();

    try {
      const deadline = Date.now() + 15000;
      const healthUrl = `${baseUrl}/doc`;
      while (Date.now() < deadline) {
        if (exitedEarly) {
          throw new Error(`OpenCode process exited before becoming healthy (${earlyExitDetail})`);
        }
        try {
          const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            child.off("exit", onEarlyExit);
            return { port, baseUrl };
          }
        } catch {
          // Retry until deadline or early exit.
        }
        await sleep(150);
      }
      throw new Error(`OpenCode health check timed out after 15000ms (${healthUrl})`);
    } catch (err) {
      child.off("exit", onEarlyExit);
      if (this.child === child && child.exitCode === null) {
        this.stopped = true;
        child.kill("SIGKILL");
        this.child = null;
        this._port = null;
        this._baseUrl = null;
      }
      throw err;
    }
  }
}
