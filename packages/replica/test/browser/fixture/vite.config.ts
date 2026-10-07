import { defineConfig } from "vite";

/** TC-19 fixture: a minimal page importing `@tinycloud/replica/browser`. */
export default defineConfig({
  // The fixture resolves workspace packages through the monorepo root.
  resolve: { dedupe: ["@tinycloud/replica"] },
  build: {
    target: "es2022",
    // Keep the bundle legible in failure artifacts.
    minify: false,
    outDir: "dist",
    emptyOutDir: true,
    // A single chunk keeps the offline cache small and the test simple.
    modulePreload: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
