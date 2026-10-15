import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TC-858 acceptance fixture: a TinyCloudWeb page with replication enabled.
 * Shares the RC1 service worker (`../fixture/public/sw.js`) so the offline
 * shell is cached the same way.
 */

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
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
