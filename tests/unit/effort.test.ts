import { describe, expect, it } from "vitest";
import { resolveEffort, nearestVariant, VARIANT_SCALE } from "../../src/presets/effort.js";

// Real variant sets observed in OpenCode 1.19.6 /config/providers (docs/OPENCODE-NOTES.md section 6 + google fixture).
const GPT5_MINI = ["minimal", "low", "medium", "high"];
const SONNET = ["low", "medium", "high"];
const NEMOTRON_ULTRA = ["none", "medium", "high"];
const NEMOTRON_NANO = ["high", "max"];
const PARTICLE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const FREE = ["none"];
const m = (variants?: string[], reasoning = true) => ({ variants, reasoning });

describe("resolveEffort steps", () => {
  it("maps levels to 3/8/20", () => {
    expect(resolveEffort({ level: "low" }).steps).toBe(3);
    expect(resolveEffort({ level: "medium" }).steps).toBe(8);
    expect(resolveEffort({ level: "high" }).steps).toBe(20);
  });
  it("custom uses maxSteps, clamped to 1..200, default 8", () => {
    expect(resolveEffort({ level: "custom", maxSteps: 42 }).steps).toBe(42);
    expect(resolveEffort({ level: "custom", maxSteps: 0 }).steps).toBe(1);
    expect(resolveEffort({ level: "custom", maxSteps: 999 }).steps).toBe(200);
    expect(resolveEffort({ level: "custom" }).steps).toBe(8);
  });
  it("no variant without model, without variants, or reasoning=false", () => {
    expect(resolveEffort({ level: "high" })).toEqual({ steps: 20 });
    expect(resolveEffort({ level: "high" }, m(undefined))).toEqual({ steps: 20 });
    expect(resolveEffort({ level: "high" }, m([]))).toEqual({ steps: 20 });
    expect(resolveEffort({ level: "high" }, m(SONNET, false))).toEqual({ steps: 20 });
  });
});

describe("resolveEffort variants on real sets", () => {
  const table: [string, string[], Record<string, string | undefined>][] = [
    ["gpt-5-mini", GPT5_MINI, { low: "low", medium: "medium", high: "high" }],
    ["sonnet-4.5", SONNET, { low: "low", medium: "medium", high: "high" }],
    ["nemotron-ultra", NEMOTRON_ULTRA, { low: "medium", medium: "medium", high: "high" }],
    ["nemotron-nano", NEMOTRON_NANO, { low: "high", medium: "high", high: "high" }],
    ["particle", PARTICLE, { low: "low", medium: "medium", high: "high" }],
    ["openrouter/free", FREE, { low: "none", medium: "none", high: "none" }],
    ["two-high-max", ["high", "max"], { low: "high", medium: "high", high: "high" }],
    ["two-low-high", ["low", "high"], { low: "low", medium: "high", high: "high" }],
    ["xhigh-only", ["medium", "xhigh"], { low: "medium", medium: "medium", high: "xhigh" }],
    ["max-only", ["low", "max"], { low: "low", medium: "low", high: "max" }],
  ];
  for (const [name, vs, exp] of table) {
    for (const level of ["low", "medium", "high"] as const) {
      it(`${name} ${level} -> ${exp[level]}`, () => {
        expect(resolveEffort({ level }, m(vs)).variant).toBe(exp[level]);
      });
    }
  }
  it("high prefers xhigh over max when high is missing", () => {
    expect(resolveEffort({ level: "high" }, m(["xhigh", "max"])).variant).toBe("xhigh");
  });
  it("custom uses effort.variant only if the model has it", () => {
    expect(resolveEffort({ level: "custom", maxSteps: 5, variant: "xhigh" }, m(PARTICLE))).toEqual({ steps: 5, variant: "xhigh" });
    expect(resolveEffort({ level: "custom", maxSteps: 5, variant: "xhigh" }, m(SONNET))).toEqual({ steps: 5 });
    expect(resolveEffort({ level: "custom", maxSteps: 5 }, m(SONNET))).toEqual({ steps: 5 });
  });
  it("unknown variant names are ignored by nearest but kept on exact match", () => {
    expect(resolveEffort({ level: "medium" }, m(["thinking"])).variant).toBeUndefined();
    expect(resolveEffort({ level: "custom", maxSteps: 3, variant: "thinking" }, m(["thinking"])).variant).toBe("thinking");
  });
});

describe("nearestVariant", () => {
  it("exact match wins", () => {
    for (const v of VARIANT_SCALE) expect(nearestVariant(v, PARTICLE)).toBe(v);
  });
  it("ties prefer the higher variant", () => {
    expect(nearestVariant("medium", ["low", "high"])).toBe("high");
    expect(nearestVariant("low", ["minimal", "medium"])).toBe("medium");
  });
  it("undefined when nothing on the scale", () => {
    expect(nearestVariant("medium", [])).toBeUndefined();
    expect(nearestVariant("bogus", ["low"])).toBeUndefined();
  });
});
