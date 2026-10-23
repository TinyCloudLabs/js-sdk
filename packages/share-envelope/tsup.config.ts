import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  // Each entry is one self-contained file with a fixed name and path: `dist/index.js` and `dist/links.js`.
  splitting: false,
} as const;

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts" }, clean: true, noExternal: ["multiformats"] },
  // The links reader is loaded on demand as `dist/links.js`. Its dependencies (zod, @noble/*, multiformats) stay
  // package imports, so a bundler that already holds them does not add a second copy.
  { ...shared, entry: { links: "src/links/index.ts" }, clean: false },
]);
