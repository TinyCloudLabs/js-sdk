import { defineConfig } from "tsup";

export default defineConfig({
  // `artifact` is its own entry: the layout helpers are CLI/agent tooling, and keeping them out of the index barrel keeps
  // them out of the browser bundles that import the index (the web-sdk size ceiling counts every byte).
  entry: { index: "src/index.ts", artifact: "src/artifact.ts" },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats", "@tinycloud/share-envelope"],
});
