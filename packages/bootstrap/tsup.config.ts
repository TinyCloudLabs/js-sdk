import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/capabilities.ts",
    "src/generated/capabilities.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  bundle: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["viem"],
});
