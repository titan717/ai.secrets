import { buildApp } from "./app.js";
import { ensureBridgeToken } from "./security/auth.js";

const port = Number(process.env.PORT) || 8790;
const host = process.env.HOST || "127.0.0.1";
const bridgeToken = ensureBridgeToken();

const app = await buildApp({ bridgeToken });
try {
  await app.listen({ port, host });
  app.log.info(`ai.secrets bridge listening on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
