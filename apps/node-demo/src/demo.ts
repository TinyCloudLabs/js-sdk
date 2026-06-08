#!/usr/bin/env bun
/**
 * TinyCloud Node.js SDK Demo - Session-Only Mode & Delegations
 *
 * Demonstrates the TinyCloud SDK with session-only users receiving delegations:
 *
 * 1. Alice (wallet mode) creates a space and stores data
 * 2. Bob (session-only) receives a delegation from Alice - NO wallet needed
 * 3. Bob accesses Alice's space via useDelegation() - NO signIn() needed
 * 4. Bob creates sub-delegation for Charlie (also session-only)
 * 5. Charlie accesses Alice's space via delegation chain
 *
 * Key concepts demonstrated:
 * - `did` returns primary identity (PKH for wallet mode, session key for session-only)
 * - Session-only users can receive and use delegations without a wallet
 * - useDelegation() works without calling signIn()
 *
 * Prerequisites:
 * - A running TinyCloud server (default: http://localhost:8000)
 *
 * Environment Variables:
 *   TINYCLOUD_URL         - TinyCloud server URL (default: http://localhost:8000)
 *   ALICE_PRIVATE_KEY     - Alice's Ethereum private key (optional, auto-generated)
 *
 * Usage:
 *   bun run demo
 */

import {
  TinyCloudNode,
  TinyCloud,
  serializeDelegation,
  deserializeDelegation,
} from "@tinycloud/node-sdk";
import { Wallet } from "ethers";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Configuration
// ============================================================================

const TINYCLOUD_URL = process.env.TINYCLOUD_URL || "http://localhost:8000";
const ENV_PATH = join(import.meta.dir, "..", ".env");

// ============================================================================
// Key Management (only Alice needs a wallet)
// ============================================================================

function generateKey(): string {
  const wallet = Wallet.createRandom();
  return wallet.privateKey.slice(2); // Remove 0x prefix
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const match = trimmed.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        result[match[1]] = match[2];
      }
    }
  }
  return result;
}

async function checkServerHealth() {
  console.log("[Health] Checking server...");
  try {
    const healthResponse = await fetch(`${TINYCLOUD_URL}/healthz`);
    if (!healthResponse.ok) {
      throw new Error(`Server returned ${healthResponse.status}`);
    }
    console.log("[Health] ✓ Server is running");
  } catch (error) {
    const err = error as Error;
    throw new Error(`Server not reachable at ${TINYCLOUD_URL}: ${err.message}`);
  }
  console.log();
}

function ensureAliceKey(): string {
  let aliceKey = process.env.ALICE_PRIVATE_KEY;

  // Load existing .env file
  if (existsSync(ENV_PATH)) {
    const parsed = parseEnvFile(readFileSync(ENV_PATH, "utf-8"));
    aliceKey = aliceKey || parsed.ALICE_PRIVATE_KEY;
  }

  // Generate if missing
  if (!aliceKey) {
    aliceKey = generateKey();
    console.log(`[KeyGen] Generated Alice's key: ${new Wallet(`0x${aliceKey}`).address}`);
  }

  return aliceKey;
}

// ============================================================================
// Demo Flow
// ============================================================================

