import { EFFORT_STEPS, type AiProvider, type Effort } from "../contract.js";

export type OpenCodeEffortTier = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface EffortMapping {
  maxSteps: number;
  reasoningEffort: OpenCodeEffortTier;
  thinkingBudget?: number;
}

/**
 * Maps Secrets effort (low/medium/high/custom) to OpenCode reasoning options and max agent steps.
 * Low: 3 steps, Medium: 8 steps, High: 20 steps, Custom: user-defined (1..100).
 */
export function mapEffort(effort: Effort): EffortMapping {
  switch (effort.level) {
    case "low":
      return { maxSteps: EFFORT_STEPS.low, reasoningEffort: "low" };
    case "medium":
      return { maxSteps: EFFORT_STEPS.medium, reasoningEffort: "medium" };
    case "high":
      return { maxSteps: EFFORT_STEPS.high, reasoningEffort: "high" };
    case "custom": {
      const rawSteps = Number(effort.maxSteps);
      const maxSteps = Number.isFinite(rawSteps) && rawSteps >= 1 ? Math.min(100, Math.floor(rawSteps)) : EFFORT_STEPS.medium;
      const budget = typeof effort.thinkingBudget === "number" ? Math.floor(effort.thinkingBudget) : undefined;
      if (budget !== undefined && budget <= 0) {
        return { maxSteps, reasoningEffort: "none", thinkingBudget: 0 };
      }
      const reasoningEffort: OpenCodeEffortTier =
        budget === undefined ? "medium" : budget <= 2048 ? "low" : budget <= 12000 ? "medium" : "high";
      return { maxSteps, reasoningEffort, thinkingBudget: budget };
    }
  }
}

export function formatOpenCodeModel(provider: AiProvider, model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return provider === "gemini" ? "google/gemini-2.5-flash" : "openrouter/auto";
  if (trimmed.includes("/")) return trimmed;
  if (provider === "gemini") return `google/${trimmed}`;
  if (provider === "openrouter") return `openrouter/${trimmed}`;
  return trimmed;
}
