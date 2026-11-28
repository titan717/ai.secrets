import { describe, expect, it } from "vitest";
import { parseCli, parseEffort, parseSettingsAssignments, SECRET_ARGV_MESSAGE, UsageError } from "../../src/cli/args.js";

describe("parseCli", () => {
  it("parses command, positionals and flags", () => {
    const p = parseCli(["run", "hello", "world", "--json", "-y", "--session", "ses_1"], {});
    expect(p.command).toBe("run");
    expect(p.positionals).toEqual(["hello", "world"]);
    expect(p.flags).toMatchObject({ json: true, yes: true, session: "ses_1" });
    expect(p.global.url).toBe("http://127.0.0.1:8790");
  });

  it("uses SECRETS_AI_URL / SECRETS_AI_TOKEN, and flags win", () => {
    const env = { SECRETS_AI_URL: "http://10.0.0.1:1", SECRETS_AI_TOKEN: "t_env" };
    expect(parseCli(["status"], env).global).toMatchObject({ url: "http://10.0.0.1:1", token: "t_env" });
    expect(parseCli(["status", "--url", "http://h:2", "--token", "t_flag"], env).global).toMatchObject({ url: "http://h:2", token: "t_flag" });
  });

  it("defaults to help, handles --version and --no-color", () => {
    expect(parseCli([], {}).command).toBe("help");
    expect(parseCli(["--version"], {}).command).toBe("version");
    expect(parseCli(["models", "--no-color"], {}).global.noColor).toBe(true);
  });

  it("rejects unknown commands/options, options for the wrong command and missing values", () => {
    expect(() => parseCli(["frobnicate"], {})).toThrow(UsageError);
    expect(() => parseCli(["run", "x", "--wat"], {})).toThrow(/unknown option --wat/);
    expect(() => parseCli(["models", "--yes"], {})).toThrow(/not valid for 'models'/);
    expect(() => parseCli(["run", "x", "--session"], {})).toThrow(/requires a value/);
    expect(() => parseCli(["status", "--url", "ftp://x"], {})).toThrow(/http/);
  });

  it("never accepts keys via argv and never echoes them", () => {
    const secret = "sk-or-v1-" + "a".repeat(64);
    for (const argv of [
      ["init", "--key", secret],
      ["init", `--api-key=${secret}`],
      ["auth", "set", "openrouter", `--openrouter-key=${secret}`],
      ["run", "x", "--github-token", secret],
      ["init", "--password", secret],
    ]) {
      let err: Error | undefined;
      try {
        parseCli(argv, {});
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(UsageError);
      expect(err!.message).toBe(SECRET_ARGV_MESSAGE);
      expect(err!.message).not.toContain(secret);
    }
    // --key-stdin is the sanctioned way
    expect(parseCli(["init", "--key-stdin"], {}).flags["key-stdin"]).toBe(true);
  });

  it("does not echo values of unknown --opt=value", () => {
    try {
      parseCli(["run", "x", "--weird=supersecretvalue"], {});
    } catch (e) {
      expect((e as Error).message).not.toContain("supersecretvalue");
    }
  });
});

describe("parseEffort", () => {
  it("parses levels and custom", () => {
    expect(parseEffort("low")).toEqual({ level: "low" });
    expect(parseEffort("high")).toEqual({ level: "high" });
    expect(parseEffort("custom:12")).toEqual({ level: "custom", maxSteps: 12 });
    expect(parseEffort("custom:30:xhigh")).toEqual({ level: "custom", maxSteps: 30, variant: "xhigh" });
  });
  it("rejects bad values", () => {
    for (const bad of ["max", "custom", "custom:0", "custom:201", "custom:abc", "low:3"]) expect(() => parseEffort(bad)).toThrow(UsageError);
  });
});

describe("parseSettingsAssignments", () => {
  it("parses every supported key", () => {
    const { patch, tools } = parseSettingsAssignments([
      "provider=google",
      "model=gemini-2.5-flash",
      "effort=custom:12:high",
      "agentMode=plan",
      "tools.github=true",
      "tools.secrets=off",
      "systemPrompt=Be brief. a=b",
      "secretsApiUrl=https://api.example.com",
    ]);
    expect(patch).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      effort: { level: "custom", maxSteps: 12, variant: "high" },
      agentMode: "plan",
      systemPrompt: "Be brief. a=b",
      secretsApiUrl: "https://api.example.com",
    });
    expect(tools).toEqual({ github: true, secrets: false });
  });
  it("empty systemPrompt / secretsApiUrl clear the value", () => {
    expect(parseSettingsAssignments(["systemPrompt=", "secretsApiUrl="]).patch).toEqual({ systemPrompt: null, secretsApiUrl: null });
  });
  it("validates", () => {
    expect(() => parseSettingsAssignments([])).toThrow(UsageError);
    expect(() => parseSettingsAssignments(["nokey"])).toThrow(/key=value/);
    expect(() => parseSettingsAssignments(["colour=red"])).toThrow(/unknown setting/);
    expect(() => parseSettingsAssignments(["agentMode=yolo"])).toThrow(/build\|plan/);
    expect(() => parseSettingsAssignments(["tools.github=maybe"])).toThrow(/true or false/);
    expect(() => parseSettingsAssignments(["secretsApiUrl=ftp://x"])).toThrow(/http/);
    expect(() => parseSettingsAssignments(["effort=extreme"])).toThrow(UsageError);
  });
});
