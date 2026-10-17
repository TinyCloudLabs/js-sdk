import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfigPath, profilePath, sessionPath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { establishSessionStamp, readGateSnapshot, REPLICA_DENY_FLOOR_FILE } from "@tinycloud/replica/profile-gate";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { REPLICA_LOGOUT_PENDING_FILE, sqliteReplicaStorage } from "@tinycloud/node-sdk";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";

// CONTRACT.md §2 "Sign-out and account switch": a floor-lagging gate is completed by the
// logout retry, another account's logout never touches the active account's state, and a
// restored older gate refuses with the profile-delete route.

const PROFILE = "owner";
const ACCOUNT_A = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const ACCOUNT_B = "did:pkh:eip155:1:0x0000000000000000000000000000000000000002";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const HOST = "https://node.example.test";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "logout", ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Account A owns the gate and one flag-owned partition (with a nonempty `pending.json`); the
 * profile also has a legacy `replicas/notes` mirror. The stored session belongs to `sessionOwner`.
 */
async function profileOwnedByA(home: string, sessionOwner: string) {
  return withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: HOST, chainId: 1, spaceName: "default", did: sessionOwner,
      ownerDid: sessionOwner, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: sessionOwner, delegationCid: "bafy-session" });
    const directory = profilePath(PROFILE);
    const key = join(directory, "key.json");
    await writeFile(key, "private-session-key");
    const stamp = await establishSessionStamp(directory, ACCOUNT_A, { siweIssuedAt: 1 });
    const replication = join(directory, "replication");
    const storage = sqliteReplicaStorage({
      dir: replication,
      guard: (section) => withProfileLock(PROFILE, section, { requireProfile: true }),
    });
    const identity = { host: HOST, space: SPACE, principal: ACCOUNT_A };
    const handle = await storage.open({
      identity, space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
      device: { did: "did:key:zTestDevice", jwk: { kty: "OKP" } },
      grantPolicy: { grantTtlMs: 86_400_000, consentAnchor: { at: Date.now() - 1_000, source: "siwe" } },
    });
    await handle.close();
    // A's unsynced local write: a nonempty pending index in A's identity partition.
    const [identityDir] = (await readdir(replication)).filter((name) => /^[a-z2-7]{26}$/.test(name));
    await writeFile(join(replication, identityDir!, "pending.json"),
      JSON.stringify({ v: 2, identity, committedEpoch: 0, seq: 1, records: [{ state: "ambiguous" }] }));
    const legacy = join(directory, "replicas", "notes");
    const store = await SqliteReplicaStore.open(legacy, { create: true });
    await store.init({
      name: "notes", replicaId: "r-test", host: HOST, space: SPACE, prefix: "notes/",
      deviceDid: "did:key:zTestDevice", allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
    return { directory, session: sessionPath(PROFILE), key, replication, legacy, stamp };
  });
}

/** Every byte of the flag-owned tree, the gate and the deny floor. */
async function accountState(directory: string): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {};
  for (const name of [REPLICA_GATE_FILE, REPLICA_DENY_FLOOR_FILE]) {
    files[name] = await readFile(join(directory, name), "utf8").catch(() => null);
  }
  const root = join(directory, "replication");
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(directory.length)] = (await readFile(path)).toString("base64");
    }
  }
  return files;
}

test("a logout retry after a crash between the deny floor and gate writes completes the deny and clears credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-logout-floor-lag-"));
  homes.push(home);
  const paths = await profileOwnedByA(home, ACCOUNT_A);
  const gate = (await readGateSnapshot(paths.directory))!;
  // What an interrupted deny leaves: the floor committed, the gate never rewritten.
  await writeFile(join(paths.directory, REPLICA_DENY_FLOOR_FILE),
    JSON.stringify({ epoch: gate.lifecycleEpoch + 1, deniedAt: Date.now() }));

  const retried = await run(home, ["--discard-local-changes"]);
  expect(retried.exitCode, retried.stderr).toBe(0);
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readGateSnapshot(paths.directory)).toMatchObject({ principalHash: null, lifecycleEpoch: gate.lifecycleEpoch + 2 });
  await expect(stat(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.replication)).rejects.toMatchObject({ code: "ENOENT" });
});

