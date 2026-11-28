import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "src/mcp/secrets-mcp.ts",
    "src/mcp/github-mcp.ts",
  ],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
