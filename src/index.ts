/**
 * Bridge daemon entry: `node dist/index.js`. Prints the URL and the token FILE path (never the token).
 */
import { paths } from "./core/paths.js";
import { startBridge } from "./bridge/server.js";

const handle = await startBridge({});
const tokenHint = process.env.SECRETS_AI_TOKEN ? "$SECRETS_AI_TOKEN" : paths.authFile();
process.stdout.write(`secrets-ai bridge listening on ${handle.url}\nbearer token: see ${tokenHint}\n`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const t = setTimeout(() => process.exit(1), 10_000);
  t.unref();
  await handle.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
