#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { createTinyCloudDelegatedVfs } from "@tinycloud/vfs";

const SERVER_URL =
  process.env.TC_TEST_SERVER ?? process.env.TINYCLOUD_URL ?? "http://localhost:8000";

function freshPrivateKey() {
  return randomBytes(32).toString("hex");
}

async function checkServerHealth() {
  for (const endpoint of ["/info", "/version"]) {
    try {
      const response = await fetch(`${SERVER_URL}${endpoint}`);
      if (response.ok) {
        return;
      }
    } catch {
      // try next endpoint
    }
  }

  throw new Error(
    `Cannot reach tinycloud-node at ${SERVER_URL}.\n` +
      `Start a local node or set TC_TEST_SERVER=https://node.tinycloud.xyz`,
  );
}

function createClient(name, privateKey) {
  return new TinyCloudNode({
    privateKey,
    host: SERVER_URL,
    prefix: `vfs-demo-${name}`,
    autoCreateSpace: true,
  });
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  const aliceKey = process.env.TC_TEST_PRIVATE_KEY ?? freshPrivateKey();
  const bobKey = process.env.TC_TEST_BOB_PRIVATE_KEY ?? freshPrivateKey();
  const mountPath = pathPosix.join("/tmp", "tinycloud-vfs", "demo", runId, "shared");
  const scope = `shared/${runId}/`;
  const seedKey = `${scope}seed.txt`;
  const bobKeyPath = `${scope}bob-note.txt`;

  console.log("TinyCloud VFS Demo");
  console.log("=".repeat(60));
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Run:    ${runId}`);
  console.log();

  await checkServerHealth();

  const alice = createClient(`alice-${runId}`, aliceKey);
  const bob = createClient(`bob-${runId}`, bobKey);

  console.log("[Alice] Signing in...");
  await alice.signIn();
  console.log(`[Alice] Space: ${alice.spaceId}`);

  console.log("[Bob] Signing in...");
  await bob.signIn();
  console.log(`[Bob] Space: ${bob.spaceId}`);
  console.log();

  const seedResult = await alice.kv.put(seedKey, "seed from alice");
  assert.equal(seedResult.ok, true);

  const delegation = await alice.createDelegation({
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

  console.log(`[Alice] Delegation CID: ${delegation.cid}`);

  const { provider, vfs } = await createTinyCloudDelegatedVfs({ node: bob, delegation });
  vfs.mount(mountPath);

  try {
    console.log(`[Bob] Mounted VFS at ${mountPath}`);

    const seed = fs.readFileSync(`${mountPath}/seed.txt`, "utf8");
    console.log(`[Bob] Read seed: ${seed}`);

    fs.mkdirSync(`${mountPath}/drafts`, { recursive: true });
    fs.writeFileSync(`${mountPath}/bob-note.txt`, "written by bob");
    fs.writeFileSync(`${mountPath}/drafts/second.txt`, "nested content");

    const entries = fs.readdirSync(mountPath).sort();
    console.log(`[Bob] Root entries: ${entries.join(", ")}`);
    assert.deepEqual(entries, ["bob-note.txt", "drafts", "seed.txt"]);

    const note = await alice.kv.get(bobKeyPath);
    assert.equal(note.ok, true);
    if (note.ok) {
      console.log(`[Alice] Verified bob note: ${note.data.data}`);
    }

    fs.renameSync(`${mountPath}/bob-note.txt`, `${mountPath}/bob-note-final.txt`);
    console.log("[Bob] Renamed bob-note.txt -> bob-note-final.txt");

    const renamed = fs.readFileSync(`${mountPath}/bob-note-final.txt`, "utf8");
    assert.equal(renamed, "written by bob");
    console.log(`[Bob] Read renamed file: ${renamed}`);

    fs.unlinkSync(`${mountPath}/drafts/second.txt`);
    fs.rmdirSync(`${mountPath}/drafts`);
    console.log("[Bob] Cleaned up nested draft directory");
  } finally {
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

    for (const key of [
      seedKey,
      bobKeyPath,
      `${scope}bob-note-final.txt`,
      `${scope}drafts/second.txt`,
    ]) {
      try {
        await alice.kv.delete(key);
      } catch {
        // ignore cleanup failures in the demo
      }
    }
  }

  console.log();
  console.log("Demo complete.");
}

main().catch((error) => {
  console.error("\nDemo failed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
