import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * TC-19 fixture (`index.html`, `@tinycloud/replica/browser`) and the TC-858
 * kv-storage fixture (`kv.html`, `@tinycloud/replica/kv-storage`).
 */
export default defineConfig({
  // The fixture resolves workspace packages through the monorepo root.
  resolve: { dedupe: ["@tinycloud/replica"] },
  // The kv-storage test worker imports modules; module workers bundle as ES.
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Keep the bundle legible in failure artifacts.
    minify: false,
    outDir: "dist",
    emptyOutDir: true,
    // A single chunk keeps the offline cache small and the test simple.
    modulePreload: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        kv: resolve(import.meta.dirname, "kv.html"),
        node: resolve(import.meta.dirname, "node.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        // Shared chunks are hashed: a chunk named like a `?url` worker asset would overwrite it.
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