test("another account's logout clears its own credentials and the legacy mirror and leaves A's state byte-identical", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-logout-other-account-"));
  homes.push(home);
  const paths = await profileOwnedByA(home, ACCOUNT_B);
  const before = await accountState(paths.directory);
  expect(Object.keys(before).some((name) => name.endsWith("pending.json"))).toBe(true);

  // No --discard-local-changes: A's nonempty pending state is not B's to approve.
  const loggedOut = await run(home);
  expect(loggedOut.exitCode, loggedOut.stderr).toBe(0);
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.legacy)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await accountState(paths.directory)).toEqual(before);
  const profile = JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8"));
  expect(profile).toMatchObject({ authSignedOut: true });
  expect(profile.legacyReplicaCleanup).toBeUndefined();
  // A's flag-owned replicas stay gated to A: B (or anyone else) cannot establish on them.
  await expect(establishSessionStamp(paths.directory, ACCOUNT_B, { siweIssuedAt: Date.now() }))
    .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "principal_mismatch" });
});

test("a crash after another account's credential removal erases the legacy mirror at startup", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-logout-other-replay-"));
  homes.push(home);
  const paths = await profileOwnedByA(home, ACCOUNT_B);
  const before = await accountState(paths.directory);
  // The state step 2 leaves: signed out with the legacy cleanup still recorded.
  await withTinyCloudStateRoot(home, async () => {
    const profile = JSON.parse(await readFile(profileConfigPath(PROFILE), "utf8"));
    await writeJsonAtomic(profileConfigPath(PROFILE), { ...profile, authSignedOut: true, legacyReplicaCleanup: true });
  });
  await rm(paths.session);
  await rm(paths.key);

  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, "auth", "status"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  await expect(stat(paths.legacy)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await accountState(paths.directory)).toEqual(before);
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).legacyReplicaCleanup).toBeUndefined();
});

test("a restored older gate under a bound logout marker refuses with the profile-delete route", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-logout-restored-gate-"));
  homes.push(home);
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: HOST, chainId: 1, spaceName: "default", did: ACCOUNT_A,
      ownerDid: ACCOUNT_A, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: ACCOUNT_A, delegationCid: "bafy-session" });
    const directory = profilePath(PROFILE);
    await establishSessionStamp(directory, ACCOUNT_A, { siweIssuedAt: 1 });
    await mkdir(join(directory, "replicas"), { recursive: true });
    return { directory, session: sessionPath(PROFILE) };
  });
  const olderGate = await readFile(join(paths.directory, REPLICA_GATE_FILE), "utf8");
  const busy = await SqliteReplicaStore.open(join(paths.directory, "replicas", "notes"), { create: true });
  await busy.init({
    name: "notes", replicaId: "r-test", host: HOST, space: SPACE, prefix: "notes/",
    deviceDid: "did:key:zTestDevice", allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
  });
  const lease = await busy.acquireSyncLease(60_000);
  try {
    // The busy mirror stops cleanup after the denial is bound and credentials are gone.
    expect((await run(home)).exitCode).toBeGreaterThan(0);
  } finally {
    await busy.releaseLease(lease!);
    await busy.close();
  }
  const marker = JSON.parse(await readFile(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE), "utf8"));
  expect(marker).toMatchObject({ v: 1, deniedEpoch: expect.any(Number) });
  await writeFile(join(paths.directory, REPLICA_GATE_FILE), olderGate);

  const refused = await run(home);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(JSON.parse(refused.stderr)).toMatchObject({ error: { code: "REPLICA_GATED" } });
  expect(refused.stderr).toContain("tc profile switch <other>");
  expect(refused.stderr).toContain("tc profile delete <name>");
  expect(JSON.parse(await readFile(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE), "utf8"))).toEqual(marker);
});
