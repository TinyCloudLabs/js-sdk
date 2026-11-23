#!/usr/bin/env bun
/**
 * TinyCloud Node.js SDK Demo - Data Vault (E2E Encrypted KV)
 *
 * Demonstrates the Data Vault service from the SDK:
 *
 * 1. Alice and Bob sign in and unlock their vaults
 * 2. Alice encrypts and stores medical records
 * 3. Alice reads back and decrypts her data
 * 4. Alice grants Bob access to a specific entry
 * 5. Bob decrypts the shared entry using Alice's grant
 *
 * Key concepts:
 * - All encryption/decryption is handled by the SDK's DataVaultService
 * - Vault uses WASM crypto: AES-256-GCM, HKDF-SHA256, X25519
 * - Sharing uses X25519 Diffie-Hellman key exchange
 * - Public keys published to public spaces for discovery
 *
 * Prerequisites:
 * - A running TinyCloud server (default: http://localhost:8000)
 *
 * Usage:
 *   bun run demo:vault
 */

import {
  TinyCloudNode,
  serializeDelegation,
  deserializeDelegation,
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
    throw new Error(
      `Server not reachable at ${TINYCLOUD_URL}: ${err.message}`
    );
  }
  console.log();
}

// ============================================================================
// Demo Flow
// ============================================================================

