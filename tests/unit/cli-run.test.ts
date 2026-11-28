import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";
import type { AiEvent } from "../../src/core/events.js";
import { startFakeBridge, testIo, type FakeBridge, type Step } from "./cli-fake-bridge.js";

const home = () => mkdtempSync(join(tmpdir(), "sai-cli-run-"));

const permScenario = (): Step[] => [
  { event: { type: "text.delta", text: "Running it." } },
  { event: { type: "tool.start", callId: "c1", name: "bash", input: { command: "echo hi > b.txt" } } },
  { event: { type: "permission.request", permissionId: "per_1", action: "bash", detail: { patterns: ["echo hi > b.txt"], metadata: {}, always: ["echo *"] } } },
  { waitPermission: "per_1" },
  { event: { type: "tool.end", callId: "c1", name: "bash", output: null, error: "The user rejected permission to use this specific tool call." } },
  { event: { type: "text.delta", text: " Done." } },
  { event: { type: "usage", messageId: "m", inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 } },
  { event: { type: "session.idle" } },
];

describe("secrets-ai run", () => {
  let fb: FakeBridge;
  afterEach(() => fb?.close());

  const args = (...a: string[]) => ["--url", fb.url, "--token", fb.token, ...a];

  it("--json prints AiEvent NDJSON and exits 0", async () => {
    fb = await startFakeBridge();
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    const code = await main(args("run", "hello", "--json"), io);
    expect(code).toBe(0);
    const evs = io.out().trim().split("\n").map((l) => JSON.parse(l) as AiEvent);
    expect(evs.map((e) => e.type)).toEqual(["text.delta", "session.idle"]);
    expect(evs[0]).toMatchObject({ type: "text.delta", text: "echo: hello", sessionId: "ses_fake1" });
    const post = fb.requests.find((r) => r.path.endsWith("/messages"));
    expect(post?.body).toEqual({ text: "hello" });
    expect(post?.headers.authorization).toBe(`Bearer ${fb.token}`);
  });

  it("plain output: text on stdout, usage on stderr", async () => {
    fb = await startFakeBridge({ scenario: permScenario });
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    const code = await main(args("run", "do", "it", "--yes"), io);
    expect(code).toBe(0);
    expect(io.out()).toBe("Running it. Done.\n");
    expect(io.err()).toContain("> bash echo hi > b.txt");
    expect(io.err()).toContain("auto-allowed (--yes)");
    expect(io.err()).toMatch(/tokens 100 in \/ 10 out \| cost \$0\.0010/);
    expect(fb.permissionReplies).toEqual([{ id: "per_1", decision: "allow" }]);
  });

  it("denies permissions by default when stdin is not a TTY", async () => {
    fb = await startFakeBridge({ scenario: permScenario });
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "x", "--json"), io)).toBe(0);
    expect(fb.permissionReplies).toEqual([{ id: "per_1", decision: "deny" }]);
  });

  it("--deny-all denies even on a TTY", async () => {
    fb = await startFakeBridge({ scenario: permScenario });
    const io = testIo({ tty: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "x", "--deny-all"), io)).toBe(0);
    expect(fb.permissionReplies).toEqual([{ id: "per_1", decision: "deny" }]);
  });

  it("prompts on a TTY and sends the chosen decision", async () => {
    fb = await startFakeBridge({ scenario: permScenario });
    const io = testIo({ tty: true, input: "s\n", env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "x"), io)).toBe(0);
    expect(io.err()).toContain("[a]llow once / [s]ession / [d]eny");
    expect(fb.permissionReplies).toEqual([{ id: "per_1", decision: "allow_session" }]);
  });

  it("rejects questions in non-interactive mode", async () => {
    fb = await startFakeBridge({
      scenario: () => [{ event: { type: "question", questionId: "q1", text: "Which?", options: ["a", "b"] } }, { waitQuestion: "q1" }, { event: { type: "session.idle" } }],
    });
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "x"), io)).toBe(0);
    expect(fb.questionReplies).toEqual([{ id: "q1", body: { reject: true } }]);
  });

  it("exits 1 when the turn reports an error", async () => {
    fb = await startFakeBridge({ scenario: () => [{ event: { type: "error", message: "No API key", code: "ProviderAuthError" } }, { event: { type: "session.idle" } }] });
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "x"), io)).toBe(1);
    expect(io.err()).toContain("error: No API key (ProviderAuthError)");
  });

  it("passes --model / --effort / --session through", async () => {
    fb = await startFakeBridge();
    const io0 = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    await main(args("run", "first", "--json"), io0);
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "x", "--json", "--session", "ses_fake1", "--model", "openai/gpt-5-mini", "--effort", "custom:5:low"), io)).toBe(0);
    const posts = fb.requests.filter((r) => r.path.endsWith("/messages"));
    expect(posts[1]?.path).toBe("/v1/sessions/ses_fake1/messages");
    expect(posts[1]?.body).toEqual({ text: "x", model: "openai/gpt-5-mini", effort: { level: "custom", maxSteps: 5, variant: "low" } });
    expect(fb.requests.filter((r) => r.method === "POST" && r.path === "/v1/sessions")).toHaveLength(1);
  });

  it("reads the prompt from stdin with '-'", async () => {
    fb = await startFakeBridge();
    const io = testIo({ input: "from stdin\n", end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run", "-", "--json"), io)).toBe(0);
    expect(io.out()).toContain("echo: from stdin");
  });

  it("exits 3 with a friendly message when the bridge is not running", async () => {
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(["--url", "http://127.0.0.1:1", "--token", "x", "run", "hi"], io)).toBe(3);
    expect(io.err()).toContain("bridge not running at http://127.0.0.1:1");
    expect(io.err()).toContain("secrets-ai serve");
  });

  it("exits 1 with a token hint on 401, without printing the token", async () => {
    fb = await startFakeBridge();
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    const wrong = "sai_wrongtoken_abcdefghijklmnopqrstuvwxyz";
    expect(await main(["--url", fb.url, "--token", wrong, "run", "hi"], io)).toBe(1);
    expect(io.err()).toContain("unauthorized");
    expect(io.out() + io.err()).not.toContain(wrong);
  });

  it("exits 2 on usage errors", async () => {
    fb = await startFakeBridge();
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(args("run"), io)).toBe(2);
    expect(await main(args("run", "x", "--yes", "--deny-all"), io)).toBe(2);
  });
});
