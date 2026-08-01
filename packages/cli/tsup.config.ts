import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/legacy-entry.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // The legacy graph is a separate entry so the main executable can load
  // Share/help without evaluating optional auth/WASM dependencies.
  splitting: false,
  external: ["siwe"],
  noExternal: ["@tinycloud/share-sdk", "@tinycloud/share-envelope"],
});
