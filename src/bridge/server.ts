import type { BridgeHandle, StartBridgeOptions } from "../core/api.js";
import { Bridge, buildApp, type BridgeAppOptions } from "./app.js";

export interface StartBridgeTestOptions {
  /** Test hooks forwarded to every supervisor (configOverride, timeouts, logger, extraEnv...). */
  supervisor?: BridgeAppOptions["supervisor"];
  logger?: BridgeAppOptions["logger"];
  pingMs?: number;
  models?: BridgeAppOptions["models"];
  /** Do not start the default workspace's OpenCode eagerly. */
  lazy?: boolean;
}

export interface BridgeHandleExt extends BridgeHandle {
  bridge: Bridge;
}

/** Start the bridge HTTP server (default 127.0.0.1:8790) and the default workspace's OpenCode. */
export async function startBridge(opts: StartBridgeOptions & StartBridgeTestOptions = {}): Promise<BridgeHandleExt> {
  const env = opts.env ?? process.env;
  const host = opts.host ?? env.HOST ?? "127.0.0.1";
  const port = opts.port ?? (env.PORT !== undefined && env.PORT !== "" ? Number(env.PORT) : 8790);
  const workspace = opts.workspace ?? env.SECRETS_AI_WORKSPACE ?? process.cwd();
  const bridge = new Bridge({
    env,
    workspace,
    opencodeBin: opts.opencodeBin ?? env.OPENCODE_BIN,
    quiet: opts.quiet,
    logger: opts.logger,
    supervisor: opts.supervisor,
    pingMs: opts.pingMs,
    models: opts.models,
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
