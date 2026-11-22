#!/usr/bin/env bun
/**
 * TinyCloud Node.js SDK Demo - Public Spaces
 *
 * Demonstrates the public spaces feature:
 *
 * 1. Alice creates her public space and publishes data
 * 2. Bob reads Alice's public data via the SDK (unauthenticated, no delegation)
 * 3. A raw fetch request reads Alice's public data (no SDK, no auth)
 *
 * Key concepts demonstrated:
 * - Public spaces use the reserved name "public" (prefix: "public")
 * - Anyone can read from public spaces without authentication
 * - Writes require authentication (owner session scoped to the public space)
 * - `TinyCloud.readPublicKey()` is a static, unauthenticated read
 * - `GET /public/{spaceId}/kv/{key}` works with a plain HTTP request
 *
 * Prerequisites:
 * - A running TinyCloud server (default: http://localhost:8000)
 *
 * Environment Variables:
 *   TINYCLOUD_URL         - TinyCloud server URL (default: http://localhost:8000)
 *   ALICE_PRIVATE_KEY     - Alice's Ethereum private key (optional, auto-generated)
 *
 * Usage:
 *   bun run demo:public-spaces
 */

import {
  TinyCloudNode,
  TinyCloud,
  makePublicSpaceId,
  ownerFullAccess,
} from "@tinycloud/node-sdk";
import { Wallet } from "ethers";

// ============================================================================
// Configuration
// ============================================================================

const TINYCLOUD_URL = process.env.TINYCLOUD_URL || "http://localhost:8000";

// ============================================================================
// Helpers
// ============================================================================

function generateKey(): string {
  return Wallet.createRandom().privateKey.slice(2);
}

async function checkServerHealth() {
  console.log("[Health] Checking server...");
  try {
    const response = await fetch(`${TINYCLOUD_URL}/healthz`);
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    console.log("[Health] Server is running");
  } catch (error) {
    const err = error as Error;
    throw new Error(`Server not reachable at ${TINYCLOUD_URL}: ${err.message}`);
  }
  console.log();
}

// ============================================================================
// Demo Flow
// ============================================================================

