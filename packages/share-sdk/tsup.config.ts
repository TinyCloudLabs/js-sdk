import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "share-root": "src/share-root-entry.ts" },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats", "@tinycloud/share-envelope"],
});
