import type { Effort, ModelInfo, ResolvedEffort } from "../core/types.js";

/** Ordered reasoning scale used for "nearest variant" matching. */
export const VARIANT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const STEPS = { low: 3, medium: 8, high: 20 } as const;
export const DEFAULT_CUSTOM_STEPS = STEPS.medium;

const rank = (v: string): number => VARIANT_SCALE.indexOf(v as (typeof VARIANT_SCALE)[number]);

/**
 * Pick the variant closest to `target` on the scale. Ties prefer the higher variant (more effort
 * is the safer surprise than less). Variants not on the scale are only chosen on exact match.
 */
export function nearestVariant(target: string, available: readonly string[]): string | undefined {
  if (available.includes(target)) return target;
  const t = rank(target);
  if (t < 0) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  let bestRank = -1;
  for (const v of available) {
    const r = rank(v);
    if (r < 0) continue;
    const d = Math.abs(r - t);
    if (d < bestDist || (d === bestDist && r > bestRank)) {
      best = v;
      bestDist = d;
      bestRank = r;
    }
  }
  return best;
}

function clampSteps(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_CUSTOM_STEPS;
  return Math.min(200, Math.max(1, Math.round(v)));
}

/** Low=3, Medium=8, High=20, Custom=effort.maxSteps; variant = nearest one the model supports. */
export function resolveEffort(effort: Effort, model?: Pick<ModelInfo, "variants" | "reasoning">): ResolvedEffort {
  const level = effort?.level ?? "medium";
  const steps = level === "custom" ? clampSteps(effort.maxSteps) : (STEPS[level] ?? STEPS.medium);
  const variants = model?.variants ?? [];
  if (!model || model.reasoning === false || variants.length === 0) return { steps };
  let variant: string | undefined;
  switch (level) {
    case "low":
      variant = nearestVariant("low", variants);
      break;
    case "high":
      if (variants.includes("high")) variant = "high";
      else if (variants.includes("xhigh")) variant = "xhigh";
      else if (variants.includes("max")) variant = "max";
      else variant = nearestVariant("high", variants);
      break;
    case "custom":
      variant = effort.variant && variants.includes(effort.variant) ? effort.variant : undefined;
      break;
    default:
      variant = nearestVariant("medium", variants);
  }
  return variant ? { steps, variant } : { steps };
}
