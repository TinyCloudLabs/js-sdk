import { defineConfig } from "tsup";

export default defineConfig({
  // `artifact` and the share index are their own entries: browser bundles that import the package root (web-sdk, whose
  // size ceiling counts every byte) must not carry them. `artifact` holds CLI/agent layout helpers; consumers of the
  // share index import `@tinycloud/share-sdk/share-index`.
  entry: { index: "src/index.ts", artifact: "src/artifact.ts", "share-index": "src/share-index/index.ts" },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats", "@tinycloud/share-envelope"],
});
