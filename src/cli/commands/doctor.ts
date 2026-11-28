import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readAuthFile } from "../../core/auth.js";
import { configDir, paths } from "../../core/paths.js";
import { ApiError, BridgeUnreachableError } from "../client.js";
import { EXIT, flagBool, flagStr, type Ctx } from "../context.js";
import { writeln } from "../io.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export function detectPlatform(env: NodeJS.ProcessEnv, platform: string = process.platform, arch: string = process.arch): string {
  const termux = (env.PREFIX ?? "").includes("com.termux") || !!env.TERMUX_VERSION;
  if (termux) return `termux (android ${arch})`;
  if (platform === "win32") return `windows ${arch}`;
  if (platform === "darwin") return `macos ${arch}`;
  if (platform === "linux" && existsSync("/.dockerenv")) return `linux ${arch} (docker)`;
  return `${platform} ${arch}`;
}

export function opencodeVersion(bin: string): { ok: boolean; version?: string; error?: string } {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000, shell: process.platform === "win32", windowsHide: true });
  if (r.error) return { ok: false, error: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "not found on PATH" : r.error.message };
  if (r.status !== 0) return { ok: false, error: `exited with ${r.status}` };
  const v = /\d+\.\d+\.\d+[\w.-]*/.exec(`${r.stdout}${r.stderr}`)?.[0];
  return { ok: true, version: v ?? r.stdout.trim().slice(0, 40) };
}

export async function runChecks(ctx: Ctx): Promise<Check[]> {
  const { io } = ctx;
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20 ? "ok" : "fail", `v${process.versions.node}${major >= 20 ? "" : " (need >= 20)"}`);
  add("platform", "ok", detectPlatform(io.env));

  const bin = flagStr(ctx, "opencode-bin") ?? io.env.OPENCODE_BIN ?? "opencode";
  const oc = opencodeVersion(bin);
  if (oc.ok) add("opencode", "ok", `${bin} ${oc.version ?? ""}`.trim());
  else add("opencode", "warn", `${bin}: ${oc.error} (needed only on the bridge host: npm i -g opencode-ai)`);

  const dir = configDir(io.env);
  if (!existsSync(dir)) add("config dir", "warn", `${dir} missing (run \`secrets-ai init\`)`);
  else if (process.platform === "win32") add("config dir", "ok", `${dir} (per-user profile ACLs)`);
  else {
    const dmode = statSync(dir).mode & 0o777;
    add("config dir", dmode & 0o077 ? "warn" : "ok", `${dir} mode ${dmode.toString(8)}${dmode & 0o077 ? " (should be 700: chmod 700)" : ""}`);
    const af = paths.authFile(io.env);
    if (existsSync(af)) {
      const fmode = statSync(af).mode & 0o777;
      add("auth file", fmode & 0o077 ? "fail" : "ok", `mode ${fmode.toString(8)}${fmode & 0o077 ? ` (run: chmod 600 ${af})` : ""}`);
    }
  }

  const tokenSrc = ctx.args.global.token ? "--token" : io.env.SECRETS_AI_TOKEN ? "SECRETS_AI_TOKEN" : readAuthFile(io.env) ? "auth file" : undefined;
  const client = ctx.client();
  let reachable = false;
  try {
    const h = await client.health();
    reachable = true;
    add(
      "bridge",
      h.ok ? "ok" : "warn",
      `${client.url} v${h.version}; opencode ${h.opencode.running ? `running${h.opencode.version ? ` ${h.opencode.version}` : ""}` : "not running"}, ${h.opencode.workspaces} workspace(s)`,
    );
  } catch (err) {
    add("bridge", "fail", err instanceof BridgeUnreachableError ? `not reachable at ${client.url} (start it with \`secrets-ai serve\`)` : (err as Error).message);
  }
  if (!tokenSrc) add("token", "fail", "no token (run `secrets-ai init`, or set SECRETS_AI_TOKEN)");
  else if (!reachable) add("token", "warn", `from ${tokenSrc}; not verified (bridge unreachable)`);
  else {
    try {
      const st = await client.getSettings();
      add("token", "ok", `accepted (from ${tokenSrc})`);
      const keys = Object.entries(st.secrets).filter(([, v]) => v).map(([k]) => k);
      add("provider", keys.includes(st.settings.provider === "google" ? "google" : "openrouter") ? "ok" : "warn", `${st.settings.provider} / ${st.settings.model}; keys: ${keys.join(", ") || "none"}`);
    } catch (err) {
      add("token", "fail", err instanceof ApiError && err.status === 401 ? `rejected by the bridge (from ${tokenSrc})` : (err as Error).message);
    }
  }
  return checks;
}

export async function doctor(ctx: Ctx): Promise<number> {
  const checks = await runChecks(ctx);
  const { io, s } = ctx;
  if (flagBool(ctx, "json")) writeln(io.stdout, JSON.stringify({ checks }, null, 2));
  else {
    const mark = { ok: s.green("ok  "), warn: s.yellow("warn"), fail: s.red("FAIL") };
    for (const c of checks) writeln(io.stdout, `${mark[c.status]}  ${c.name.padEnd(10)}  ${c.detail}`);
  }
  return checks.some((c) => c.status === "fail") ? EXIT.error : EXIT.ok;
}
