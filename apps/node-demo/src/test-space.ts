#!/usr/bin/env bun
/**
 * Test space creation flow with a fresh key each time.
 * Used to verify autoCreateSpace behavior.
 */

import { TinyCloudNode, ownerFullAccess } from "@tinycloud/node-sdk";
import { Wallet } from "ethers";

const TINYCLOUD_URL = process.env.TINYCLOUD_URL || "http://localhost:8000";

async function testSpaceCreation() {
  console.log("\nTest: Space Creation Flow");
  console.log("=".repeat(50));
  console.log(`Server: ${TINYCLOUD_URL}`);
  console.log();

  // Generate fresh key each time - no existing space
  const wallet = Wallet.createRandom();
  const privateKey = wallet.privateKey.slice(2);
  console.log(`[Test] Generated fresh key: ${wallet.address}`);
  console.log();

  // Test 1: Sign in WITH autoCreateSpace
  console.log("[Test 1] Sign in with autoCreateSpace: true");
  const alice = new TinyCloudNode({
    privateKey,
    host: TINYCLOUD_URL,
    ...ownerFullAccess("test-space"),
    autoCreateSpace: true,
  });

  await alice.signIn();
  console.log(`[Test 1] SUCCESS - Space created: ${alice.spaceId}`);
  console.log();

  // Test 2: Sign in WITHOUT autoCreateSpace (different key)
  const wallet2 = Wallet.createRandom();
  const privateKey2 = wallet2.privateKey.slice(2);
  console.log(`[Test 2] Sign in with autoCreateSpace: false (fresh key: ${wallet2.address})`);

  const bob = new TinyCloudNode({
    privateKey: privateKey2,
    host: TINYCLOUD_URL,
    ...ownerFullAccess("test-space"),
    autoCreateSpace: false,
  });

  await bob.signIn();
  console.log(`[Test 2] SUCCESS - Signed in without creating space (spaceId: ${bob.spaceId})`);
  console.log();

  // Test 3: Verify Alice can use KV (has space)
  console.log("[Test 3] Alice writes to her space...");
  const putResult = await alice.kv.put("test-key", { value: "hello" });
  if (!putResult.ok) {
    throw new Error(`KV put failed: ${putResult.error?.message}`);
  }

  const result = await alice.kv.get<{ value: string }>("test-key");
  // KVResponse has { data: T, headers: KVResponseHeaders }
  const actualValue = result.data?.data;

  if (!result.ok || actualValue?.value !== "hello") {
    throw new Error(`KV read failed: expected "hello", got "${actualValue?.value}"`);
  }
  console.log(`[Test 3] SUCCESS - Read back: ${actualValue.value}`);
  console.log();

  console.log("=".repeat(50));
  console.log("All tests passed!");
  console.log();
}

testSpaceCreation().catch((error) => {
  console.error("\nTest Failed!");
  console.error("Error:", error.message);
  console.error();
  console.error("Make sure the TinyCloud server is running at:", TINYCLOUD_URL);
  process.exit(1);
});
