#!/usr/bin/env bun
/**
 * Gated live test: a RESTORED session resolves/rehydrates its TinyCloud
 * hosts and can do a real service call without re-running the wallet
 * sign-in flow.
 *
 * Proves the fix for "TinyCloud hosts have not been resolved. Call
 * signIn() first." on restored sessions:
 *   1. Owner signs in against a LOCAL tinycloud node (explicit host) and
 *      the session — including its `tinycloudHosts` — is persisted to disk.
 *   2. A FRESH TinyCloudNode (no explicit host, no signer wallet flow)
 *      restores that persisted session, threading the persisted hosts
 *      through restoreSession.
 *   3. The restored node does a real KV put/get against the same local
 *      node — proving the host was rehydrated from persistence and the
 *      restored session targets the right node without re-signing.
 *
 * Gated: set TC_LIVE_RESTORE=1 to run. Requires the local tinycloud
 * binary (built debug) — override path with TC_NODE_BIN.
 *
 *   TC_LIVE_RESTORE=1 bun run packages/node-sdk/scripts/live-restore-host-resolution.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENABLED = process.env.TC_LIVE_RESTORE === "1";
const NODE_BIN =
  process.env.TC_NODE_BIN ??
  "/Users/samgbafa/Documents/github/tinycloud-dev/repositories/tinycloud-node/target/debug/tinycloud";
const PORT = Number(process.env.TINYCLOUD_PORT ?? 9123);

if (!ENABLED) {
  process.stderr.write(
    "[skip] Set TC_LIVE_RESTORE=1 to run the restore host-resolution live test.\n",
  );
  process.exit(0);
}

const TINYCLOUD_TOML = `[global.keys]
type = "Static"
`;

async function waitForNode(host: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${host}/info`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Local tinycloud node at ${host} did not become ready.`);
}

async function main(): Promise<void> {
  const { TinyCloudNode } = await import("../src/index.ts");
  const { FileSessionStorage } = await import(
    "../src/storage/FileSessionStorage.ts"
  );

  const dataDir = await mkdtemp(join(tmpdir(), "tc-restore-host-data-"));
  const runDir = await mkdtemp(join(tmpdir(), "tc-restore-host-run-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "tc-restore-host-session-"));
  await writeFile(join(runDir, "tinycloud.toml"), TINYCLOUD_TOML, "utf8");

  const host = `http://localhost:${PORT}`;
  let child: ChildProcess | undefined;

  try {
    child = spawn(NODE_BIN, [], {
      cwd: runDir,
      env: {
        ...process.env,
        TINYCLOUD_LOG_LEVEL: "normal",
        TINYCLOUD_PORT: String(PORT),
        TINYCLOUD_STORAGE_DATADIR: dataDir,
        TINYCLOUD_CORS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (c) =>
      process.stderr.write(`[node] ${c.toString()}`),
    );

    await waitForNode(host);
    console.log(`[live] local tinycloud node ready at ${host}`);

    // A deterministic dev key (Hardhat account #0) so both nodes share an
    // address — restore is keyed by address.
    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    // --- PART 1: owner signs in (explicit local host) and persists ---
    const ownerStorage = new FileSessionStorage(sessionDir);
    const owner = new TinyCloudNode({
      privateKey,
      host, // explicit local host
      autoCreateSpace: true,
      sessionStorage: ownerStorage,
    });
    await owner.signIn();
    const address = owner.address!;
    console.log(`[live] owner signed in: ${address}`);

    const persisted = await ownerStorage.load(address);
    if (!persisted) throw new Error("Owner session was not persisted.");
    if (!persisted.tinycloudHosts || persisted.tinycloudHosts.length === 0) {
      throw new Error(
        "FAIL: persisted session is missing tinycloudHosts (persist step broken).",
      );
    }
    if (persisted.tinycloudHosts[0] !== host) {
      throw new Error(
        `FAIL: persisted host mismatch. Expected ${host}, got ${persisted.tinycloudHosts[0]}.`,
      );
    }
    console.log(
      `[live] persisted tinycloudHosts = ${JSON.stringify(persisted.tinycloudHosts)}`,
    );

    // Write a value as the owner so the restored session can read it.
    const key = `restore-proof-${Date.now()}`;
    const value = `value-${Math.random().toString(36).slice(2)}`;
    const putOwner = await owner.kv.put(key, value);
    if (!putOwner.ok) {
      throw new Error(
        `Owner kv.put failed: ${putOwner.error.code} ${putOwner.error.message}`,
      );
    }

    // --- PART 2: fresh node restores WITHOUT explicit host or wallet ---
    // No `host`, no `privateKey` — purely session-only restore. This is the
    // exact shape that triggered "hosts have not been resolved".
    const restored = new TinyCloudNode({});

    const data = persisted;
    if (!data.tinycloudSession) {
      throw new Error("Persisted session missing tinycloudSession.");
    }
    await restored.restoreSession({
      delegationHeader: data.tinycloudSession.delegationHeader,
      delegationCid: data.tinycloudSession.delegationCid,
      spaceId: data.tinycloudSession.spaceId,
      jwk: JSON.parse(data.sessionKey),
      verificationMethod: data.tinycloudSession.verificationMethod,
      address: data.address,
      chainId: data.chainId,
      siwe: data.siwe,
      signature: data.signature,
      tinycloudHosts: data.tinycloudHosts, // the fix: thread persisted hosts
    });

    console.log(`[live] restored node hosts = ${JSON.stringify(restored.hosts)}`);
    if (!restored.hosts.includes(host)) {
      throw new Error(
        `FAIL: restored node did not rehydrate the local host. hosts=${JSON.stringify(restored.hosts)}`,
      );
    }

    // --- PART 3: real service call on the restored session ---
    const getRestored = await restored.kv.get(key);
    if (!getRestored.ok) {
      throw new Error(
        `FAIL: restored kv.get failed (likely 'hosts not resolved' or wrong host): ${getRestored.error.code} ${getRestored.error.message}`,
      );
    }
    const readValue = getRestored.data.data;
    if (readValue !== value) {
      throw new Error(
        `FAIL: restored kv.get returned wrong value. Expected ${value}, got ${String(readValue)}.`,
      );
    }

    console.log(
      `[live] PASS: restored session read key=${key} value=${String(readValue)} ` +
        `with no re-sign-in and no 'hosts not resolved' error.`,
    );
    process.stdout.write(
      JSON.stringify({ ok: true, host, address, key }) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
}

await main();
