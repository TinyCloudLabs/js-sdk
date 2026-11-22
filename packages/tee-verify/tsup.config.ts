import { defineConfig } from "tsup";

export default defineConfig([
  // The pins in ../pins are bundled, so the published lists are part of the reviewed build.
  { entry: { index: "src/index.ts" }, format: ["esm", "cjs"], target: "es2022", dts: true, sourcemap: true, clean: true },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
