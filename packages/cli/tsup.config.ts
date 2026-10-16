import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/bootstrap.ts", "src/diagnostics-entry.ts", "src/index.ts", "src/legacy-entry.ts", "src/courier-entry.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  define: { __TC_CLI_PACKAGE_VERSION__: JSON.stringify(version) },
  // The legacy graph is a separate entry so the main executable can load
  // Share/help without evaluating optional auth/WASM dependencies.
  splitting: false,
  external: ["siwe"],
  // The replica engine and store ship inside the CLI; SQLite itself is the
  // runtime's built-in module, loaded on demand by `tc replica`.
  // Courier ships inside the CLI as `tc courier`, in its own lazy entry.
  noExternal: ["@tinycloud/share-sdk", "@tinycloud/share-envelope", "@tinycloud/replica", "@tinycloud/courier"],
});
