import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";
import { Chat } from "../../src/cli/commands/chat.js";
import { detectPlatform } from "../../src/cli/commands/doctor.js";
import { BridgeMissingError, isLoopback, loadStartBridge, serve } from "../../src/cli/commands/serve.js";
import { parseCli } from "../../src/cli/args.js";
import { BridgeClient } from "../../src/cli/client.js";
import { makeCtx } from "../../src/cli/context.js";
import { LineReader } from "../../src/cli/io.js";
import { Renderer } from "../../src/cli/render.js";
import { readAuthFile } from "../../src/core/auth.js";
import { paths } from "../../src/core/paths.js";
import { startFakeBridge, testIo, type FakeBridge } from "./cli-fake-bridge.js";

const home = () => mkdtempSync(join(tmpdir(), "sai-cli-"));
const KEY = "sk-or-v1-" + "c".repeat(64);
const posix = process.platform !== "win32";

describe("init / auth (local)", () => {
  it("init creates a 0600 token, reads the key from stdin and never prints it", async () => {
    const h = home();
    const io = testIo({ input: KEY + "\n", end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["init", "--provider", "openrouter", "--model", "openai/gpt-5-mini", "--key-stdin"], io)).toBe(0);
    const auth = readAuthFile({ SECRETS_AI_HOME: h });
    expect(auth?.token).toMatch(/^sai_/);
    expect(auth?.secrets.openrouterApiKey).toBe(KEY);
    if (posix) expect(statSync(paths.authFile({ SECRETS_AI_HOME: h })).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths.settingsFile({ SECRETS_AI_HOME: h }), "utf8"))).toMatchObject({ provider: "openrouter", model: "openai/gpt-5-mini" });
    expect(io.out() + io.err()).not.toContain(KEY);
    expect(io.out() + io.err()).not.toContain(auth!.token);
    expect(io.out()).toContain("secrets-ai serve");
  });

  it("init refuses a key given as an argument", async () => {
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(["init", KEY], io)).toBe(2);
    expect(await main(["init", "--key", KEY], io)).toBe(2);
    expect(io.out() + io.err()).not.toContain(KEY);
    expect(io.err()).toContain("never accepted as command-line arguments");
  });

  it("auth set reads stdin, falls back to the local file when the bridge is down, never echoes", async () => {
    const h = home();
    const io = testIo({ input: "ghp_" + "x".repeat(36) + "\n", end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["--url", "http://127.0.0.1:1", "auth", "set", "github"], io)).toBe(0);
    expect(readAuthFile({ SECRETS_AI_HOME: h })?.secrets.githubToken).toBe("ghp_" + "x".repeat(36));
    expect(io.out()).toContain("GitHub token saved");
    expect(io.out() + io.err()).not.toContain("ghp_");
    const io2 = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["auth", "set", "github", "ghp_" + "y".repeat(36)], io2)).toBe(2);
    expect(io2.out() + io2.err()).not.toContain("ghp_");
  });

  it("auth token refuses to print to a non-TTY unless --show", async () => {
    const h = home();
    await main(["init"], testIo({ end: true, env: { SECRETS_AI_HOME: h } }));
    const tok = readAuthFile({ SECRETS_AI_HOME: h })!.token;
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["auth", "token"], io)).toBe(2);
    expect(io.out() + io.err()).not.toContain(tok);
    const io2 = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["auth", "token", "--show"], io2)).toBe(0);
    expect(io2.out().trim()).toBe(tok);
    const io3 = testIo({ end: true, stdoutTty: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["auth", "token"], io3)).toBe(0);
    expect(io3.out().trim()).toBe(tok);
  });

  it("auth rotate replaces the token and keeps secrets; auth status shows booleans only", async () => {
    const h = home();
    await main(["init", "--key-stdin"], testIo({ input: KEY, end: true, env: { SECRETS_AI_HOME: h } }));
    const before = readAuthFile({ SECRETS_AI_HOME: h })!;
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["auth", "rotate"], io)).toBe(0);
    const after = readAuthFile({ SECRETS_AI_HOME: h })!;
    expect(after.token).not.toBe(before.token);
    expect(after.secrets).toEqual(before.secrets);
    expect(io.out()).not.toContain(after.token);
    const st = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["--url", "http://127.0.0.1:1", "auth", "status"], st)).toBe(0);
    expect(st.out()).toMatch(/openrouter\s+configured/);
    expect(st.out()).toMatch(/github\s+not set/);
    expect(st.out()).not.toContain(KEY);
  });
});

