import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTinyCloudDelegatedVfs } from "@tinycloud/vfs";
import {
  OWNER_PRIVATE_KEY,
  checkServerHealth,
  cleanupKeys,
  createClient,
  createMountPath,
  createRunId,
  freshPrivateKey,
} from "./setup.mjs";

const runId = createRunId();
const ownerKey = OWNER_PRIVATE_KEY;
const bobKey = freshPrivateKey();
const owner = createClient(`delegation-owner-${runId}`, ownerKey);
const bob = createClient(`delegation-bob-${runId}`, bobKey);

await checkServerHealth();
await owner.signIn();
await bob.signIn();

test("delegated mount reads and writes inside the delegated subtree", async (t) => {
  const scope = `shared/${runId}/`;
  const mountPath = createMountPath(runId, "delegated-rw");
  const seedKey = `${scope}seed.txt`;
  const writeKey = `${scope}bob-note.txt`;
  const nestedKey = `${scope}nested/extra.txt`;

  const seedPut = await owner.kv.put(seedKey, "seed from alice");
  assert.equal(seedPut.ok, true);

  const delegation = await owner.createDelegation({
    path: scope,
    actions: [
      "tinycloud.kv/get",
      "tinycloud.kv/put",
      "tinycloud.kv/list",
      "tinycloud.kv/del",
      "tinycloud.kv/metadata",
    ],
    delegateDID: bob.did,
  });

  const { provider, vfs } = await createTinyCloudDelegatedVfs({ node: bob, delegation });
  vfs.mount(mountPath);
  t.after(() => {
    try {
      vfs.unmount();
    } catch {
      // ignore
    }
    try {
      provider.close();
    } catch {
      // ignore
    }
  });

  assert.equal(fs.readFileSync(`${mountPath}/seed.txt`, "utf8"), "seed from alice");

  fs.writeFileSync(`${mountPath}/bob-note.txt`, "written by bob");
  assert.equal(fs.readFileSync(`${mountPath}/bob-note.txt`, "utf8"), "written by bob");

  fs.mkdirSync(`${mountPath}/nested`, { recursive: true });
  fs.writeFileSync(`${mountPath}/nested/extra.txt`, "nested content");

  const entries = fs.readdirSync(mountPath).sort();
  assert.deepEqual(entries, ["bob-note.txt", "nested", "seed.txt"]);

  const nestedEntries = fs.readdirSync(`${mountPath}/nested`);
  assert.deepEqual(nestedEntries, ["extra.txt"]);

  const stored = await owner.kv.get(writeKey);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.data.data, "written by bob");
  }

  await cleanupKeys(owner, [seedKey, writeKey, nestedKey, scope.slice(0, -1), `${scope}nested`]);
});

test("read-only delegation denies writes with EACCES", async (t) => {
  const scope = `readonly/${runId}/`;
  const mountPath = createMountPath(runId, "delegated-ro");
  const seedKey = `${scope}seed.txt`;

  const seedPut = await owner.kv.put(seedKey, "read only seed");
  assert.equal(seedPut.ok, true);

  const delegation = await owner.createDelegation({
    path: scope,
    actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata"],
    delegateDID: bob.did,
  });

  const { provider, vfs } = await createTinyCloudDelegatedVfs({ node: bob, delegation });
  vfs.mount(mountPath);
  t.after(() => {
    try {
      vfs.unmount();
    } catch {
      // ignore
    }
    try {
      provider.close();
    } catch {
      // ignore
    }
  });

  assert.equal(fs.readFileSync(`${mountPath}/seed.txt`, "utf8"), "read only seed");

  assert.throws(
    () => {
      fs.writeFileSync(`${mountPath}/blocked.txt`, "should fail");
    },
    (error) => {
      assert.equal(error.code, "EACCES");
      return true;
    },
  );

  await cleanupKeys(owner, [seedKey, `${scope}blocked.txt`, scope.slice(0, -1)]);
});
