import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../security/auth.js";
import { githubTools } from "../tools/github.js";
import type { ToolContext } from "../tools/types.js";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = {
  name: "github-mcp",
  version: "0.1.0",
};

const PROTOCOL_VERSION = "2024-11-05";

export async function handleMcpRequest(
  req: JsonRpcRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JsonRpcResponse | null> {
  if (!req || typeof req.method !== "string") {
    return {
      jsonrpc: "2.0",
      id: req?.id ?? null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  if (req.method === "notifications/initialized" || req.method.startsWith("notifications/")) {
    return null;
  }

  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: githubTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        },
      };

    case "tools/call": {
      const name = typeof req.params?.name === "string" ? req.params.name : "";
      const args =
        req.params?.arguments && typeof req.params.arguments === "object"
          ? (req.params.arguments as Record<string, unknown>)
          : {};

      const tool = githubTools.find((t) => t.name === name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        };
      }

      const ctx: ToolContext = {
        githubToken: env.GITHUB_TOKEN,
        signal: AbortSignal.timeout(30_000),
      };

      try {
        const result = await tool.run(args, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err) {
        const message = redactSecrets((err as Error).message, [env.GITHUB_TOKEN]);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    default:
      if (req.id === undefined) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

export function startStdioServer(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errRes: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      process.stdout.write(JSON.stringify(errRes) + "\n");
      return;
    }

    const res = await handleMcpRequest(req, process.env);
    if (res !== null) {
      process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startStdioServer();
}
