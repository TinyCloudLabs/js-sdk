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
    "web-recipient": "src/web-recipient-entry.ts",
  },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // `@tinycloud/share-envelope/links` stays an import of the package (loaded on demand by receive, publish and
  // invitations) so the bundles that embed this one do not carry the links code.
  noExternal: ["multiformats", /^@tinycloud\/share-envelope$/],
  external: ["@tinycloud/share-envelope/links"],
});