describe("against the fake bridge", () => {
  let fb: FakeBridge;
  afterEach(() => fb?.close());
  const g = (...a: string[]) => ["--url", fb.url, "--token", fb.token, ...a];

  it("auth set PUTs the secret to the bridge when it is running", async () => {
    fb = await startFakeBridge();
    const io = testIo({ input: KEY, end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(g("auth", "set", "openrouter"), io)).toBe(0);
    const put = fb.requests.find((r) => r.path === "/v1/secrets");
    expect(put?.body).toEqual({ openrouterApiKey: KEY });
    expect(io.out() + io.err()).not.toContain(KEY);
  });

  it("models prints a table and filters with --free-tools", async () => {
    fb = await startFakeBridge({
      models: [
        { id: "openrouter/free", name: "Free", provider: "openrouter", toolCall: true, reasoning: false, free: true, contextLength: 128000 },
        { id: "openai/gpt-5-mini", name: "GPT-5 mini", provider: "openrouter", toolCall: true, reasoning: true, free: false, variants: ["low", "high"] },
      ],
    });
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(g("models"), io)).toBe(0);
    const lines = io.out().split("\n");
    expect(lines[0]).toMatch(/^ID\s+PROVIDER\s+TOOLS\s+REASONING\s+FREE\s+CONTEXT\s+VARIANTS$/);
    expect(lines[1]).toMatch(/^openrouter\/free\s+openrouter\s+yes\s+-\s+yes\s+128k\s+-$/);
    expect(lines[2]).toMatch(/^openai\/gpt-5-mini .* low,high$/);
    const io2 = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(g("models", "--free-tools", "--json"), io2)).toBe(0);
    expect(JSON.parse(io2.out())).toHaveLength(1);
    expect(fb.requests.at(-1)?.path).toBe("/v1/models?free_tools=1");
  });

  it("settings set merges tool toggles and PUTs a validated patch", async () => {
    fb = await startFakeBridge();
    fb.settings.tools = { github: false, secrets: true };
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(g("settings", "set", "tools.github=true", "effort=high", "systemPrompt="), io)).toBe(0);
    const put = fb.requests.find((r) => r.method === "PUT" && r.path === "/v1/settings");
    expect(put?.body).toEqual({ tools: { github: true, secrets: true }, effort: { level: "high" }, systemPrompt: null });
    expect(io.out()).toMatch(/effort\s+high/);
    const io2 = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(g("settings", "get", "--json"), io2)).toBe(0);
    expect(JSON.parse(io2.out()).tools).toEqual({ github: true, secrets: true });
  });

  it("settings set writes locally when the bridge is down", async () => {
    const h = home();
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["--url", "http://127.0.0.1:1", "settings", "set", "provider=google", "model=gemini-2.5-flash", "agentMode=plan"], io)).toBe(0);
    expect(io.out()).toContain("bridge not running; saved to");
    expect(JSON.parse(readFileSync(paths.settingsFile({ SECRETS_AI_HOME: h }), "utf8"))).toMatchObject({ provider: "google", model: "gemini-2.5-flash", agentMode: "plan" });
  });

  it("doctor reports bridge, token, opencode, node, platform and config perms", async () => {
    fb = await startFakeBridge();
    const h = home();
    await main(["init"], testIo({ end: true, env: { SECRETS_AI_HOME: h } }));
    const fake = join(h, posix ? "opencode" : "opencode.cmd");
    if (posix) {
      writeFileSync(fake, "#!/bin/sh\necho 1.19.6\n");
      chmodSync(fake, 0o755);
    } else writeFileSync(fake, "@echo 1.19.6\r\n");
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(g("doctor", "--opencode-bin", fake), io)).toBe(0);
    const out = io.out();
    expect(out).toMatch(/^ok\s+node\s+v\d+/m);
    expect(out).toMatch(/^ok\s+platform\s+/m);
    expect(out).toMatch(/^ok\s+opencode\s+.*1\.19\.6/m);
    expect(out).toMatch(/^ok\s+bridge\s+.*v0\.0\.0-fake; opencode running 1\.19\.6/m);
    expect(out).toMatch(/^ok\s+token\s+accepted \(from --token\)/m);
    if (posix) expect(out).toMatch(/^ok\s+config dir\s+.*mode 700/m);
    expect(out).not.toContain(fb.token);

    const bad = testIo({ end: true, env: { SECRETS_AI_HOME: h } });
    expect(await main(["--url", fb.url, "--token", "nope", "status", "--json", "--opencode-bin", join(h, "missing-bin")], bad)).toBe(1);
    const checks = JSON.parse(bad.out()).checks as Array<{ name: string; status: string }>;
    expect(checks.find((c) => c.name === "token")?.status).toBe("fail");
    expect(checks.find((c) => c.name === "opencode")?.status).toBe("warn");
  });

  it("doctor fails clearly when the bridge is down", async () => {
    const io = testIo({ end: true, env: { SECRETS_AI_HOME: home() } });
    expect(await main(["--url", "http://127.0.0.1:1", "doctor", "--opencode-bin", "definitely-not-opencode-xyz"], io)).toBe(1);
    expect(io.out()).toMatch(/FAIL\s+bridge\s+not reachable at http:\/\/127\.0\.0\.1:1 \(start it with `secrets-ai serve`\)/);
    expect(io.out()).toMatch(/FAIL\s+token\s+no token/);
  });

  it("chat REPL: streams, handles slash commands, permission prompt and Ctrl+C abort", async () => {
    let n = 0;
    fb = await startFakeBridge({
      scenario: (text) => {
        n++;
        if (text === "slow")
          return [{ event: { type: "text.delta", text: "working" } }, { waitPermission: "never" }];
        if (text === "tool")
          return [
            { event: { type: "permission.request", permissionId: "per_9", action: "edit", detail: { patterns: ["a.txt"], metadata: {}, always: [] } } },
            { waitPermission: "per_9" },
            { event: { type: "text.delta", text: "edited" } },
            { event: { type: "session.idle" } },
          ];
        return [{ event: { type: "text.delta", text: `reply ${n}` } }, { event: { type: "session.idle" } }];
      },
    });
    const io = testIo({ env: { SECRETS_AI_HOME: home() } });
    const ctx = makeCtx(io, parseCli(g("chat", "--model", "m1"), io.env));
    const lines = new LineReader(io.stdin, io.stdout);
    const chat = new Chat(ctx, new BridgeClient({ url: fb.url, token: fb.token }), lines, new Renderer(io.stdout, { color: false, showReasoning: false }));
    expect(await chat.handle("hello")).toBe(true);
    expect(io.out()).toContain("reply 1");
    expect(io.out()).toMatch(/tokens 0 in \/ 0 out/);
    expect(fb.requests.find((r) => r.path.endsWith("/messages"))?.body).toEqual({ text: "hello", model: "m1" });

    await chat.handle("/effort custom:4");
    await chat.handle("/model other");
    expect(io.out()).toContain("effort: custom:4");
    io.type("a");
    await chat.handle("tool");
    expect(fb.permissionReplies).toEqual([{ id: "per_9", decision: "allow" }]);
    expect(fb.requests.filter((r) => r.path.endsWith("/messages")).at(-1)?.body).toEqual({ text: "tool", model: "other", effort: { level: "custom", maxSteps: 4 } });

    await chat.handle("/sessions");
    expect(io.out()).toMatch(/\* ses_fake1/);
    await chat.handle("/usage");
    expect(io.out()).toContain("tokens 10 in / 20 out | cost $0.0012");

    const p = chat.handle("slow");
    await new Promise((r) => setTimeout(r, 100));
    chat.interrupt();
    await p;
    expect(fb.aborts).toEqual(["ses_fake1"]);
    expect(io.out()).toContain("turn aborted");
    expect(chat.exitRequested).toBe(false);

    await chat.handle("/new");
    await chat.handle("again");
    expect(chat.sessionId).toBe("ses_fake2");
    await chat.handle("/bogus");
    expect(io.out()).toContain("unknown command /bogus");
    expect(await chat.handle("/exit")).toBe(false);
    chat.interrupt();
    expect(chat.exitRequested).toBe(true);
  });
});

