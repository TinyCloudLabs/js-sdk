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
  // The replica engine and store ship inside the CLI; SQLite itself is the
  // runtime's built-in module, loaded on demand by `tc replica`.
  noExternal: ["@tinycloud/share-sdk", "@tinycloud/share-envelope", "@tinycloud/replica"],
});