async function runDemo() {
  console.log();
  console.log("TinyCloud Data Vault Demo - E2E Encrypted KV Storage (SDK)");
  console.log("=".repeat(70));
  console.log(`Server: ${TINYCLOUD_URL}`);
  console.log();

  await checkServerHealth();

  // =========================================================================
  // Setup: Create Alice and Bob with wallets
  // =========================================================================
  const aliceKey = process.env.ALICE_PRIVATE_KEY || generateKey();
  const bobKey = process.env.BOB_PRIVATE_KEY || generateKey();
  const aliceWallet = new Wallet(`0x${aliceKey}`);
  const bobWallet = new Wallet(`0x${bobKey}`);

  console.log(`[Setup] Alice: ${aliceWallet.address}`);
  console.log(`[Setup] Bob:   ${bobWallet.address}`);
  console.log();

  // Vault data lives in the public space (encrypted, so safe for public reads).
  // This allows getShared() to read grants and data via the public endpoint.
  const alice = new TinyCloudNode({
    privateKey: aliceKey,
    host: TINYCLOUD_URL,
    ...ownerFullAccess("applications"),
    autoCreateSpace: true,
  });

  const bob = new TinyCloudNode({
    privateKey: bobKey,
    host: TINYCLOUD_URL,
    ...ownerFullAccess("applications"),
    autoCreateSpace: true,
  });

  // Both sign in to create their spaces
  console.log("[Alice] Signing in...");
  await alice.signIn();
  console.log(`[Alice] Space: ${alice.spaceId}`);

  console.log("[Bob] Signing in...");
  await bob.signIn();
  console.log(`[Bob] Space: ${bob.spaceId}`);
  console.log();

  // =========================================================================
  // PART 1: Unlock Vaults — derive keys from wallet signatures
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 1: Unlock Vaults — derive keys via SDK");
  console.log("=".repeat(70));
  console.log();

  console.log("[Alice] Unlocking vault (derives master key + X25519 identity)...");
  const aliceUnlock = await alice.vault.unlock(aliceWallet);
  if (!aliceUnlock.ok) {
    throw new Error(`Alice vault unlock failed: ${(aliceUnlock as any).error?.message}`);
  }
  console.log("[Alice] Vault unlocked, public key published");

  console.log("[Bob] Unlocking vault...");
  const bobUnlock = await bob.vault.unlock(bobWallet);
  if (!bobUnlock.ok) {
    throw new Error(`Bob vault unlock failed: ${(bobUnlock as any).error?.message}`);
  }
  console.log("[Bob] Vault unlocked, public key published");
  console.log();

  // =========================================================================
  // PART 2: Alice encrypts and stores sensitive data
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 2: Alice encrypts and stores medical records");
  console.log("=".repeat(70));
  console.log();

  const medicalRecord = {
    patient: "Alice",
    bloodPressure: "120/80",
    heartRate: 72,
    notes: "All vitals normal",
    date: new Date().toISOString(),
  };

  console.log(`[Alice] Plaintext: ${JSON.stringify(medicalRecord)}`);
  console.log("[Alice] Encrypting and storing via vault.put()...");

  const putResult = await alice.vault.put("medical/records/2026", medicalRecord);
  if (!putResult.ok) {
    throw new Error(`vault.put failed: ${(putResult as any).error?.message}`);
  }
  console.log("[Alice] Stored encrypted.");
  console.log();

  // Store another entry
  const credentials = {
    type: "api-key",
    service: "lab-portal",
    key: "sk_live_abc123def456",
    created: new Date().toISOString(),
  };
  console.log("[Alice] Storing encrypted credentials...");
  const credResult = await alice.vault.put("credentials/lab-portal", credentials);
  if (!credResult.ok) {
    throw new Error(`vault.put credentials failed: ${(credResult as any).error?.message}`);
  }
  console.log("[Alice] Credentials stored (encrypted)");
  console.log();

  // =========================================================================
  // PART 3: Alice reads back and decrypts her data
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 3: Alice reads back and decrypts");
  console.log("=".repeat(70));
  console.log();

  console.log("[Alice] Fetching and decrypting medical/records/2026...");
  const getResult = await alice.vault.get<typeof medicalRecord>("medical/records/2026");
  if (!getResult.ok) {
    throw new Error(`vault.get failed: ${(getResult as any).error?.message}`);
  }
  console.log(`[Alice] Decrypted: ${JSON.stringify(getResult.data.value)}`);
  console.log(`[Alice] Key ID: ${getResult.data.keyId}`);
  console.log(
    `[Alice] Match: ${JSON.stringify(getResult.data.value) === JSON.stringify(medicalRecord)}`
  );
  console.log();

  // Verify server only sees ciphertext
  console.log("[Server] What the server sees (encrypted blob):");
  const rawResult = await alice.kv.get<string>("vault/medical/records/2026", {
    raw: true,
  });
  if (rawResult.ok) {
    const envelope =
      typeof rawResult.data.data === "string"
        ? JSON.parse(rawResult.data.data)
        : rawResult.data.data;
    console.log(`  cipher: ${envelope.metadata?.["x-vault-cipher"]}`);
    console.log(`  key-id: ${envelope.metadata?.["x-vault-key-id"]}`);
    console.log(
      `  data (first 60 chars): ${(envelope.data as string).slice(0, 60)}...`
    );
    console.log("  (Server CANNOT decrypt this — no key material on server)");
  }
  console.log();

  // =========================================================================
  // PART 4: Alice grants Bob access via X25519 key exchange
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 4: Alice grants Bob access to medical records");
  console.log("=".repeat(70));
  console.log();

  console.log("[Alice] Granting Bob access via vault.grant() (X25519 DH)...");
  const grantResult = await alice.vault.grant("medical/records/2026", bob.did);
  if (!grantResult.ok) {
    throw new Error(`vault.grant failed: ${(grantResult as any).error?.message}`);
  }
  console.log("[Alice] Grant stored — entry key re-encrypted to Bob's public key");
  console.log();

  // Alice delegates read access to Bob for the encrypted data + grants
  console.log("[Alice] Creating delegation for Bob (read access)...");
  const delegation = await alice.createDelegation({
    delegateDID: bob.did,
    path: "",
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    expiryMs: 24 * 60 * 60 * 1000,
  });
  console.log(`[Alice] Delegation created: ${delegation.cid}`);
  console.log();

  // =========================================================================
  // PART 5: Bob decrypts Alice's shared data
  // =========================================================================
  console.log("=".repeat(70));
  console.log("PART 5: Bob decrypts Alice's shared data");
  console.log("=".repeat(70));
  console.log();

  console.log("[Bob] Receiving Alice's delegation...");
  const serialized = serializeDelegation(delegation);
  const received = deserializeDelegation(serialized);
  const access = await bob.useDelegation(received);

  console.log("[Bob] Decrypting shared data via vault.getShared()...");
  const sharedResult = await bob.vault.getShared<typeof medicalRecord>(
    alice.did,
    "medical/records/2026",
    { kv: access.kv }
  );
  if (!sharedResult.ok) {
    throw new Error(`vault.getShared failed: ${(sharedResult as any).error?.code} - ${(sharedResult as any).error?.message}`);
  }
  console.log(`[Bob] Decrypted: ${JSON.stringify(sharedResult.data.value)}`);
  console.log(
    `[Bob] Match original: ${JSON.stringify(sharedResult.data.value) === JSON.stringify(medicalRecord)}`
  );
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
  console.log("PART 1 — Vault Unlock (vault.unlock):");
  console.log("  Master key derived from deterministic wallet signature + HKDF");
  console.log("  X25519 encryption identity derived from separate signature");
  console.log("  Public key auto-published to public space");
  console.log();
  console.log("PART 2 — Encrypted Storage (vault.put):");
  console.log("  Per-entry random AES-256-GCM key (forward secrecy)");
  console.log("  Entry keys encrypted with master key, stored separately");
  console.log("  Self-describing metadata envelope (cipher, key ID, etc.)");
  console.log("  Server sees only encrypted blobs — ZERO plaintext access");
  console.log();
  console.log("PART 3 — Decryption (vault.get):");
  console.log("  Decrypt entry key → decrypt value → deserialize JSON");
  console.log();
  console.log("PART 4 — Sharing via Grants (vault.grant):");
  console.log("  Entry key re-encrypted to Bob's X25519 public key");
  console.log("  Ephemeral DH keypair per grant (forward secrecy)");
  console.log("  Delegation grants read access to encrypted data");
  console.log();
  console.log("PART 5 — Receiving Shared Data (vault.getShared):");
  console.log("  Bob resolves grant → DH to recover entry key → decrypt");
  console.log("  Server never sees the decrypted entry key or plaintext");
  console.log();
  console.log("All crypto handled by DataVaultService from @tinycloud/sdk-services");
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
