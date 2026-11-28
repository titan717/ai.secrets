import { readFileSync } from "node:fs";
import type { BridgeHandle, StartBridgeOptions } from "../core/api.js";
import { Bridge, buildApp, type BridgeAppOptions } from "./app.js";

export interface StartBridgeTestOptions {
  /** Test hooks forwarded to every supervisor (configOverride, timeouts, logger, extraEnv...). */
  supervisor?: BridgeAppOptions["supervisor"];
  logger?: BridgeAppOptions["logger"];
  pingMs?: number;
  models?: BridgeAppOptions["models"];
  modelOverride?: BridgeAppOptions["modelOverride"];
  /** Do not start the default workspace's OpenCode eagerly. */
  lazy?: boolean;
}

export interface BridgeHandleExt extends BridgeHandle {
  bridge: Bridge;
}

/**
 * Developer/test hooks for driving the real CLI against a local mock LLM (never set these in production):
 *   SECRETS_AI_TEST_OPENCODE_CONFIG=<file.json>  merged over the generated opencode.json
 *                                                (`provider` and `permission` are merged key by key)
 *   SECRETS_AI_TEST_MODEL=<providerID>/<modelID>  model sent with every prompt (e.g. mock/mock-1)
 */
function envTestHooks(env: NodeJS.ProcessEnv): Pick<BridgeAppOptions, "modelOverride"> & { configOverride?: (cfg: Record<string, unknown>) => Record<string, unknown> } {
  const out: ReturnType<typeof envTestHooks> = {};
  const file = env.SECRETS_AI_TEST_OPENCODE_CONFIG;
  if (file) {
    const extra = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    out.configOverride = (cfg) => {
      const c = cfg as Record<string, any>;
      return {
        ...c,
        ...extra,
        ...(extra.provider ? { provider: { ...(c.provider ?? {}), ...extra.provider } } : {}),
        ...(extra.permission && typeof c.permission === "object" ? { permission: { ...c.permission, ...extra.permission } } : {}),
      };
    };
  }
  const m = env.SECRETS_AI_TEST_MODEL;
  const i = m ? m.indexOf("/") : -1;
  if (m && i > 0) out.modelOverride = { providerID: m.slice(0, i), modelID: m.slice(i + 1) };
  return out;
}

/** Start the bridge HTTP server (default 127.0.0.1:8790) and the default workspace's OpenCode. */
export async function startBridge(opts: StartBridgeOptions & StartBridgeTestOptions = {}): Promise<BridgeHandleExt> {
  const env = opts.env ?? process.env;
  const host = opts.host ?? env.HOST ?? "127.0.0.1";
  const port = opts.port ?? (env.PORT !== undefined && env.PORT !== "" ? Number(env.PORT) : 8790);
  const workspace = opts.workspace ?? env.SECRETS_AI_WORKSPACE ?? process.cwd();
  const testHooks = envTestHooks(env);
  const bridge = new Bridge({
    env,
    workspace,
    opencodeBin: opts.opencodeBin ?? env.OPENCODE_BIN,
    quiet: opts.quiet,
    logger: opts.logger,
    supervisor: testHooks.configOverride && !opts.supervisor?.configOverride ? { ...opts.supervisor, configOverride: testHooks.configOverride } : opts.supervisor,
    pingMs: opts.pingMs,
    models: opts.models,
    modelOverride: opts.modelOverride ?? testHooks.modelOverride,
  });
  const app = await buildApp(bridge);
  await app.listen({ host, port });
  const addr = app.server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  if (!opts.lazy) bridge.runtime();
  let closed = false;
  return {
    url: `http://${urlHost}:${actualPort}`,
    token: bridge.token,
    bridge,
    async close() {
      if (closed) return;
      closed = true;
      await bridge.close();
      await app.close();
    },
  };
}
