import { describe, expect, it } from "vitest";
import { buildOpenCodeConfig } from "../../src/presets/index.js";
import { DEFAULT_SETTINGS, type OpenCodeConfigInput, type Settings } from "../../src/core/types.js";

const input = (s: Partial<Settings> = {}, avail: Partial<OpenCodeConfigInput["available"]> = {}): OpenCodeConfigInput => ({
  settings: { ...DEFAULT_SETTINGS, ...s },
  available: { openrouter: true, google: false, github: false, secrets: false, ...avail },
  secretsMcpEntry: "/abs/dist/mcp/secrets-mcp.js",
  nodePath: "/usr/bin/node",
});
type Cfg = Record<string, any>;

describe("buildOpenCodeConfig", () => {
  it("default openrouter config", () => {
    const c = buildOpenCodeConfig(input()) as Cfg;
    expect(c.$schema).toBe("https://opencode.ai/config.json");
    expect(c.model).toBe("openrouter/openrouter/free");
    expect(c.small_model).toBe("openrouter/openrouter/free");
    expect(c.disabled_providers).toEqual(["github-copilot"]);
    expect(c.provider.openrouter.options.headers).toEqual({ "HTTP-Referer": "https://github.com/titan717/secrets", "X-Title": "Secrets" });
    expect(c.permission).toMatchObject({ edit: "ask", bash: "ask", webfetch: "ask", read: "allow", glob: "allow", grep: "allow", list: "allow", question: "allow", external_directory: "ask" });
    expect(c.agent.build.steps).toBe(8);
    expect(c.agent.plan.steps).toBe(8);
    expect(c.agent.plan.permission).toMatchObject({ edit: "deny", bash: "deny" });
    expect(c.mcp).toBeUndefined();
    expect(c.agent.build.prompt).toBeUndefined();
  });
  it("google model + effort + prompt", () => {
    const c = buildOpenCodeConfig(input({ provider: "google", model: "gemini-2.5-pro", effort: { level: "high" }, systemPrompt: "Be brief." }, { google: true })) as Cfg;
    expect(c.model).toBe("google/gemini-2.5-pro");
    expect(c.small_model).toBe("google/gemini-2.5-flash-lite");
    expect(c.provider).toBeUndefined();
    expect(c.agent.build).toMatchObject({ steps: 20, prompt: "Be brief." });
    expect(c.agent.plan.prompt).toBe("Be brief.");
  });
  it("custom effort steps", () => {
    const c = buildOpenCodeConfig(input({ effort: { level: "custom", maxSteps: 50 } })) as Cfg;
    expect(c.agent.build.steps).toBe(50);
  });

  describe("MCP entries", () => {
    const url = "https://api.secrets.example";
    it("github only when enabled AND credentialed", () => {
      expect((buildOpenCodeConfig(input({ tools: { github: true, secrets: false } })) as Cfg).mcp).toBeUndefined();
      expect((buildOpenCodeConfig(input({ tools: { github: false, secrets: false } }, { github: true })) as Cfg).mcp).toBeUndefined();
      const c = buildOpenCodeConfig(input({ tools: { github: true, secrets: false } }, { github: true })) as Cfg;
      expect(c.mcp.github).toEqual({
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer {env:SECRETS_AI_GITHUB_TOKEN}", "X-MCP-Toolsets": "context,repos,issues,pull_requests" },
        enabled: true,
      });
      expect(c.mcp.secrets).toBeUndefined();
      expect(c.permission["github_*"]).toBe("ask");
      expect(c.permission["github_get_*"]).toBe("allow");
      expect(c.permission["github_create_pull_request"]).toBe("ask");
      expect(c.permission["github_push_files"]).toBe("ask");
      expect(c.agent.plan.permission["github_create_branch"]).toBe("deny");
      expect(c.agent.plan.permission["github_list_*"]).toBe("allow");
      // last-match-wins: writes come after the read allows
      const keys = Object.keys(c.permission);
      expect(keys.indexOf("github_create_issue")).toBeGreaterThan(keys.indexOf("github_*_read"));
    });
    it("secrets only when enabled AND credentialed AND api url set", () => {
      expect((buildOpenCodeConfig(input({ tools: { github: false, secrets: true }, secretsApiUrl: url })) as Cfg).mcp).toBeUndefined();
      expect((buildOpenCodeConfig(input({ tools: { github: false, secrets: true } }, { secrets: true })) as Cfg).mcp).toBeUndefined();
      const c = buildOpenCodeConfig(input({ tools: { github: false, secrets: true }, secretsApiUrl: url }, { secrets: true })) as Cfg;
      expect(c.mcp.secrets).toEqual({
        type: "local",
        command: ["/usr/bin/node", "/abs/dist/mcp/secrets-mcp.js"],
        environment: { SECRETS_API_URL: url, SECRETS_TOKEN: "{env:SECRETS_AI_SECRETS_TOKEN}" },
        enabled: true,
      });
      expect(c.permission["secrets_read_conversation"]).toBe("allow");
      expect(c.permission["secrets_draft_message"]).toBe("ask");
    });
  });

  it("never contains secret values", () => {
    const c = buildOpenCodeConfig(input({ tools: { github: true, secrets: true }, secretsApiUrl: "https://x.example" }, { github: true, secrets: true, google: true }));
    const s = JSON.stringify(c);
    expect(s).not.toMatch(/sk-or|AIza|ghp_|github_pat_/);
    expect(s).toContain("{env:SECRETS_AI_GITHUB_TOKEN}");
  });
});
