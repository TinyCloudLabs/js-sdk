import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm", "cjs"],
  dts: {
    entry: "src/index.ts",
  },
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    "@platformatic/vfs",
    "@tinycloud/node-sdk",
    "node:buffer",
    "node:path",
    "node:url",
    "node:worker_threads",
  ],
});
