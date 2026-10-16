import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Explicit file entrypoint: never imports tests/cli/setup.ts or live test config.
// The child creates/removes its own HOME and TC_HOME and allowlists loopback.
test("built CLI verifies SQL paste approval, imports/deduplicates a bound grant, and dispatches only explicit SQL calls", () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../test-support/diagnostics-approval-smoke.ts")], {
    env: { PATH: process.env.PATH, NODE_BINARY: process.env.NODE_BINARY ?? "node", NO_COLOR: "1" },
    encoding: "utf8", timeout: 180_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const [marker, counts] = result.stdout.trim().split("\n");
  expect(marker).toBe("diagnostic-approval-parity-ok");
  const report = JSON.parse(counts!) as {
    modes: number;
    dispatches: { capture: string; sqlRequests: number; sqlEffects: number }[];
    grantsPerProfile: number;
    linkage: string;
    sqlEngine: boolean;
  };
  expect(report.modes).toBe(3);
  expect(report.dispatches.map(({ capture, sqlRequests, sqlEffects }) => ({ capture, sqlRequests, sqlEffects }))).toEqual([
    { capture: "disabled", sqlRequests: 2, sqlEffects: 1 },
    { capture: "enabled", sqlRequests: 2, sqlEffects: 1 },
    { capture: "failed", sqlRequests: 2, sqlEffects: 1 },
  ]);
  expect(report.grantsPerProfile).toBe(1);
  expect(report.linkage).toBe("explicit-workflow");
  expect(report.sqlEngine).toBe(false);
}, 190_000);
