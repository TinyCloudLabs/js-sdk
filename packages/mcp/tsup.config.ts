import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/tools.ts",
    "src/results.ts",
    "src/cli.ts",
    "src/http.ts",
    "src/http-cli.ts",
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
    "@modelcontextprotocol/node",
    "@tinycloud/node-sdk",
    "@tinycloud/node-sdk-wasm",
    "@tinycloud/operations",
    "@tinycloud/operations/operations.json",
    "@tinycloud/operations/profile",
  ],
});
