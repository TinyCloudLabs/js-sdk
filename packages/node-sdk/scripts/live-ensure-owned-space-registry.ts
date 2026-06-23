#!/usr/bin/env bun
/**
 * Gated live test: `ensureOwnedSpaceHosted` consults the account spaces
 * registry FIRST and only hosts (the host-SIWE delegation) when the owned
 * space is not already registered/hosted.
 *
 * Proves the redundant-host-prompt fix end-to-end against a LOCAL tinycloud
 * node:
 *   1. A manifest-recap-limited owner signs in (no full-authority auto-host
 *      of `secrets`). The underlying `auth.hostOwnedSpace` is wrapped with a
 *      call counter so we can observe whether a host-SIWE delegation is
 *      submitted.
 *   2. First `ensureOwnedSpaceHosted("secrets")` finds the space ABSENT from
 *      the registry → hosts it (host count goes 0 → 1) and best-effort
 *      registers it under `account/spaces/{id}`. A scoped `secrets.put`
 *      succeeds.
 *   3. Second `ensureOwnedSpaceHosted("secrets")` finds the space PRESENT in
 *      the registry → returns WITHOUT hosting (host count stays 1: no second
 *      SIWE). A scoped `secrets.put` still succeeds.
 *
 * Gated: set TC_LIVE_ENSURE_REGISTRY=1 to run. Requires the local tinycloud
 * binary (built debug) — override path with TC_NODE_BIN.
 *
 *   TC_LIVE_ENSURE_REGISTRY=1 bun run \
 *     packages/node-sdk/scripts/live-ensure-owned-space-registry.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENABLED = process.env.TC_LIVE_ENSURE_REGISTRY === "1";
const NODE_BIN =
  process.env.TC_NODE_BIN ??
  "/Users/samgbafa/Documents/github/tinycloud-dev/repositories/tinycloud-node/target/debug/tinycloud";
const PORT = Number(process.env.TINYCLOUD_PORT ?? 9137);

if (!ENABLED) {
  process.stderr.write(
    "[skip] Set TC_LIVE_ENSURE_REGISTRY=1 to run the ensureOwnedSpaceHosted registry live test.\n",
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

  const dataDir = await mkdtemp(join(tmpdir(), "tc-ensure-reg-data-"));
  const runDir = await mkdtemp(join(tmpdir(), "tc-ensure-reg-run-"));
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

    // Deterministic dev key (Hardhat account #0).
    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    // A manifest-recap-limited owner: NO full-authority auto-host of `secrets`.
    // Grants secrets get/put and decrypt on the owner's default encryption
    // network; account-registry permissions are included by default so reading
    // `account/spaces/` needs no extra prompt.
    const networkId = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
    const owner = new TinyCloudNode({
      privateKey,
      host,
      manifest: {
        app_id: "com.tinycloud.ensure-registry-live",
        name: "Ensure Registry Live",
        defaults: false,
        secrets: {
          ENSURE_REGISTRY_PROOF: ["get", "put", "del", "list"],
        },
        permissions: [
          {
            service: "tinycloud.encryption",
            path: networkId,
            actions: ["tinycloud.encryption/decrypt"],
          },
        ],
      },
    });

    await owner.signIn();
    console.log(`[live] manifest-recap owner signed in: ${owner.address}`);

    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;

    // Wrap the underlying host-SIWE delegation call with a counter scoped to the
    // SECRETS space. (The account-registry space is hosted separately by the
    // registry plumbing and is not what `ensureOwnedSpaceHosted("secrets")`
    // should re-trigger.) Counting `secrets`-space host calls proves whether a
    // redundant host prompt occurs.
    const auth = (owner as any).auth;
    const realHostOwnedSpace = auth.hostOwnedSpace.bind(auth);
    let secretsHostCount = 0;
    auth.hostOwnedSpace = async (spaceId: string) => {
      if (spaceId === secretsSpaceId) {
        secretsHostCount += 1;
        console.log(
          `[live] auth.hostOwnedSpace(secrets) called (#${secretsHostCount})`,
        );
      } else {
        console.log(`[live] auth.hostOwnedSpace(other) called for ${spaceId}`);
      }
      return realHostOwnedSpace(spaceId);
    };

    // The owner is root of their own encryption network; create it so the
    // vault put can encrypt.
    await owner.ensureEncryptionNetwork("default");

    // --- PART 1: first ensure → space ABSENT → hosts (count 0 → 1) ---
    const firstId = await owner.ensureOwnedSpaceHosted("secrets");
    console.log(`[live] first ensureOwnedSpaceHosted => ${firstId}`);
    if (secretsHostCount !== 1) {
      throw new Error(
        `FAIL: expected exactly 1 secrets host after first ensure (space absent), got ${secretsHostCount}.`,
      );
    }

    const putOne = await owner.secrets.put("ENSURE_REGISTRY_PROOF", "value-one");
    if (!putOne.ok) {
      throw new Error(
        `FAIL: first scoped secrets.put failed: ${putOne.error.code} ${putOne.error.message}`,
      );
    }
    console.log(`[live] first scoped secrets.put OK`);

    // Sanity: the hosted secrets space must be discoverable through the exact
    // registry path `ensureOwnedSpaceHosted` consults — the recap-readable KV
    // record `account/spaces/{id}` (NOT `syncAccessible()`, which needs
    // `tinycloud.space/list`, a capability a manifest-recap session lacks).
    const record = await owner.account.spaces.get(firstId);
    if (!record.ok) {
      throw new Error(
        `FAIL: hosted secrets space ${firstId} was not found in the account registry (account/spaces) after hosting: ${record.error.code} ${record.error.message}`,
      );
    }
    console.log(`[live] secrets space present in registry (account/spaces)`);

    // --- PART 2: second ensure → space PRESENT → NO host (count stays 1) ---
    const secondId = await owner.ensureOwnedSpaceHosted("secrets");
    console.log(`[live] second ensureOwnedSpaceHosted => ${secondId}`);
    if (secondId !== firstId) {
      throw new Error(
        `FAIL: second ensure returned a different space id. ${secondId} !== ${firstId}`,
      );
    }
    if (secretsHostCount !== 1) {
      throw new Error(
        `FAIL: registry-registered space triggered a redundant secrets host (count ${secretsHostCount} !== 1) — the fix did not take effect.`,
      );
    }
    console.log(`[live] second ensure performed NO host (no redundant SIWE)`);

    const putTwo = await owner.secrets.put("ENSURE_REGISTRY_PROOF", "value-two");
    if (!putTwo.ok) {
      throw new Error(
        `FAIL: second scoped secrets.put failed: ${putTwo.error.code} ${putTwo.error.message}`,
      );
    }
    console.log(`[live] second scoped secrets.put OK`);

    console.log(
      `[live] PASS: hosted secrets once (count=${secretsHostCount}); registry hit avoided the second host; secrets.put worked both times.`,
    );
    process.stdout.write(
      JSON.stringify({ ok: true, host, spaceId: firstId, secretsHostCount }) +
        "\n",
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
  }
}

await main();
