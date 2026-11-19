/**
 * Child-process fixture for worker.init.test.ts: loads the production worker entry with a
 * `@tinycloud/web-sdk-wasm` whose `initialized` rejects, then prints what the worker reported.
 * A separate process keeps the module override out of every other test file.
 */
import { plugin } from "bun";

const reported: string[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage: () => reported.push("unexpected postMessage"), onmessage: null },
});
Object.defineProperty(globalThis, "reportError", {
  configurable: true,
  value: (error: unknown) => reported.push(error instanceof Error ? error.message : String(error)),
});
plugin({
  name: "blocked-wasm",
  setup(build) {
    build.module("@tinycloud/web-sdk-wasm", () => {
      const initialized = Promise.reject(new Error("WebAssembly is blocked by CSP"));
      initialized.catch(() => undefined);
      return { loader: "object", exports: { initialized, tinycloud: {}, tcwSession: {} } };
    });
  },
});
await import("../src/kv-storage/worker.js");
for (let turn = 0; turn < 10 && reported.length === 0; turn++) await Promise.resolve();
console.log(JSON.stringify(reported));
