import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LineReader } from "../../src/cli/io.js";
import { askPermission, askQuestion, parsePermissionAnswer, parseQuestionAnswer } from "../../src/cli/prompts.js";
import type { AiEvent } from "../../src/core/events.js";

const perm: Extract<AiEvent, { type: "permission.request" }> = {
  type: "permission.request",
  sessionId: "s",
  permissionId: "per_1",
  action: "bash",
  detail: { patterns: ["rm x"], metadata: {}, always: [] },
};

function reader(input: string, end = true) {
  const stdin = new PassThrough();
  const out = new PassThrough();
  let printed = "";
  out.on("data", (c: Buffer) => (printed += c.toString()));
  stdin.write(input);
  if (end) stdin.end();
  return { lines: new LineReader(stdin, out), printed: () => printed, stdin };
}

describe("permission prompt", () => {
  it("parses answers", () => {
    expect(parsePermissionAnswer("a")).toBe("allow");
    expect(parsePermissionAnswer(" S ")).toBe("allow_session");
    expect(parsePermissionAnswer("deny")).toBe("deny");
    expect(parsePermissionAnswer("maybe")).toBeNull();
  });

  it("re-asks on invalid input, then accepts", async () => {
    const r = reader("what\ns\n");
    expect(await askPermission(r.lines, perm)).toBe("allow_session");
    expect(r.printed().match(/\[a\]llow once \/ \[s\]ession \/ \[d\]eny/g)).toHaveLength(2);
  });

  it("denies on EOF", async () => {
    expect(await askPermission(reader("").lines, perm)).toBe("deny");
  });

  it("does not lose lines typed before the prompt", async () => {
    const r = reader("a\nd\n");
    await new Promise((res) => setTimeout(res, 10));
    expect(await askPermission(r.lines, perm)).toBe("allow");
    expect(await askPermission(r.lines, perm)).toBe("deny");
  });
});

describe("question prompt", () => {
  it("parses numbers, multi-select and free text", () => {
    expect(parseQuestionAnswer("2", ["a", "b"])).toEqual(["b"]);
    expect(parseQuestionAnswer("1,2,1", ["a", "b"], true)).toEqual(["a", "b"]);
    expect(parseQuestionAnswer("1,2", ["a", "b"], false)).toEqual(["a"]);
    expect(parseQuestionAnswer("9", ["a", "b"])).toEqual(["9"]);
    expect(parseQuestionAnswer("green please", ["a"])).toEqual(["green please"]);
    expect(parseQuestionAnswer("  ", ["a"])).toBeNull();
  });

  it("answers every question in a multi-question request", async () => {
    const r = reader("2\nmy text\n");
    const ev: Extract<AiEvent, { type: "question" }> = {
      type: "question",
      sessionId: "s",
      questionId: "q",
      text: "x",
      questions: [
        { question: "color?", options: ["red", "blue"] },
        { question: "why?", options: [] },
      ],
    };
    expect(await askQuestion(r.lines, ev)).toEqual({ answers: [["blue"], ["my text"]] });
  });

  it("empty answer or EOF dismisses", async () => {
    const ev: Extract<AiEvent, { type: "question" }> = { type: "question", sessionId: "s", questionId: "q", text: "x?", options: ["a"] };
    expect(await askQuestion(reader("\n").lines, ev)).toEqual({ reject: true });
    expect(await askQuestion(reader("").lines, ev)).toEqual({ reject: true });
  });
});
