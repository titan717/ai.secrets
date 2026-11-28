import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeSettings } from "../events.js";
import { formatOpenCodeModel, mapEffort, type OpenCodeEffortTier } from "../presets/effort.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SECRETS_MCP_PATH = resolve(__dirname, "../../dist/mcp/secrets.js");
const DEFAULT_GITHUB_MCP_PATH = resolve(__dirname, "../../dist/mcp/github.js");

export interface OpenCodePermissionRule {
  action: "read" | "edit" | "bash";
  resource: string;
  effect: "allow" | "ask" | "deny";
}

export interface OpenCodeMcpServer {
  type: "local";
  command: string[];
  enabled: boolean;
}

export interface OpenCodeConfig {
  $schema: string;
  model: string;
  autoupdate: boolean;
  provider: {
    openrouter: {
      apiKey: string;
      models: Record<
        string,
        {
          options: {
            reasoningEffort: OpenCodeEffortTier;
            thinking?: {
              type: "enabled" | "disabled";
              budgetTokens: number;
            };
          };
        }
      >;
    };
    google: {
      apiKey: string;
    };
  };
  permissions: OpenCodePermissionRule[];
  mcp: {
    servers: Record<string, OpenCodeMcpServer>;
  };
  agent: {
    build: {
      model: string;
      reasoningEffort: OpenCodeEffortTier;
      maxSteps: number;
    };
  };
}

export interface GenerateOpenCodeConfigOptions {
  settings: BridgeSettings;
  secretsMcpPath?: string;
  githubMcpPath?: string;
}

/**
 * Generates an `opencode.json` configuration object from BridgeSettings.
 */
export function generateOpenCodeConfig(options: GenerateOpenCodeConfigOptions): OpenCodeConfig {
  const {
    settings,
    secretsMcpPath = DEFAULT_SECRETS_MCP_PATH,
    githubMcpPath = DEFAULT_GITHUB_MCP_PATH,
  } = options;

  const model = formatOpenCodeModel(settings.provider, settings.model);
  const { maxSteps, reasoningEffort, thinkingBudget } = mapEffort(settings.effort);

  const permissions: OpenCodePermissionRule[] = settings.autoApprove
    ? [
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "allow" },
      ]
    : [
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "ask" },
        { action: "bash", resource: "*", effect: "ask" },
      ];

  const servers: Record<string, OpenCodeMcpServer> = {};
  if (settings.tools.secrets) {
    servers.secrets = {
      type: "local",
      command: ["node", secretsMcpPath],
      enabled: true,
    };
  }
  if (settings.tools.github) {
    servers.github = {
      type: "local",
      command: ["node", githubMcpPath],
      enabled: true,
    };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    model,
    autoupdate: false,
    provider: {
      openrouter: {
        apiKey: "{env:OPENROUTER_API_KEY}",
        models: {
          [model]: {
            options: {
              reasoningEffort,
              ...(thinkingBudget !== undefined
                ? {
                    thinking: {
                      type: thinkingBudget > 0 ? "enabled" : "disabled",
                      budgetTokens: thinkingBudget,
                    },
                  }
                : {}),
            },
          },
        },
      },
      google: {
        apiKey: "{env:GEMINI_API_KEY}",
      },
    },
    permissions,
    mcp: {
      servers,
    },
    agent: {
      build: {
        model,
        reasoningEffort,
        maxSteps,
      },
    },
  };
}

/**
 * Writes `opencode.json` into `workspaceDir`, creating the directory if needed.
 */
export function writeOpenCodeConfig(workspaceDir: string, config: OpenCodeConfig): string {
  mkdirSync(workspaceDir, { recursive: true });
  const filePath = join(workspaceDir, "opencode.json");
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return filePath;
}
