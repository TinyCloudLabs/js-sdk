import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/short-link.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["multiformats"],
});