async function runDemo() {
  console.log();
  console.log("TinyCloud Node.js SDK Demo - Space API");
  console.log("=".repeat(70));
  console.log(`Server: ${TINYCLOUD_URL}`);
  console.log();

  // Step 0: Check server health
  await checkServerHealth();

  // Step 1: Only Alice needs a wallet key
  const aliceKey = ensureAliceKey();

  // Step 2: Create TinyCloudNode instances
  // Alice: Has wallet, can create her own space
  const alice = new TinyCloudNode({
    privateKey: aliceKey,
    host: TINYCLOUD_URL,
    prefix: "demo-alice",
    autoCreateSpace: true,
  });

  // Bob: Session-only mode (no wallet) - will receive delegations
  const bob = new TinyCloudNode();

  // Charlie: Session-only mode (no wallet) - will receive sub-delegations
  const charlie = new TinyCloudNode();

  // Step 3: Only Alice signs in (creates her space)
  // Bob and Charlie are session-only - they don't sign in
  console.log("[Alice] Signing in (wallet mode)...");
  await alice.signIn();
  console.log(`[Alice] Space: ${alice.spaceId}`);
  console.log(`[Alice] DID: ${alice.did}`);
  console.log(`[Alice] isSessionOnly: ${alice.isSessionOnly}`);

  console.log();
  console.log("[Bob] Session-only mode (no wallet, no sign-in)");
  console.log(`[Bob] DID: ${bob.did}`);
  console.log(`[Bob] isSessionOnly: ${bob.isSessionOnly}`);

  console.log();
  console.log("[Charlie] Session-only mode (no wallet, no sign-in)");
  console.log(`[Charlie] DID: ${charlie.did}`);
  console.log(`[Charlie] isSessionOnly: ${charlie.isSessionOnly}`);
  console.log();

  // =========================================================================
  // PART 1: Space API - Basic Operations
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("PART 1: Space API - Basic Operations");
  console.log("=".repeat(70));
  console.log();

  // Step 4: Get Alice's space (named by prefix)
  // Note: Alice's session is bound to "demo-alice" space due to prefix config
  console.log("[Alice] Getting space...");
  const aliceSpace = alice.spaces.get("demo-alice");
  console.log(`[Alice] Space ID: ${aliceSpace.id}`);
  console.log(`[Alice] Space name: ${aliceSpace.name}`);
  console.log();

  // Step 5: Alice stores data using Space API
  console.log("[Alice] Storing data in space...");
  const putResult = await aliceSpace.kv.put("shared/greeting", {
    message: "Hello from Alice!",
    timestamp: new Date().toISOString(),
  });

  if (!putResult.ok) {
    console.error(`[Alice] ✗ Failed to store: ${putResult.error.message}`);
  } else {
    console.log("[Alice] ✓ Data stored at 'shared/greeting'");
  }
  console.log();

  // Step 6: Alice uses prefix scoping
  console.log("[Alice] Using prefix-scoped KV...");
  const sharedKV = aliceSpace.kv.withPrefix("shared/");

  const prefixPutResult = await sharedKV.put("document.json", {
    title: "Important Document",
    content: "This is shared data",
  });

  if (!prefixPutResult.ok) {
    console.error(`[Alice] ✗ Failed: ${prefixPutResult.error.message}`);
  } else {
    console.log("[Alice] ✓ Stored 'document.json' in shared/ prefix");
  }
  console.log();

  // =========================================================================
  // PART 2: Space API - Delegations
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("PART 2: Space API - Delegations");
  console.log("=".repeat(70));
  console.log();

  // Step 7: Demonstrate both Space API and direct delegation creation
  //
  // The Space API's delegations.create() creates tracked delegations (metadata).
  // For transferable credentials with auth headers (usable with useDelegation()),
  // use TinyCloudNode.createDelegation() which returns a PortableDelegation.
  //
  // Let's demonstrate both:

  // 7a: Create delegation via Space API (tracked, returns Delegation metadata)
  console.log("[Alice] Creating delegation via Space API (tracked)...");
  const spaceDelegationResult = await aliceSpace.delegations.create({
    delegateDID: bob.did,
    path: "shared/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  });

  if (!spaceDelegationResult.ok) {
    console.error(`[Alice] ✗ Space API delegation failed: ${spaceDelegationResult.error.message}`);
    process.exit(1);
  }
  console.log("[Alice] ✓ Space API delegation created!");
  console.log(`  CID: ${spaceDelegationResult.data.cid}`);
  console.log();

  // 7b: Create portable delegation for Bob (transferable credential)
  console.log("[Alice] Creating portable delegation for Bob...");
  const portableDelegation = await alice.createDelegation({
    delegateDID: bob.did,
    path: "shared/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    expiryMs: 24 * 60 * 60 * 1000, // 24 hours
  });

  console.log("[Alice] ✓ Portable delegation created!");
  console.log(`  CID: ${portableDelegation.cid}`);
  console.log(`  Delegate: ${portableDelegation.delegateDID}`);
  console.log(`  Path: ${portableDelegation.path}`);
  console.log(`  Actions: ${portableDelegation.actions.join(", ")}`);
  console.log(`  Expiry: ${portableDelegation.expiry.toISOString()}`);
  console.log();

  // Step 8: Alice lists her outgoing delegations
  // Uses tinycloud.capabilities/read with facts parameter
  console.log("[Alice] Listing delegations via Space API...");
  const delegationsResult = await aliceSpace.delegations.list();
  if (delegationsResult.ok) {
    console.log(`[Alice] ✓ Found ${delegationsResult.data.length} delegation(s):`);
    for (const d of delegationsResult.data) {
      console.log(`  - CID: ${d.cid || d.delegationCid || "(unknown)"}`);
    }
  } else {
    console.log(`[Alice] ✗ Failed to list delegations: ${delegationsResult.error.message}`);
  }
  console.log();

  // Step 9: Note on session-only users
  // Session-only users like Bob don't have their own space - they can only
  // access spaces via delegations. The listReceived() API would require
  // Bob to have signed in, which defeats the purpose of session-only mode.

  // Step 10: Bob accesses Alice's space using delegation
  console.log("[Bob] Accessing Alice's space...");

  // Serialize and deserialize the delegation (simulating transfer between users)
  const serializedForBob = serializeDelegation(portableDelegation);
  const receivedByBob = deserializeDelegation(serializedForBob);
  const bobAccessToAlice = await bob.useDelegation(receivedByBob);

  // Bob reads Alice's data
  const greetingResult = await bobAccessToAlice.kv.get("greeting");
  if (!greetingResult.ok) {
    console.error(`[Bob] ✗ Failed to read greeting: ${greetingResult.error.message}`);
  } else if (greetingResult.data?.data) {
    console.log(`[Bob] ✓ Read from Alice: "${greetingResult.data.data.message}"`);
  }

  // Bob writes a response
  const bobWriteResult = await bobAccessToAlice.kv.put("bob-was-here", {
    from: "Bob",
    message: "Thanks for sharing, Alice!",
    timestamp: new Date().toISOString(),
  });

  if (!bobWriteResult.ok) {
    console.error(`[Bob] ✗ Failed to write response: ${bobWriteResult.error.message}`);
  } else {
    console.log("[Bob] ✓ Wrote response to Alice's space");
  }
  console.log();

  // Step 11: Alice creates a separate delegation for Charlie (also session-only)
  console.log("[Alice] Creating delegation for Charlie...");
  const charlieDelegation = await alice.createDelegation({
    delegateDID: charlie.did,
    path: "shared/",
    actions: ["tinycloud.kv/put"],
    expiryMs: 24 * 60 * 60 * 1000,
  });
  console.log(`[Alice] ✓ Delegation created for Charlie: ${charlieDelegation.cid}`);
  console.log();

  // Step 12: Charlie uses delegation (session-only, no signIn needed)
  const serializedForCharlie = serializeDelegation(charlieDelegation);
  const receivedByCharlie = deserializeDelegation(serializedForCharlie);
  const charlieAccessToAlice = await charlie.useDelegation(receivedByCharlie);

  console.log("[Charlie] Writing to Alice's space (session-only, no signIn)...");
  const charlieWriteResult = await charlieAccessToAlice.kv.put("charlie-was-here", {
    from: "Charlie",
    message: "Hello from session-only Charlie!",
    timestamp: new Date().toISOString(),
  });

  if (!charlieWriteResult.ok) {
    console.error(`[Charlie] ✗ Failed to write: ${charlieWriteResult.error.message}`);
  } else {
    console.log("[Charlie] ✓ Wrote to Alice's space");
  }
  console.log();

  // Step 13: Alice reads messages from both Bob and Charlie
  console.log("[Alice] Reading responses...");
  const bobResponse = await aliceSpace.kv.get<{ from: string; message: string }>("shared/bob-was-here");
  const charlieResponse = await aliceSpace.kv.get<{ from: string; message: string }>("shared/charlie-was-here");

  if (!bobResponse.ok) {
    console.error(`[Alice] ✗ Failed to read Bob's response: ${bobResponse.error.message}`);
  } else if (bobResponse.data?.data) {
    console.log(`[Alice] From Bob: "${bobResponse.data.data.message}"`);
  }
  if (!charlieResponse.ok) {
    console.error(`[Alice] ✗ Failed to read Charlie's response: ${charlieResponse.error.message}`);
  } else if (charlieResponse.data?.data) {
    console.log(`[Alice] From Charlie: "${charlieResponse.data.data.message}"`);
  }
  console.log();

  // =========================================================================
  // PART 3: Sharing Links (V2 - Client-Side with Embedded Keys)
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("PART 3: Sharing Links (V2 - Client-Side with Embedded Keys)");
  console.log("=".repeat(70));
  console.log();

  // V2 sharing links embed the private key directly in the link.
  // No server-side share/* endpoints needed - all handled client-side.
  // The link recipient can use the embedded key to exercise the delegation.

  // Step 14: Alice creates a sharing link for anyone to read shared/ data
  console.log("[Alice] Generating a sharing link for public read access...");
  const shareLinkResult = await alice.sharing.generate({
    path: "shared/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    description: "Read access to shared folder",
  });

  if (!shareLinkResult.ok) {
    console.error(`[Alice] ✗ Failed to generate sharing link: ${shareLinkResult.error.message}`);
  } else {
    console.log("[Alice] ✓ Sharing link generated!");
    console.log(`  Token (first 50 chars): ${shareLinkResult.data.token.slice(0, 50)}...`);
    console.log(`  Expires: ${shareLinkResult.data.expiresAt.toISOString()}`);
    console.log();

    // Step 15: Dave (a new session-only user) receives the sharing link
    const dave = new TinyCloudNode(); // Session-only mode
    console.log("[Dave] Session-only mode (no wallet, no sign-in)");
    console.log(`[Dave] DID: ${dave.did}`);
    console.log();

    console.log("[Dave] Receiving sharing link...");
    const shareAccessResult = await dave.sharing.receive(shareLinkResult.data.token);

    if (!shareAccessResult.ok) {
      console.error(`[Dave] ✗ Failed to receive sharing link: ${shareAccessResult.error.message}`);
    } else {
      console.log("[Dave] ✓ Sharing link received!");
      console.log(`  Space ID: ${shareAccessResult.data.spaceId}`);
      console.log(`  Path: ${shareAccessResult.data.path}`);
      console.log();

      // Step 16: Dave reads data using the pre-configured KV service
      console.log("[Dave] Reading data via sharing link...");
      const daveReadResult = await shareAccessResult.data.kv.get("greeting");

      if (!daveReadResult.ok) {
        console.error(`[Dave] ✗ Failed to read: ${daveReadResult.error.message}`);
      } else if (daveReadResult.data?.data) {
        console.log(`[Dave] ✓ Read from Alice via sharing link: "${daveReadResult.data.data.message}"`);
      } else {
        console.log("[Dave] ✓ No data found (this is expected if greeting wasn't in shared/ path)");
      }

      // Try reading document.json which was stored in shared/ prefix
      const docResult = await shareAccessResult.data.kv.get("document.json");
      if (docResult.ok && docResult.data?.data) {
        console.log(`[Dave] ✓ Read document: "${docResult.data.data.title}"`);
      }
    }
  }
  console.log();

  // =========================================================================
  // PART 5: SQL Service - Relational Database
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("PART 5: SQL Service - Relational Database");
  console.log("=".repeat(70));
  console.log();

  // Step 1: Alice creates a table and inserts data
  console.log("[Alice] Creating users table...");
  const createResult = await alice.sql.execute(
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)",
    [],
    { schema: ["CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)"] }
  );

  if (!createResult.ok) {
    console.error(`[Alice] ✗ Failed to create table: ${createResult.error.message}`);
  } else {
    console.log("[Alice] ✓ Table created");
  }

  // Step 2: Insert rows
  console.log("[Alice] Inserting users...");
  const insertResult = await alice.sql.execute(
    "INSERT INTO users (name, email) VALUES (?, ?)",
    ["Alice", "alice@example.com"]
  );
  if (insertResult.ok) {
    console.log(`[Alice] ✓ Inserted user (id: ${insertResult.data.lastInsertRowId})`);
  }

  await alice.sql.execute(
    "INSERT INTO users (name, email) VALUES (?, ?)",
    ["Bob", "bob@example.com"]
  );

  // Step 3: Query rows
  console.log("[Alice] Querying users...");
  const queryResult = await alice.sql.query<[number, string, string]>(
    "SELECT * FROM users ORDER BY id"
  );
  if (queryResult.ok) {
    console.log(`[Alice] ✓ Found ${queryResult.data.rowCount} users:`);
    console.log(`  Columns: ${queryResult.data.columns.join(", ")}`);
    for (const row of queryResult.data.rows) {
      console.log(`  Row: ${JSON.stringify(row)}`);
    }
  }

  // Step 4: Batch operations (transaction)
  console.log("[Alice] Running batch insert...");
  const batchResult = await alice.sql.batch([
    { sql: "INSERT INTO users (name, email) VALUES (?, ?)", params: ["Charlie", "charlie@example.com"] },
    { sql: "INSERT INTO users (name, email) VALUES (?, ?)", params: ["Dave", "dave@example.com"] },
  ]);
  if (batchResult.ok) {
    console.log(`[Alice] ✓ Batch completed: ${batchResult.data.results.length} statements executed`);
  }

  // Step 5: Named databases
  console.log("[Alice] Using named database 'analytics'...");
  const analyticsDb = alice.sql.db("analytics");
  const analyticsCreateResult = await analyticsDb.execute(
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, event TEXT, ts TEXT)"
  );
  if (analyticsCreateResult.ok) {
    console.log("[Alice] ✓ analytics.events table created");
  }
  await analyticsDb.execute(
    "INSERT INTO events (event, ts) VALUES (?, ?)",
    ["page_view", new Date().toISOString()]
  );
  const eventsResult = await analyticsDb.query("SELECT COUNT(*) as count FROM events");
  if (eventsResult.ok) {
    console.log(`[Alice] ✓ Analytics events: ${JSON.stringify(eventsResult.data.rows[0])}`);
  }

  // Step 6: Delegated SQL access
  console.log();
  console.log("[Alice] Delegating SQL read access to Bob...");
  const sqlDelegation = await alice.createDelegation({
    delegateDID: bob.did,
    path: "default",
    actions: ["tinycloud.sql/read"],
    expiryMs: 60 * 60 * 1000,
  });
  console.log(`[Alice] ✓ SQL delegation created: ${sqlDelegation.cid}`);

  const bobSqlAccess = await bob.useDelegation(sqlDelegation);
  console.log("[Bob] Querying Alice's database via delegation...");
  const bobQueryResult = await bobSqlAccess.sql.query("SELECT name FROM users ORDER BY id");
  if (bobQueryResult.ok) {
    console.log(`[Bob] ✓ Read ${bobQueryResult.data.rowCount} users from Alice's database`);
    for (const row of bobQueryResult.data.rows) {
      console.log(`  - ${row[0]}`);
    }
  }

  // Step 7: Read-only enforcement (Bob should not be able to write)
  console.log("[Bob] Attempting write (should fail)...");
  const bobWriteResult2 = await bobSqlAccess.sql.execute(
    "INSERT INTO users (name, email) VALUES (?, ?)",
    ["Hacker", "hack@evil.com"]
  );
  if (!bobWriteResult2.ok) {
    console.log(`[Bob] ✓ Write correctly denied: ${bobWriteResult2.error.code}`);
  } else {
    console.log("[Bob] ✗ Write should have been denied!");
  }
  console.log();

  // =========================================================================
  // PART 4: Space Management (Skipped - Space API not yet implemented)
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("PART 4: Space Management (Space API not yet implemented on server)");
  console.log("=".repeat(70));
  console.log();

  // NOTE: spaces.list() and space.info() require server-side support for
  // tinycloud.space/* capabilities which are not yet implemented.
  console.log("[Alice] Space listing and info via Space API skipped (server not yet implemented)");
  console.log();

  // =========================================================================
  // PART 6: Multi-Space Session (Single Signature)
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("PART 6: MULTI-SPACE SESSION (SINGLE SIGNATURE)");
  console.log("=".repeat(70));
  console.log();

  // Alice's session already covers both primary and public spaces
  // (enablePublicSpace defaults to true in TinyCloudNode)
  console.log("[Alice] Single signIn() covered multiple spaces:");
  console.log(`  Primary space: ${alice.spaceId}`);
  console.log(`  Public space:  ${alice.session?.spaces?.public ?? "(not included)"}`);
  console.log();

  // Ensure public space exists (lazy creation)
  console.log("[Alice] Ensuring public space exists...");
  await alice.ensurePublicSpace();
  console.log("[Alice] Public space ready.");
  console.log();

  // Write to public space
  console.log("[Alice] Writing profile to public space...");
  const publicSpace = alice.spaces.get("public");
  const publicPutResult = await publicSpace.kv.put("profile", {
    name: "Alice",
    bio: "Multi-space session demo",
    updatedAt: new Date().toISOString(),
  });
  if (publicPutResult.ok) {
    console.log("[Alice] Profile written to public space");
  } else {
    console.log(`[Alice] Failed to write: ${publicPutResult.error.message}`);
  }

  // Read back from public space
  const publicGetResult = await publicSpace.kv.get<{name: string; bio: string; updatedAt: string}>("profile");
  if (publicGetResult.ok && publicGetResult.data?.data) {
    console.log(`[Alice] Read back from public: ${JSON.stringify(publicGetResult.data.data)}`);
  } else {
    console.log(`[Alice] Failed to read: ${publicGetResult.error?.message}`);
  }
  console.log();

  // Bob reads Alice's public profile unauthenticated
  console.log("[Bob] Reading Alice's public profile (unauthenticated)...");
  const bobPublicRead = await TinyCloud.readPublicKey<{name: string; bio: string}>(
    TINYCLOUD_URL,
    alice.address!,
    1,
    "profile"
  );
  if (bobPublicRead.ok) {
    console.log(`[Bob] Read Alice's public profile: ${JSON.stringify(bobPublicRead.data)}`);
  } else {
    console.log(`[Bob] Failed to read: ${bobPublicRead.error?.message}`);
  }
  console.log();

  console.log("[Summary] Single wallet signature covered both primary and public spaces!");
  console.log();

  // =========================================================================
  // Summary
  // =========================================================================
  console.log();
  console.log("=".repeat(70));
  console.log("Demo Complete!");
  console.log("=".repeat(70));
  console.log();
  console.log("What was demonstrated:");
  console.log();
  console.log("SESSION-ONLY MODE:");
  console.log("  ✓ Alice: wallet mode (has privateKey, can signIn)");
  console.log("  ✓ Bob & Charlie: session-only (no wallet, no signIn needed)");
  console.log("  ✓ did returns PKH for wallet mode, session key for session-only");
  console.log();
  console.log("PART 1 - Space API Basic Operations:");
  console.log("  ✓ Alice stored data using space.kv.put()");
  console.log("  ✓ Used prefix scoping with space.kv.withPrefix()");
  console.log();
  console.log("PART 2 - Delegations (session-only users receiving access):");
  console.log("  ✓ Alice created delegations for Bob & Charlie using their DIDs (session keys)");
  console.log("  ✓ Bob used delegation WITHOUT calling signIn()");
  console.log("  ✓ Charlie used delegation WITHOUT calling signIn()");
  console.log("  ✓ Both accessed Alice's space via delegations");
  console.log();
  console.log("Key APIs for Session-Only Mode:");
  console.log("  • new TinyCloudNode({ host }) - Create session-only instance");
  console.log("  • node.did - Owner DID when wallet-backed; session key DID in session-only mode");
  console.log("  • node.isSessionOnly - Check if in session-only mode");
  console.log("  • node.useDelegation() - Works without signIn()");
  console.log();
  console.log("PART 3 - Sharing Links (V2 with embedded keys):");
  console.log("  ✓ Alice generated sharing link with embedded private key");
  console.log("  ✓ Dave received link WITHOUT signIn() or wallet");
  console.log("  ✓ Dave accessed Alice's space using pre-configured KV from share");
  console.log();
  console.log("PART 5 - SQL Service:");
  console.log("  ✓ Created table with alice.sql.execute()");
  console.log("  ✓ Queried rows with alice.sql.query()");
  console.log("  ✓ Batch operations with alice.sql.batch()");
  console.log("  ✓ Named database handle with alice.sql.db('analytics')");
  console.log("  ✓ SQL delegation with read-only enforcement");
  console.log("  ✓ Bob queried via delegation, write correctly denied");
  console.log();
  console.log("PART 6 - Multi-Space Session:");
  console.log("  ✓ Single signIn() covered primary + public space");
  console.log("  ✓ alice.ensurePublicSpace() for lazy creation");
  console.log("  ✓ alice.spaces.get('public').kv for public space writes");
  console.log("  ✓ TinyCloud.readPublicKey() for unauthenticated reads");
  console.log();
  console.log("PART 4 - Space Management:");
  console.log("  ⏳ Skipped (server-side tinycloud.space/* not yet implemented)");
  console.log();
  console.log("Working APIs Used:");
  console.log("  • spaces.get(name) - Get Space object");
  console.log("  • space.kv.put/get/list - Space-scoped KV operations");
  console.log("  • space.kv.withPrefix() - Prefix-scoped KV");
  console.log("  • space.delegations.create() - Create tracked delegation");
  console.log("  • space.delegations.list() - List outgoing delegations");
  console.log("  • TinyCloudNode.createDelegation() - Create portable delegation");
  console.log("  • TinyCloudNode.useDelegation() - Use received delegation");
  console.log("  • node.sharing.generate() - Create V2 sharing link");
  console.log("  • node.sharing.receive() - Use V2 sharing link");
  console.log("  • node.ensurePublicSpace() - Lazy-create public space");
  console.log("  • TinyCloud.readPublicKey() - Unauthenticated public read");
  console.log();
  console.log("Not Yet Implemented on Server:");
  console.log("  • space.delegations.revoke() - Revoke delegation");
  console.log("  • spaces.list(), space.info() (needs tinycloud.space/*)");
  console.log();
}

// Run the demo
runDemo().catch((error) => {
  console.error();
  console.error("Demo Failed!");
  console.error("Error:", error.message || error);
  if (error.stack) {
    console.error("Stack:", error.stack);
  }
  console.error();
  console.error("Make sure the TinyCloud server is running at:", TINYCLOUD_URL);
  console.error("  cd repositories/tinycloud-node && cargo run");
  console.error();
  process.exit(1);
});
