import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDelegationActivator } from "@tinycloud/node-sdk";

// These load the built operations entry points, as the CLI does. Each entry
// point bundles its own copy of the profile-state module.
const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-operations-entrypoints-"));
process.env.TC_HOME = home;
const state = await import("@tinycloud/operations/state");
const binding = await import("@tinycloud/operations/delegation-binding");

afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

test("a profile lock held through the state entry point is reentrant for delegation-binding", async () => {
  await state.writeSession("entrypoints", { verificationMethod: "did:key:z6MkEntrypoints#z6MkEntrypoints" });
  const node = { sessionDid: "did:key:z6MkEntrypoints" } as unknown as RuntimeDelegationActivator;

  const migrated = await state.withProfileLock("entrypoints", () =>
    binding.prepareStoredDelegationReplay("entrypoints", node, { host: "https://node.example.test", migrate: true }));

  expect(migrated).toBe(true);
  expect(await state.readJson(binding.bindingMigrationPath("entrypoints"))).toMatchObject({ bound: [], unbound: [] });
});

test("an invocation state root set through the state entry point reaches delegation-binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-operations-state-root-"));
  try {
    const path = await state.withTinyCloudStateRoot(root, async () => binding.bindingMigrationPath("entrypoints"));
    expect(path.startsWith(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
