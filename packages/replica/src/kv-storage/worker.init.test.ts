/**
 * The production worker entry reports a start-up failure (for example WebAssembly blocked by a
 * CSP) through `reportError`. An unhandled rejection inside a worker fires no `error` event on the
 * Worker object, so without the report every queued call would hang.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("a failed WASM start is reported as an uncaught worker error", () => {
  const fixture = join(import.meta.dir, "../../test/worker-init-failure.fixture.ts");
  const child = Bun.spawnSync([process.execPath, "run", fixture], { stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual(["WebAssembly is blocked by CSP"]);
});
