import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  bundle: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["viem"],
});
