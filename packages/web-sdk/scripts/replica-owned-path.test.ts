import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { replicaOwnedPath } from "./replica-owned-path";

// check-phase1-replica-dist.ts classifies a PR as replica-touching when any changed path is owned.
const replicaTouching = (paths: string[]) => paths.some(replicaOwnedPath);

const rowOnly = [
  "packages/replica/scripts/check-worker-size.ts",
  "packages/replica/scripts/check-worker-size.test.ts",
  "packages/replica/scripts/check-pack-exports.ts",
  "packages/web-sdk/scripts/check-phase1-replica-dist.ts",
  "packages/web-sdk/scripts/replica-size-policy.ts",
  "packages/web-sdk/scripts/replica-size-policy.test.ts",
  "packages/web-sdk/scripts/replica-size-ledger.json",
  "packages/web-sdk/scripts/replica-optional-size-ledger.json",
  "packages/web-sdk/scripts/phase1-replica-baseline.json",
];

describe("replica-owned paths", () => {
  it("does not treat a size-policy row-only commit as replica code", () => {
    expect(rowOnly.filter(replicaOwnedPath)).toEqual([]);
    expect(replicaTouching(rowOnly)).toBe(false);
  });

  it("still treats shipped replica code as replica code", () => {
    for (const path of [
      "packages/replica/src/worker.ts",
      "packages/replica/src/kv-storage/host.ts",
      "packages/replica/package.json",
      "packages/replica/tsup.config.ts",
      "packages/replica/scripts/hash-worker.ts",
    ]) {
      expect(replicaTouching([path])).toBe(true);
    }
  });

  it("treats a commit mixing rows and replica source as replica code", () => {
    const mixed = [...rowOnly, "packages/replica/src/engine.ts"];
    expect(replicaTouching(mixed)).toBe(true);
    expect(mixed.filter(replicaOwnedPath)).toEqual(["packages/replica/src/engine.ts"]);
  });

  it("keeps every script the replica build runs replica-owned", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../../replica/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const buildSteps = Object.entries(manifest.scripts)
      .filter(([name]) => /^(pre|post)?build(:|$)/.test(name))
      .flatMap(([, command]) => [...command.matchAll(/(?:^|\s)(?:\.\/)?(scripts\/[^\s"'&;|]+)/g)])
      .map((match) => `packages/replica/${match[1]}`);
    expect(buildSteps).toContain("packages/replica/scripts/hash-worker.ts");
    expect(buildSteps.filter((path) => !replicaOwnedPath(path))).toEqual([]);
  });
});
