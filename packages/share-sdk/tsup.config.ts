import { defineConfig } from "tsup";

export default defineConfig({
  // `artifact` and `share-root` are their own entries: the layout helpers are CLI/agent tooling and the share root is
  // sender-key tooling; keeping them out of the index barrel keeps them out of the browser bundles that import the index
  // (the web-sdk size ceiling counts every byte).
  entry: { index: "src/index.ts", artifact: "src/artifact.ts", "share-root": "src/share-root-entry.ts" },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats", "@tinycloud/share-envelope"],
});
