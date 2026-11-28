import { loadSecrets } from "../../core/auth.js";
import { paths } from "../../core/paths.js";
import { loadSettings, mergeSettings, saveSettings, validateSettingsPatch } from "../../core/settings.js";
import type { Settings } from "../../core/types.js";
import { formatEffort, parseSettingsAssignments, UsageError } from "../args.js";
import { BridgeUnreachableError } from "../client.js";
import { EXIT, flagBool, type Ctx } from "../context.js";
import { writeln } from "../io.js";

export function formatSettings(st: Settings): string {
  const lines = [
    `provider       ${st.provider}`,
    `model          ${st.model}`,
    `effort         ${formatEffort(st.effort)}`,
    `agentMode      ${st.agentMode}`,
    `tools.github   ${st.tools.github}`,
    `tools.secrets  ${st.tools.secrets}`,
    `systemPrompt   ${st.systemPrompt ? JSON.stringify(st.systemPrompt.length > 60 ? st.systemPrompt.slice(0, 59) + "…" : st.systemPrompt) : "-"}`,
    `secretsApiUrl  ${st.secretsApiUrl ?? "-"}`,
  ];
  return lines.join("\n");
}

async function current(ctx: Ctx): Promise<{ settings: Settings; remote: boolean }> {
  try {
    return { settings: (await ctx.client().getSettings()).settings, remote: true };
  } catch (err) {
    if (!(err instanceof BridgeUnreachableError)) throw err;
    return { settings: loadSettings(ctx.io.env), remote: false };
  }
}

export async function settings(ctx: Ctx): Promise<number> {
  const { io, s } = ctx;
  const [sub = "get", ...rest] = ctx.args.positionals;
  if (sub === "get") {
    if (rest.length) throw new UsageError("usage: secrets-ai settings get [--json]");
    const { settings: st, remote } = await current(ctx);
    if (flagBool(ctx, "json")) writeln(io.stdout, JSON.stringify(st, null, 2));
    else {
      writeln(io.stdout, formatSettings(st));
      if (!remote) writeln(io.stdout, s.dim(`(bridge not running; showing ${paths.settingsFile(io.env)})`));
    }
    return EXIT.ok;
  }
  if (sub !== "set") throw new UsageError("usage: secrets-ai settings [get | set key=value ...]");
  const { patch, tools } = parseSettingsAssignments(rest);
  const { settings: cur, remote } = await current(ctx);
  const full: Record<string, unknown> = { ...patch };
  if (Object.keys(tools).length) full.tools = { ...cur.tools, ...tools };
  const valid = validateSettingsPatch(full);
  // `null` clears optional strings; keep them explicit for the bridge.
  for (const k of ["systemPrompt", "secretsApiUrl"] as const) if (full[k] === null) (valid as Record<string, unknown>)[k] = null;
  let next: Settings;
  if (remote) {
    next = (await ctx.client().putSettings(valid)).settings;
  } else {
    next = mergeSettings(cur, valid);
    for (const k of ["systemPrompt", "secretsApiUrl"] as const) if (full[k] === null) delete next[k];
    saveSettings(next, io.env);
  }
  writeln(io.stdout, formatSettings(next));
  writeln(io.stdout, s.dim(remote ? "saved on the bridge" : `bridge not running; saved to ${paths.settingsFile(io.env)}`));
  if (next.tools.github && !loadSecrets(io.env).githubToken && !remote) writeln(io.stdout, s.yellow("note: tools.github needs a GitHub token: secrets-ai auth set github"));
  return EXIT.ok;
}
