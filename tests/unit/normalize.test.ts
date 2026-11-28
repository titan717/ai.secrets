import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AiEvent } from "../../src/core/events.js";
import { Normalizer } from "../../src/opencode/normalize.js";
import type { RawEvent } from "../../src/opencode/client.js";

const TRACES = join(__dirname, "..", "fixtures", "traces");
const load = (n: string): RawEvent[] =>
  readFileSync(join(TRACES, `${n}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const run = (raw: RawEvent[], nz = new Normalizer()) => raw.flatMap((e) => nz.push(e));
const strip = (evs: AiEvent[]) => evs.map(({ sessionId: _s, ...r }) => r);
const ev = (o: Record<string, unknown>) => o;

/** Exact normalized sequences for each REAL recorded OpenCode 1.19.6 trace. */
const EXPECTED: Record<string, Array<Record<string, unknown>>> = {
  text: [
    ev({"type":"status","status":"busy"}),
    ev({"type":"step","step":1}),
    ev({"type":"text.delta","text":"Hello","messageId":"msg_21febf69c001e263Upbr52gG0z","partId":"prt_21febf84c001LH74WgdqL5VLTU"}),
    ev({"type":"text.delta","text":" world","messageId":"msg_21febf69c001e263Upbr52gG0z","partId":"prt_21febf84c001LH74WgdqL5VLTU"}),
    ev({"type":"usage","messageId":"msg_21febf69c001e263Upbr52gG0z","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"status","status":"idle"}),
    ev({"type":"session.idle"}),
  ],
  basic: [
    ev({"type":"status","status":"busy"}),
    ev({"type":"step","step":1}),
    ev({"type":"reasoning.delta","text":"Thinking about reading.","messageId":"msg_21febfa93001ughQVFXXJSvaCD","partId":"prt_21febfaa100147H5qzKmBIRW1L"}),
    ev({"type":"text.delta","text":"Reading file.","messageId":"msg_21febfa93001ughQVFXXJSvaCD","partId":"prt_21febfaa5001T0WdcG61aGViMC"}),
    ev({"type":"tool.start","callId":"call_1","name":"read","input":{"filePath":"/tmp/oc-rec-cZqaDm/a.txt"}}),
    ev({"type":"tool.end","callId":"call_1","name":"read","output":"<path>/tmp/oc-rec-cZqaDm/a.txt</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>"}),
    ev({"type":"usage","messageId":"msg_21febfa93001ughQVFXXJSvaCD","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"step","step":2}),
    ev({"type":"tool.start","callId":"call_2","name":"bash","input":{"command":"echo hi > b.txt","description":"Write b.txt"}}),
    ev({"type":"permission.request","permissionId":"per_21febfaf9001r6fmW25LN0X6Uh","action":"bash","detail":{"patterns":["echo hi > b.txt"],"metadata":{"command":"echo hi > b.txt"},"always":["echo *"],"callId":"call_2"}}),
    ev({"type":"permission.resolved","permissionId":"per_21febfaf9001r6fmW25LN0X6Uh","reply":"once"}),
    ev({"type":"tool.end","callId":"call_2","name":"bash","output":"(no output)"}),
    ev({"type":"usage","messageId":"msg_21febfabe001OPJtwOvHAvmKWS","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"step","step":3}),
    ev({"type":"text.delta","text":"DO","messageId":"msg_21febfb710015GaulUAsX23uHm","partId":"prt_21febfb7f001jcUGW1Il72IvB1"}),
    ev({"type":"text.delta","text":"NE","messageId":"msg_21febfb710015GaulUAsX23uHm","partId":"prt_21febfb7f001jcUGW1Il72IvB1"}),
    ev({"type":"usage","messageId":"msg_21febfb710015GaulUAsX23uHm","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"status","status":"idle"}),
    ev({"type":"session.idle"}),
  ],
  deny: [
    ev({"type":"status","status":"busy"}),
    ev({"type":"step","step":1}),
    ev({"type":"reasoning.delta","text":"Thinking about reading.","messageId":"msg_21febfdd1001nVzrM833AHUGrg","partId":"prt_21febfde2001YvFJoh5qeeUjzR"}),
    ev({"type":"text.delta","text":"Reading file.","messageId":"msg_21febfdd1001nVzrM833AHUGrg","partId":"prt_21febfde6001mO0jopUkrmvvML"}),
    ev({"type":"tool.start","callId":"call_1","name":"read","input":{"filePath":"/tmp/oc-rec-cZqaDm/a.txt"}}),
    ev({"type":"tool.end","callId":"call_1","name":"read","output":"<path>/tmp/oc-rec-cZqaDm/a.txt</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>"}),
    ev({"type":"usage","messageId":"msg_21febfdd1001nVzrM833AHUGrg","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"step","step":2}),
    ev({"type":"permission.request","permissionId":"per_21febfe1800154p0eViGxUq5tj","action":"bash","detail":{"patterns":["echo hi > b.txt"],"metadata":{"command":"echo hi > b.txt"},"always":["echo *"],"callId":"call_2"}}),
    ev({"type":"tool.start","callId":"call_2","name":"bash","input":{"command":"echo hi > b.txt","description":"Write b.txt"}}),
    ev({"type":"permission.resolved","permissionId":"per_21febfe1800154p0eViGxUq5tj","reply":"reject"}),
    ev({"type":"tool.end","callId":"call_2","name":"bash","output":null,"error":"The user rejected permission to use this specific tool call."}),
    ev({"type":"usage","messageId":"msg_21febfdfd001wkUYwlm1oYtahO","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"status","status":"idle"}),
    ev({"type":"session.idle"}),
  ],
  question: [
    ev({"type":"status","status":"busy"}),
    ev({"type":"step","step":1}),
    ev({"type":"question","questionId":"que_21fec011d001bqMJObMn5s34cI","text":"Which color?","options":["Red","Blue"],"questions":[{"question":"Which color?","header":"Color","options":["Red","Blue"]}]}),
    ev({"type":"tool.start","callId":"call_q","name":"question","input":{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool"}]}]}}),
    ev({"type":"tool.end","callId":"call_q","name":"question","output":"User has answered your questions: \"Which color?\"=\"Blue\". You can now continue with the user's answers in mind."}),
    ev({"type":"usage","messageId":"msg_21fec0107001P0x634fKb5yDyC","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"step","step":2}),
    ev({"type":"text.delta","text":"Answer noted: User has answered your questions: \"Which color?\"=\"Blue\". You can now continue with the user's answers in mind.","messageId":"msg_21fec01da001TCuA5qmvZlljE2","partId":"prt_21fec01e7001aBraK1ZQuqi5H0"}),
    ev({"type":"usage","messageId":"msg_21fec01da001TCuA5qmvZlljE2","inputTokens":10,"outputTokens":5,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":0}),
    ev({"type":"status","status":"idle"}),
    ev({"type":"session.idle"}),
  ],
  error: [
    ev({"type":"status","status":"busy"}),
    ev({"type":"error","message":"Invalid API key (mock)","code":"APIError","retryable":false}),
    ev({"type":"status","status":"idle"}),
    ev({"type":"session.idle"}),
  ],
  abort: [
    ev({"type":"status","status":"busy"}),
    ev({"type":"step","step":1}),
    ev({"type":"text.delta","text":"tick0 ","messageId":"msg_21fec06bf001Cpy8ON507sMwRu","partId":"prt_21fec06ce0018P7LsqL0HVFXd4"}),
    ev({"type":"text.delta","text":"tick1 ","messageId":"msg_21fec06bf001Cpy8ON507sMwRu","partId":"prt_21fec06ce0018P7LsqL0HVFXd4"}),
    ev({"type":"text.delta","text":"tick2 ","messageId":"msg_21fec06bf001Cpy8ON507sMwRu","partId":"prt_21fec06ce0018P7LsqL0HVFXd4"}),
    ev({"type":"error","message":"Aborted","code":"MessageAbortedError"}),
    ev({"type":"status","status":"idle"}),
    ev({"type":"session.idle"}),
  ],

};

describe("Normalizer on recorded traces", () => {
  for (const name of Object.keys(EXPECTED)) {
    it(`produces the exact event sequence for ${name}.jsonl`, () => {
      const raw = load(name);
      const sid = raw.find((e) => e.properties?.sessionID)!.properties.sessionID;
      const out = run(raw);
      expect(strip(out)).toEqual(EXPECTED[name]);
      expect(out.every((e) => e.sessionId === sid)).toBe(true);
    });
  }

  it("never forwards responseBody/responseHeaders/url of provider errors", () => {
    const out = run(load("error"));
    const s = JSON.stringify(out);
    expect(s).not.toContain("responseBody");
    expect(s).not.toContain("keep-alive");
    expect(s).not.toContain("chat/completions");
  });

  it("emits exactly one session.idle per turn even though OpenCode repeats it", () => {
    for (const n of ["error", "abort"]) {
      const raw = load(n);
      expect(raw.filter((e) => e.type === "session.idle").length).toBe(2);
      expect(run(raw).filter((e) => e.type === "session.idle").length).toBe(1);
    }
  });

  it("emits usage once per completed assistant message (OpenCode sends message.updated twice)", () => {
    const out = run(load("basic"));
    const ids = out.filter((e) => e.type === "usage").map((e) => (e as any).messageId);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not echo the user's own prompt text", () => {
    for (const n of Object.keys(EXPECTED)) {
      const texts = run(load(n)).filter((e) => e.type === "text.delta").map((e) => (e as any).text).join("");
      expect(texts).not.toContain("scenario:");
    }
  });

  it("handles a second turn in the same connection (state kept per part/message)", () => {
    const nz = new Normalizer();
    const raw = load("text");
    const first = run(raw, nz);
    // Full part/message snapshots with known ids must not re-emit text or usage.
    const again = run(raw.filter((e) => e.type === "message.part.updated" || e.type === "message.updated"), nz);
    expect(first.length).toBeGreaterThan(0);
    expect(again.filter((e) => e.type === "text.delta" || e.type === "usage")).toEqual([]);
  });
});

describe("Normalizer edge cases", () => {
  const S = "ses_x";
  const asst = (id: string, extra: Record<string, unknown> = {}): RawEvent => ({ type: "message.updated", properties: { sessionID: S, info: { id, role: "assistant", sessionID: S, time: { created: 1 }, ...extra } } });
  const part = (p: Record<string, unknown>): RawEvent => ({ type: "message.part.updated", properties: { sessionID: S, part: { sessionID: S, messageID: "m1", ...p } } });

  it("emits the full text when a provider does not stream deltas", () => {
    const out = run([asst("m1"), part({ id: "p1", type: "text", text: "all at once" })]);
    expect(strip(out)).toEqual([{ type: "text.delta", text: "all at once", messageId: "m1", partId: "p1" }]);
  });

  it("emits only the unstreamed suffix when the full part arrives", () => {
    const out = run([
      asst("m1"),
      part({ id: "p1", type: "text", text: "" }),
      { type: "message.part.delta", properties: { sessionID: S, messageID: "m1", partID: "p1", field: "text", delta: "Hel" } },
      part({ id: "p1", type: "text", text: "Hello" }),
      part({ id: "p1", type: "text", text: "Hello" }),
    ]);
    expect(out.map((e) => (e as any).text)).toEqual(["Hel", "lo"]);
  });

  it("routes deltas by the remembered part type (reasoning vs text)", () => {
    const out = run([
      asst("m1"),
      part({ id: "r1", type: "reasoning", text: "" }),
      part({ id: "t1", type: "text", text: "" }),
      { type: "message.part.delta", properties: { sessionID: S, messageID: "m1", partID: "r1", field: "text", delta: "think" } },
      { type: "message.part.delta", properties: { sessionID: S, messageID: "m1", partID: "t1", field: "text", delta: "say" } },
    ]);
    expect(out.map((e) => e.type)).toEqual(["reasoning.delta", "text.delta"]);
  });

  it("ignores parts of user messages", () => {
    const out = run([
      { type: "message.updated", properties: { sessionID: S, info: { id: "u1", role: "user", sessionID: S } } },
      { type: "message.part.updated", properties: { sessionID: S, part: { id: "p", sessionID: S, messageID: "u1", type: "text", text: "my prompt" } } },
    ]);
    expect(out).toEqual([]);
  });

  it("filters by session", () => {
    const nz = new Normalizer({ sessionFilter: (id) => id === "keep" });
    const raw = load("text");
    expect(raw.flatMap((e) => nz.push(e))).toEqual([]);
  });

  it("emits tool.start once and tool.end with the error string", () => {
    const tool = (state: Record<string, unknown>) => part({ id: "t", type: "tool", tool: "bash", callID: "c1", state });
    const out = run([asst("m1"), tool({ status: "pending", input: {} }), tool({ status: "running", input: { command: "ls" } }), tool({ status: "running", input: { command: "ls" }, metadata: { output: "" } }), tool({ status: "error", input: { command: "ls" }, error: "nope" }), tool({ status: "error", error: "nope" })]);
    expect(strip(out)).toEqual([
      { type: "tool.start", callId: "c1", name: "bash", input: { command: "ls" } },
      { type: "tool.end", callId: "c1", name: "bash", output: null, error: "nope" },
    ]);
  });

  it("maps retry status and redacts secrets in error messages", () => {
    const out = run([
      { type: "session.status", properties: { sessionID: S, status: { type: "retry", attempt: 2, message: "Free usage exceeded", next: 123 } } },
      { type: "session.error", properties: { sessionID: S, error: { name: "ProviderAuthError", data: { message: "bad key sk-or-v1-abcdefghijklmnop", responseBody: "secret body" } } } },
    ]);
    expect(strip(out)).toEqual([
      { type: "status", status: "retry", message: "Free usage exceeded", attempt: 2, nextAt: 123 },
      { type: "error", message: "bad key [REDACTED]", code: "ProviderAuthError" },
    ]);
  });

  it("attaches maxSteps to step events when known", () => {
    const nz = new Normalizer({ maxSteps: () => 8 });
    const out = [asst("m1"), part({ id: "s", type: "step-start" })].flatMap((e) => nz.push(e));
    expect(strip(out)).toEqual([{ type: "step", step: 1, maxSteps: 8 }]);
  });
});
