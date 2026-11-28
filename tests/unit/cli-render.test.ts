import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { formatUsage, Renderer, summarize } from "../../src/cli/render.js";
import type { AiEvent } from "../../src/core/events.js";

function render(evs: AiEvent[], opts = { color: false, showReasoning: false }, endTurn = false): string {
  const out = new PassThrough();
  let s = "";
  out.on("data", (c: Buffer) => (s += c.toString()));
  const r = new Renderer(out, opts);
  r.startTurn();
  for (const e of evs) r.event(e);
  if (endTurn) r.endTurn();
  return s;
}

const sid = "ses_1";

describe("Renderer (no color)", () => {
  it("streams text deltas inline", () => {
    expect(render([{ type: "text.delta", sessionId: sid, text: "Hel" }, { type: "text.delta", sessionId: sid, text: "lo" }, { type: "session.idle", sessionId: sid }])).toBe("Hello\n");
  });

  it("hides reasoning by default and shows it on its own line when enabled", () => {
    const evs: AiEvent[] = [
      { type: "reasoning.delta", sessionId: sid, text: "think" },
      { type: "text.delta", sessionId: sid, text: "answer" },
    ];
    expect(render(evs)).toBe("answer");
    expect(render(evs, { color: false, showReasoning: true })).toBe("thinking: think\nanswer");
  });

  it("dims reasoning with ANSI when color is on", () => {
    expect(render([{ type: "reasoning.delta", sessionId: sid, text: "t" }], { color: true, showReasoning: true })).toContain("\x1b[2mt\x1b[22m");
  });

  it("summarizes tool.start / tool.end on one line each", () => {
    const s = render([
      { type: "text.delta", sessionId: sid, text: "Let me check" },
      { type: "tool.start", sessionId: sid, callId: "c1", name: "bash", input: { command: "ls -la\n/tmp" } },
      { type: "tool.end", sessionId: sid, callId: "c1", output: "file1\nfile2" },
      { type: "tool.start", sessionId: sid, callId: "c2", name: "edit", input: { filePath: "a.txt" } },
      { type: "tool.end", sessionId: sid, callId: "c2", name: "edit", output: null, error: "The user rejected permission" },
    ]);
    expect(s).toBe("Let me check\n> bash ls -la /tmp\n= bash done file1 file2\n> edit a.txt\nx edit failed: The user rejected permission\n");
  });

  it("renders permission requests/resolutions, questions, errors, retry status and steps", () => {
    const s = render([
      { type: "permission.request", sessionId: sid, permissionId: "per_1", action: "bash", detail: { patterns: ["echo hi > b.txt"], metadata: {}, always: ["echo *"] } },
      { type: "permission.resolved", sessionId: sid, permissionId: "per_1", reply: "reject" },
      { type: "question", sessionId: sid, questionId: "q1", text: "Pick one", options: ["red", "blue"] },
      { type: "error", sessionId: sid, message: "rate limited", code: "APIError" },
      { type: "status", sessionId: sid, status: "retry", attempt: 2, message: "busy" },
      { type: "status", sessionId: sid, status: "busy" },
      { type: "step", sessionId: sid, step: 1 },
      { type: "step", sessionId: sid, step: 2, maxSteps: 8 },
    ]);
    expect(s).toBe(
      [
        "? permission: bash echo hi > b.txt",
        "  permission denied",
        "? Pick one",
        "  1) red",
        "  2) blue",
        "error: rate limited (APIError)",
        "retrying (attempt 2): busy",
        "[step 2/8]",
        "",
      ].join("\n"),
    );
  });

  it("renders multi-question requests", () => {
    const s = render([{ type: "question", sessionId: sid, questionId: "q", text: "", questions: [{ question: "A?", options: ["x"] }, { question: "B?", options: [] }] }]);
    expect(s).toBe("? A?\n  1) x\n? B?\n");
  });

  it("accumulates usage and prints a usage/cost line at end of turn", () => {
    const u = { sessionId: sid, messageId: "m", inputTokens: 1000, outputTokens: 50, reasoningTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0012 };
    const s = render([{ type: "text.delta", sessionId: sid, text: "ok" }, { type: "usage", ...u }, { type: "usage", ...u }], undefined, true);
    expect(s).toBe("ok\ntokens 2,000 in / 100 out (14 reasoning) | cost $0.0024\n");
  });

  it("redacts secrets in tool input and errors", () => {
    const key = "sk-or-v1-" + "b".repeat(40);
    const s = render([
      { type: "tool.start", sessionId: sid, callId: "c", name: "bash", input: { command: `curl -H 'Authorization: Bearer ${key}'` } },
      { type: "error", sessionId: sid, message: `bad key ${key}` },
    ]);
    expect(s).not.toContain(key);
    expect(s).toContain("[REDACTED]");
  });

  it("ignores unknown event types", () => {
    expect(render([{ type: "future.thing", sessionId: sid } as unknown as AiEvent])).toBe("");
  });
});

describe("helpers", () => {
  it("formatUsage", () => {
    expect(formatUsage({ inputTokens: 5, outputTokens: 6, costUsd: 0 })).toBe("tokens 5 in / 6 out | cost $0.00");
    expect(formatUsage({ inputTokens: 5, outputTokens: 6, costUsd: 1.5, cacheReadTokens: 3 })).toBe("tokens 5 in / 6 out, 3 cached | cost $1.50");
  });
  it("summarize truncates", () => {
    expect(summarize("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(summarize({})).toBe("");
    expect(summarize({ a: 1 })).toBe('{"a":1}');
  });
});