async function runDemo() {
  console.log();
  console.log("TinyCloud Node.js SDK Demo - Public Spaces");
  console.log("=".repeat(70));
  console.log(`Server: ${TINYCLOUD_URL}`);
  console.log();

  await checkServerHealth();

  // =========================================================================
  // Setup
  // =========================================================================

  const aliceKey = process.env.ALICE_PRIVATE_KEY || generateKey();
  const aliceWallet = new Wallet(`0x${aliceKey}`);
  console.log(`[Setup] Alice: ${aliceWallet.address}`);

  const bobKey = generateKey();
  const bobWallet = new Wallet(`0x${bobKey}`);
  console.log(`[Setup] Bob:   ${bobWallet.address}`);
  console.log();

  // =========================================================================
  // PART 1: Alice creates her public space and publishes data
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 1: Alice publishes to her public space");
  console.log("=".repeat(70));
  console.log();

  // Show the deterministic public space ID
  const alicePublicSpaceId = makePublicSpaceId(aliceWallet.address, 1);
  console.log(`[Alice] Public space ID: ${alicePublicSpaceId}`);
  console.log();

  // Alice signs in with prefix "public" — this creates the public space
  // and gives her an authenticated session scoped to it
  const alice = new TinyCloudNode({
    privateKey: aliceKey,
    host: TINYCLOUD_URL,
    ...ownerFullAccess("public"),
    autoCreateSpace: true,
  });

  console.log("[Alice] Signing in to public space...");
  await alice.signIn();
  console.log(`[Alice] Space: ${alice.spaceId}`);
  console.log();

  // Write a profile to the public space
  console.log("[Alice] Publishing profile to well-known/profile...");
  const profileData = {
    name: "Alice",
    bio: "Decentralized storage enthusiast",
    website: "https://alice.example.com",
    updatedAt: new Date().toISOString(),
  };

  const putResult = await alice.kv.put("well-known/profile", profileData);
  if (!putResult.ok) {
    console.error(`[Alice] Failed to publish profile: ${putResult.error.message}`);
    process.exit(1);
  }
  console.log(`[Alice] Profile published: ${JSON.stringify(profileData)}`);
  console.log();

  // Write a status message
  console.log("[Alice] Publishing status...");
  const statusData = {
    message: "Hello from my public space!",
    timestamp: new Date().toISOString(),
  };
  const statusResult = await alice.kv.put("status", statusData);
  if (!statusResult.ok) {
    console.error(`[Alice] Failed to publish status: ${statusResult.error.message}`);
  } else {
    console.log(`[Alice] Status published: "${statusData.message}"`);
  }
  console.log();

  // =========================================================================
  // PART 2: Bob reads Alice's public data using SDK (no delegation needed)
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 2: Bob reads Alice's public data (SDK, unauthenticated)");
  console.log("=".repeat(70));
  console.log();

  // Bob doesn't need to sign in — static methods work without any session
  console.log(`[Bob] Looking up Alice's public data by address: ${aliceWallet.address}`);
  console.log();

  // Read Alice's profile — static method, no auth needed
  const profileResult = await TinyCloud.readPublicKey<typeof profileData>(
    TINYCLOUD_URL,
    aliceWallet.address,
    1,
    "well-known/profile"
  );

  if (!profileResult.ok) {
    console.error(`[Bob] Failed to read profile: ${profileResult.error.message}`);
  } else {
    console.log(`[Bob] Read Alice's profile:`);
    console.log(`  Name:    ${profileResult.data.name}`);
    console.log(`  Bio:     ${profileResult.data.bio}`);
    console.log(`  Website: ${profileResult.data.website}`);
  }
  console.log();

  // Read Alice's status
  const statusReadResult = await TinyCloud.readPublicKey<typeof statusData>(
    TINYCLOUD_URL,
    aliceWallet.address,
    1,
    "status"
  );

  if (!statusReadResult.ok) {
    console.error(`[Bob] Failed to read status: ${statusReadResult.error.message}`);
  } else {
    console.log(`[Bob] Read Alice's status: "${statusReadResult.data.message}"`);
  }
  console.log();

  // =========================================================================
  // PART 3: Raw fetch — no SDK, no auth, just HTTP
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 3: Raw HTTP GET (no SDK, no auth — anyone can do this)");
  console.log("=".repeat(70));
  console.log();

  const publicUrl = `${TINYCLOUD_URL}/public/${encodeURIComponent(alicePublicSpaceId)}/kv/well-known/profile`;
  console.log(`[HTTP] GET ${publicUrl}`);
  console.log();

  const rawResponse = await fetch(publicUrl);
  console.log(`[HTTP] Status: ${rawResponse.status}`);
  console.log(`[HTTP] ETag: ${rawResponse.headers.get("etag")}`);
  console.log(`[HTTP] Cache-Control: ${rawResponse.headers.get("cache-control")}`);
  console.log(`[HTTP] Access-Control-Allow-Origin: ${rawResponse.headers.get("access-control-allow-origin")}`);

  if (rawResponse.ok) {
    const body = await rawResponse.text();
    try {
      const parsed = JSON.parse(body);
      console.log(`[HTTP] Body: ${JSON.stringify(parsed, null, 2)}`);
    } catch {
      console.log(`[HTTP] Body: ${body}`);
    }
  } else {
    console.log(`[HTTP] Error: ${await rawResponse.text()}`);
  }
  console.log();

  // Demonstrate conditional request with If-None-Match
  const etag = rawResponse.headers.get("etag");
  if (etag) {
    console.log(`[HTTP] Conditional request with If-None-Match: ${etag}`);
    const conditionalResponse = await fetch(publicUrl, {
      headers: { "If-None-Match": etag },
    });
    console.log(`[HTTP] Status: ${conditionalResponse.status} (expected 304 Not Modified)`);
  }
  console.log();

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("=".repeat(70));
  console.log("Demo Complete!");
  console.log("=".repeat(70));
  console.log();
  console.log("What was demonstrated:");
  console.log();
  console.log("PART 1 - Publishing to Public Space:");
  console.log("  - TinyCloudNode with prefix: 'public' creates the public space");
  console.log("  - alice.kv.put() writes to the public space (authenticated)");
  console.log("  - makePublicSpaceId(address, chainId) constructs deterministic ID");
  console.log();
  console.log("PART 2 - SDK Unauthenticated Read:");
  console.log("  - TinyCloud.readPublicKey(host, address, chainId, key)");
  console.log("  - No delegation needed, no signIn needed for reader");
  console.log("  - Anyone can read given only the owner's address");
  console.log();
  console.log("PART 3 - Raw HTTP Read:");
  console.log("  - GET /public/{spaceId}/kv/{key} — plain HTTP, no auth header");
  console.log("  - ETag header for cache validation");
  console.log("  - If-None-Match for conditional requests (304 Not Modified)");
  console.log("  - CORS headers (Access-Control-Allow-Origin: *)");
  console.log();
}

runDemo().catch((error) => {
  console.error();
  console.error("Demo Failed!");
  console.error("Error:", error.message || error);
  if (error.stack) console.error("Stack:", error.stack);
  console.error();
  console.error("Make sure the TinyCloud server is running at:", TINYCLOUD_URL);
  console.error("  cd repositories/tinycloud-node && cargo run");
  console.error();
  process.exit(1);
});
