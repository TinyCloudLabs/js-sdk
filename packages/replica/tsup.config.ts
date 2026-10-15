import { defineConfig } from "tsup";

/**
 * wasm-bindgen's CJS helper (inside @tinycloud/web-sdk-wasm) has dead
 * `require("fs"|"path"|"url")` branches that only run under node. In the
 * worker bundle they are never reached; marking them external lets esbuild
 * leave the bare `require` calls in place.
 */
const nodeBuiltinsExternal = {
  name: "worker-node-builtins-external",
  setup(build: { onResolve(options: { filter: RegExp }, cb: () => { external: boolean }): void }) {
    build.onResolve({ filter: /^(fs|path|url|module|crypto|stream|buffer|util|os|http|https|zlib|net|tls|child_process)$/ }, () => ({
      external: true,
    }));
  },
};

export default defineConfig([
  {
    entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts", "profile-gate": "src/profile-gate/index.ts" },
    format: ["esm", "cjs"],
    target: "es2022",
    dts: true,
    clean: true,
    sourcemap: true,
    noExternal: [/^@tinycloud\/sdk-services(?:\/|$)/],
    splitting: false,
  },
  {
    // The main-thread browser client (TC-19). ESM only: it resolves the
    // worker through `new URL("…", import.meta.url)`, which has no CJS form.
    entry: { browser: "src/browser/index.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    sourcemap: true,
    // Raw browser consumers have no import map for sdk-services.
    noExternal: [/^@tinycloud\/sdk-services(?:\/|$)/],
    splitting: false,
  },
  {
    // The dedicated worker (TC-19). Self-contained ESM: sdk-services and the
    // web-sdk-wasm bundle (WASM inlined) are compiled in so the worker never
    // fetches a module or a .wasm at runtime.
    entry: { "replica.worker": "src/worker.ts", "kv-storage.worker": "src/kv-storage/worker.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    sourcemap: true,
    splitting: false,
    noExternal: [/.*/],
    esbuildPlugins: [nodeBuiltinsExternal],
  },
  {
    // The read-through `KVReplicaStorage` (TC-858 Phase 2) and its test-only
    // fault seams. ESM only, like `browser`: the worker resolves through
    // `new URL("./kv-storage.worker.js", import.meta.url)`.
    entry: { "kv-storage": "src/kv-storage/index.ts", "kv-storage-testing": "src/kv-storage/testing.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    sourcemap: true,
    noExternal: [/^@tinycloud\/sdk-services(?:\/|$)/],
    splitting: false,
  },
]);
