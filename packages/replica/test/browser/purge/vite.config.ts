import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** TC-1888 purge fixture: a TinyCloudWeb page with replication enabled, built like the TC-858 acceptance fixture. */
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: here,
  publicDir: resolve(here, "../fixture/public"),
  build: {
    target: "es2022",
    minify: false,
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: { index: resolve(here, "index.html") },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
