import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts" },
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
