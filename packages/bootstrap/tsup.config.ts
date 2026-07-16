import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/capabilities.ts",
    "src/generated/capabilities.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  // Bundle the package's internal entrypoint graph so the generated CJS files
  // never require `.js` siblings inside this `type: module` package.
  bundle: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["viem"],
});
