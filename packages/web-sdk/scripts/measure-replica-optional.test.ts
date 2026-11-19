/**
 * The per-PR optional ledger row must equal the merge-base delta exactly, and the checker measures
 * the merge base in a randomly named worktree. The measurement therefore must not depend on where
 * the measured repository lives.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureReplicaOptionalLoaded } from "./measure-replica-optional";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A minimal repository whose optional entry shares the root and defers its IDB factory. */
function repository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const dist = join(root, "packages/web-sdk/dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "replica.mjs"),
    'import { root } from "@tinycloud/web-sdk";\nexport const open = () => import("./kv-storage.js").then((m) => m.factory(root));\n');
  writeFileSync(join(dist, "kv-storage.js"), "export const factory = (root) => ({ root, kind: \"indexeddb\" });\n");
  return dist;
}

test("optional sizes do not depend on the measured repository's location", async () => {
  const near = await measureReplicaOptionalLoaded(repository("a-"));
  const far = await measureReplicaOptionalLoaded(repository("a-much-longer-merge-base-worktree-name-"));
  expect(near["replica.mjs"]).toBeGreaterThan(0);
  expect(far).toEqual(near);
});