describe("serve", () => {
  it("detects loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopback(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.2", "example.com"]) expect(isLoopback(h)).toBe(false);
  });

  it("starts the bridge, warns loudly on non-loopback, never prints the token and closes on signal", async () => {
    const h = home();
    const io = testIo({ env: { SECRETS_AI_HOME: h } });
    const ctx = makeCtx(io, parseCli(["serve", "--host", "0.0.0.0", "--port", "0"], io.env));
    let closed = false;
    let got: unknown;
    const code = await serve(ctx, {
      startBridge: async (o) => {
        got = o;
        return { url: "http://0.0.0.0:1234", token: "sai_should_never_be_printed_xxxxxxxx", close: async () => void (closed = true) };
      },
      waitForSignal: async () => "SIGTERM",
    });
    expect(code).toBe(0);
    expect(got).toMatchObject({ host: "0.0.0.0", port: 0 });
    expect(closed).toBe(true);
    expect(io.err()).toContain("NOT loopback");
    expect(io.out()).toContain("listening on http://0.0.0.0:1234");
    expect(io.out() + io.err()).not.toContain("sai_should_never_be_printed");
    expect(readAuthFile({ SECRETS_AI_HOME: h })?.token).toMatch(/^sai_/);
  });

  it("loads startBridge at runtime or explains clearly that it is missing", async () => {
    try {
      expect(typeof (await loadStartBridge())).toBe("function");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeMissingError);
      expect((err as Error).message).toContain("bridge server module");
    }
  });
});

describe("misc", () => {
  it("detects Termux via $PREFIX", () => {
    expect(detectPlatform({ PREFIX: "/data/data/com.termux/files/usr" }, "linux", "arm64")).toBe("termux (android arm64)");
    expect(detectPlatform({}, "win32", "x64")).toBe("windows x64");
    expect(detectPlatform({}, "darwin", "arm64")).toBe("macos arm64");
  });

  it("--help and --version", async () => {
    const io = testIo({ end: true });
    expect(await main(["--help"], io)).toBe(0);
    expect(io.out()).toContain("Usage: secrets-ai <command>");
    const v = testIo({ end: true });
    expect(await main(["--version"], v)).toBe(0);
    expect(v.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
