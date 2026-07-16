import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/tools.ts",
    "src/results.ts",
    "src/cli.ts",
  ],
  format: ["esm", "cjs"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/server/stdio",
    "@modelcontextprotocol/server/validators/ajv",
    "@tinycloud/operations",
    "@tinycloud/operations/operations.json",
    "@tinycloud/operations/profile",
  ],
});
