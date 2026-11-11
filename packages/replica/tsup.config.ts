import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";

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

const workerServiceSources: Record<string, string> = {
  "@tinycloud/sdk-services/context": "../sdk-services/src/context.ts",
  "@tinycloud/sdk-services/request-priority": "../sdk-services/src/requestPriority.ts",
  "@tinycloud/sdk-services/kv": "../sdk-services/src/kv/index.ts",
};

export default defineConfig([
  {
    entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts", "profile-gate": "src/profile-gate/index.ts" },
    format: ["esm", "cjs"],
    target: "es2022",
    dts: true,
    clean: false,
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
    esbuildPlugins: [nodeBuiltinsExternal, {
      name: "worker-service-context",
      setup(build) {
        // Bundle the shared source once, before package entries flatten its retry helpers.
        build.onResolve({ filter: /^@tinycloud\/sdk-services\/(context|request-priority|kv)$/ }, ({ path: request }) => ({
          path: fileURLToPath(new URL(workerServiceSources[request], import.meta.url)),
        }));
        build.onResolve({ filter: /^\.\/requestPriorityLoader$/ }, ({ importer }) => {
          if (importer.startsWith(fileURLToPath(new URL("../sdk-services/src/", import.meta.url)))) {
            return { path: fileURLToPath(new URL("./src/request-priority-loader.ts", import.meta.url)) };
          }
        });
      },
    }],
  },
  {
    // The read-through `KVReplicaStorage` (TC-858 Phase 2) and its test-only
    // fault seams. ESM only, like `browser`: after tsup, hash-worker.ts
    // replaces the literal worker URL with its SHA-256 filename.
    entry: { "kv-storage": "src/kv-storage/index.ts", "kv-storage-testing": "src/kv-storage/testing.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    sourcemap: true,
    noExternal: [/^@tinycloud\/sdk-services(?:\/|$)/],
    splitting: false,
    // The client uses only identity helpers. Resolve their canonical source
    // before the services barrel flattens controller/error modules into one file.
    esbuildPlugins: [{
      name: "storage-service-helpers",
      setup(build) {
        build.onResolve({ filter: /^@tinycloud\/sdk-services\/kv\/replication$/ }, () => ({
          path: fileURLToPath(new URL("../sdk-services/src/kv/replication/index.ts", import.meta.url)),
        }));
      },
    }],
  },
]);
