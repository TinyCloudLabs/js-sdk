import { defineConfig } from "tsup";

export default defineConfig({
  // `artifact`, `html-bundle`, `share-root` and the share index are their own entries: the layout helpers and the HTML
  // folder rewriter are CLI/agent tooling, the share root is sender-key tooling, and consumers of the share index import `@tinycloud/share-sdk/share-index`;
  // keeping them out of the index barrel keeps them out of the browser bundles that import the index (the web-sdk size
  // ceiling counts every byte).
  entry: {
    index: "src/index.ts",
    artifact: "src/artifact.ts",
    "html-bundle": "src/html-bundle/index.ts",
    "share-root": "src/share-root-entry.ts",
    "share-index": "src/share-index/index.ts",
  },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats", "@tinycloud/share-envelope"],
});
