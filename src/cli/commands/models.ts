import type { ModelInfo } from "../../core/types.js";
import { EXIT, flagBool, flagStr, type Ctx } from "../context.js";
import { writeln } from "../io.js";

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export function modelsTable(models: ModelInfo[]): string {
  const yn = (b: boolean) => (b ? "yes" : "-");
  const ctxLen = (n?: number) => (n ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : "-");
  const rows = [["ID", "PROVIDER", "TOOLS", "REASONING", "FREE", "CONTEXT", "VARIANTS"]];
  for (const m of models) rows.push([m.id, String(m.provider), yn(m.toolCall), yn(m.reasoning), yn(m.free), ctxLen(m.contextLength), m.variants?.join(",") || "-"]);
  return table(rows);
}

export async function models(ctx: Ctx): Promise<number> {
  const list = await ctx.client().models({ provider: flagStr(ctx, "provider"), freeTools: flagBool(ctx, "free-tools") });
  if (flagBool(ctx, "json")) {
    writeln(ctx.io.stdout, JSON.stringify(list, null, 2));
    return EXIT.ok;
  }
  if (!list.length) {
    writeln(ctx.io.stdout, "no models found (is a provider key configured? try `secrets-ai auth status`)");
    return EXIT.ok;
  }
  writeln(ctx.io.stdout, modelsTable(list));
  writeln(ctx.io.stdout, ctx.s.dim(`${list.length} model(s)`));
  return EXIT.ok;
}
