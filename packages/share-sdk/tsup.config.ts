import { defineConfig } from "tsup";

export default defineConfig({
  // The share index is its own entry: browser bundles that import the package root (web-sdk, whose size
  // ceiling counts every byte) must not carry it. Consumers import `@tinycloud/share-sdk/share-index`.
  entry: { index: "src/index.ts", "share-index": "src/share-index/index.ts" },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats", "@tinycloud/share-envelope"],
});
