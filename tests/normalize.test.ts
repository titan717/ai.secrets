import { describe, expect, it } from "vitest";
import { normalizeOpenCodeEvent } from "../src/bridge/normalize.js";

describe("normalizeOpenCodeEvent", () => {
  const sid = "ses_123";

  it("maps text and reasoning deltas", () => {
    expect(
      normalizeOpenCodeEvent({ type: "message.part.delta", properties: { sessionID: sid, part: { type: "text", delta: "hi" } } }, sid),
    ).toEqual({ type: "text.delta", sessionId: sid, text: "hi" });

    expect(
      normalizeOpenCodeEvent(
        { type: "message.part.delta", properties: { sessionID: sid, part: { type: "reasoning", delta: "hmm" } } },
        sid,
      ),
    ).toEqual({ type: "reasoning.delta", sessionId: sid, text: "hmm" });
  });

  it("maps tool.start and tool.end", () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: "part.updated",
          properties: { sessionID: sid, part: { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { cmd: "ls" } } } },
        },
        sid,
      ),
    ).toEqual({ type: "tool.start", sessionId: sid, callId: "c1", name: "bash", input: { cmd: "ls" } });

    expect(
      normalizeOpenCodeEvent(
        {
          type: "part.updated",
          properties: { sessionID: sid, part: { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", output: "ok" } } },
        },
        sid,
      ),
    ).toEqual({ type: "tool.end", sessionId: sid, callId: "c1", output: "ok" });
  });

  it("maps permission.asked, question.asked, session.idle, error, and usage", () => {
    expect(
      normalizeOpenCodeEvent(
        { type: "permission.asked", properties: { sessionID: sid, id: "p1", permission: "edit", patterns: ["a.ts"] } },
        sid,
      ),
    ).toEqual({
      type: "permission.request",
      sessionId: sid,
      permissionId: "p1",
      action: "edit",
      detail: ["a.ts"],
    });

    expect(
      normalizeOpenCodeEvent(
        { type: "question.asked", properties: { sessionID: sid, id: "q1", text: "Continue?", options: ["Yes", "No"] } },
        sid,
      ),
    ).toEqual({ type: "question", sessionId: sid, questionId: "q1", text: "Continue?", options: ["Yes", "No"] });

    expect(normalizeOpenCodeEvent({ type: "session.idle", properties: { sessionID: sid } }, sid)).toEqual({
      type: "session.idle",
      sessionId: sid,
    });

    expect(normalizeOpenCodeEvent({ type: "session.error", properties: { sessionID: sid, error: { message: "boom" } } }, sid)).toEqual({
      type: "error",
      sessionId: sid,
      message: "boom",
    });

    expect(
      normalizeOpenCodeEvent(
        { type: "message.updated", properties: { sessionID: sid, info: { tokens: { input: 10, output: 5 }, cost: 0.01 } } },
        sid,
      ),
    ).toEqual({ type: "usage", sessionId: sid, inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  it("ignores heartbeat and server.connected", () => {
    expect(normalizeOpenCodeEvent({ type: "server.connected" }, sid)).toBeNull();
    expect(normalizeOpenCodeEvent({ type: "server.heartbeat" }, sid)).toBeNull();
  });
});
