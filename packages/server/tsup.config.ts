import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["@tinycloud/node-sdk", "viem", "viem/accounts"],
});
