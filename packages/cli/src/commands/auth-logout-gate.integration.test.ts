import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfigPath, profilePath, sessionPath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { establishSessionStamp, readGateSnapshot } from "@tinycloud/replica/profile-gate";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { createProfileReplicaPurge, REPLICA_LOGOUT_PENDING_FILE, sqliteReplicaStorage } from "@tinycloud/node-sdk";

const PROFILE = "owner";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const OTHER_PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000002";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string, args: string[] = [], replication = true) {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    ...(replication ? ["--replication"] : []), "auth", "logout", ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("keep-replicas refuses gated state before altering session, key, gate or either replica root", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-logout-keep-gated-"));
  homes.push(home);
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default",
      did: PRINCIPAL, ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, delegationCid: "bafy-session" });
    const directory = profilePath(PROFILE);
    await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
    const key = join(directory, "key.json");
    const legacy = join(directory, "replicas", "notes", "replica.db");
    const flag = join(directory, "replication", "identity", "replicas", "replica.db");
    await mkdir(join(directory, "replicas", "notes"), { recursive: true });
    await mkdir(join(directory, "replication", "identity", "replicas"), { recursive: true });
    await writeFile(key, "private-session-key");
    await writeFile(legacy, "legacy-private-bytes");
    await writeFile(flag, "flag-private-bytes");
    return { directory, session: sessionPath(PROFILE), key, legacy, flag };
  });
  const gate = await readGateSnapshot(paths.directory);
  const refused = await run(home, ["--keep-replicas"], false);
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr).toContain("INVALID_ARGUMENT");
  expect(await readFile(paths.session, "utf8")).toContain("bafy-session");
  expect(await readFile(paths.key, "utf8")).toBe("private-session-key");
  expect(await readFile(paths.legacy, "utf8")).toBe("legacy-private-bytes");
  expect(await readFile(paths.flag, "utf8")).toBe("flag-private-bytes");
  expect(await readGateSnapshot(paths.directory)).toEqual(gate);
});

test("keep-replicas preserves a legacy-only root while ending its stored session", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-logout-keep-legacy-"));
  homes.push(home);
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default",
      did: PRINCIPAL, ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, delegationCid: "bafy-session" });
    const legacy = join(profilePath(PROFILE), "replicas", "notes", "replica.db");
    await mkdir(join(profilePath(PROFILE), "replicas", "notes"), { recursive: true });
    await writeFile(legacy, "legacy-private-bytes");
    return { session: sessionPath(PROFILE), legacy };
  });
  const kept = await run(home, ["--keep-replicas"], false);
  expect(kept.exitCode).toBe(0);
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(paths.legacy, "utf8")).toBe("legacy-private-bytes");
});

test("plain logout durably denies reads and ends the session even when a replica is busy, then resumes cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-logout-gate-"));
  homes.push(home);
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default", did: PRINCIPAL,
      ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, spaceId: "default" });
    const directory = profilePath(PROFILE);
    await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
    return { directory, session: sessionPath(PROFILE), replica: join(directory, "replicas", "notes") };
  });
  const store = await SqliteReplicaStore.open(paths.replica, { create: true });
  await store.init({
    name: "notes", replicaId: "r-test", host: "https://node.example.test", space: "default", prefix: "notes/",
    deviceDid: "did:key:zTestDevice", allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
  });
  const lease = await store.acquireSyncLease(60_000);
  expect(lease).not.toBeNull();
  try {
    const busy = await run(home);
    expect(busy.exitCode).toBeGreaterThan(0);
    expect(busy.stderr).toContain("REPLICA_BUSY");
    await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readGateSnapshot(paths.directory))?.principalHash).toBeNull();
    expect(await stat(join(paths.replica, "replica.db"))).toBeTruthy();
  } finally {
    await store.releaseLease(lease!);
    await store.close();
  }

  const resumed = await run(home);
  expect(resumed.exitCode, resumed.stderr).toBe(0);
  await expect(stat(join(paths.replica, "replica.db"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a pending flag-owned erase fences an open handle and is retried after its lease releases", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-logout-pending-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default", did: PRINCIPAL,
      ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, spaceId: "default" });
    const directory = profilePath(PROFILE);
    const stamp = await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
    const replicationRoot = join(directory, "replication");
    const storage = sqliteReplicaStorage({
      dir: replicationRoot,
      guard: (section) => withProfileLock(PROFILE, section, { requireProfile: true }),
    });
    const handle = await storage.open({
      identity: { host: "https://node.example.test", space: SPACE, principal: PRINCIPAL },
      space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
      device: { did: "did:key:zTestDevice", jwk: { kty: "OKP" } },
      grantPolicy: { grantTtlMs: 86_400_000, consentAnchor: { at: Date.now() - 1_000, source: "siwe" } },
    });
    const replicaFile = (await readdir(replicationRoot, { recursive: true })).find((entry) => entry.endsWith("replica.db"));
    expect(replicaFile).toBeDefined();
    const store = await SqliteReplicaStore.open(join(replicationRoot, replicaFile!, ".."), { create: false });
    await store.open();
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    try {
      const pending = await run(home);
      expect(pending.exitCode).toBeGreaterThan(0);
      await expect(stat(sessionPath(PROFILE))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readGateSnapshot(directory))?.principalHash).toBeNull();
      await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
      expect(await stat(join(replicationRoot, replicaFile!))).toBeTruthy();
    } finally {
      await store.releaseLease(lease!);
      await store.close();
      await handle.close();
    }
    const resumed = await run(home);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    await expect(stat(join(replicationRoot, replicaFile!))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

type InterruptedLogout = "v1" | "v1-discard" | "v2" | "v3";

/**
 * A plain logout committed its marker (and, for v1, its gate denial), then
 * credential removal failed before `authSignedOut` was durable.
 */
async function interruptedLogout(home: string, kind: InterruptedLogout) {
  return withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default", did: PRINCIPAL,
      ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, spaceId: "default" });
    const directory = profilePath(PROFILE);
    await writeFile(join(directory, "key.json"), "private-session-key");
    const guard = <T>(section: () => Promise<T>) => withProfileLock(PROFILE, section, { requireProfile: true });
    const purge = createProfileReplicaPurge({ profileDir: directory, guard });
    const replicationRoot = join(directory, "replication");
    let replica: string;
    let approvedUnknown: string | undefined;
    if (kind === "v1" || kind === "v1-discard") {
      const stamp = await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
      const handle = await sqliteReplicaStorage({ dir: replicationRoot, guard }).open({
        identity: { host: "https://node.example.test", space: SPACE, principal: PRINCIPAL },
        space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
        device: { did: "did:key:zTestDevice", jwk: { kty: "OKP" } },
        grantPolicy: { grantTtlMs: 86_400_000, consentAnchor: { at: Date.now() - 1_000, source: "siwe" } },
      });
      await handle.close();
      const replicaFile = (await readdir(replicationRoot, { recursive: true })).find((entry) => entry.endsWith("replica.db"));
      expect(replicaFile).toBeDefined();
      replica = join(replicationRoot, replicaFile!);
      if (kind === "v1-discard") {
        approvedUnknown = join(replicationRoot, "unapproved.bin");
        await writeFile(approvedUnknown, "local-change");
      }
    } else {
      // v2: legacy data without any gate. v3: legacy data behind an inactive gate.
      if (kind === "v3") await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
      const legacyDir = join(directory, "replicas", "notes");
      const store = await SqliteReplicaStore.open(legacyDir, { create: true });
      try {
        await store.init({
          name: "notes", replicaId: "r-test", host: "https://node.example.test", space: "default", prefix: "notes/",
          deviceDid: "did:key:zTestDevice", allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
        });
      } finally {
        await store.close();
      }
      replica = join(legacyDir, "replica.db");
      if (kind === "v3") expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    }

    // The same facade sequence plain `auth logout` runs, with the credential
    // shred failing after the marker (and any v1 denial) commits.
    const discardLocalChanges = kind === "v1-discard";
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges });
    const marker = await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, discardLocalChanges });
    expect(marker).toMatchObject({ v: kind === "v2" ? 2 : kind === "v3" ? 3 : 1 });
    if (discardLocalChanges) {
      expect(marker).toMatchObject({ discardLocalChanges: true });
      expect(marker?.approvedUnknown.map(({ path }) => path)).toEqual(["replication/unapproved.bin"]);
    }
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); },
      eraseLegacyReplicas: async () => {},
    });
    expect(report.failed).toEqual([{ id: "logout", code: "EIO" }]);
    if (kind !== "v2") expect((await readGateSnapshot(directory))?.principalHash).toBeNull();
    expect(JSON.parse(await readFile(profileConfigPath(PROFILE), "utf8")).authSignedOut).toBeUndefined();
    expect(await readFile(join(directory, "key.json"), "utf8")).toBe("private-session-key");
    return {
      directory, replicationRoot, replica, approvedUnknown,
      marker: join(directory, REPLICA_LOGOUT_PENDING_FILE),
      session: join(directory, "session.json"), key: join(directory, "key.json"),
    };
  });
}

async function signedOut(directory: string): Promise<unknown> {
  return JSON.parse(await readFile(join(directory, "profile.json"), "utf8")).authSignedOut;
}

for (const kind of ["v1", "v2", "v3"] as const) {
  test(`plain logout retry completes a ${kind} logout whose credential shred failed before sign-out`, async () => {
    const home = await mkdtemp(join(tmpdir(), `tc841-cli-logout-retry-${kind}-`));
    homes.push(home);
    const paths = await interruptedLogout(home, kind);

    const retried = await run(home);
    expect(retried.exitCode, retried.stderr).toBe(0);
    for (const path of [paths.replica, paths.marker, paths.session, paths.key]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await signedOut(paths.directory)).toBe(true);
  });
}

test("plain logout retry honours the stored discard consent for the exact approved identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-cli-logout-retry-discard-"));
  homes.push(home);
  const paths = await interruptedLogout(home, "v1-discard");

  const retried = await run(home);
  expect(retried.exitCode, retried.stderr).toBe(0);
  for (const path of [paths.approvedUnknown!, paths.replica, paths.marker, paths.session, paths.key]) {
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await signedOut(paths.directory)).toBe(true);
});

test("plain logout retry refuses an approved discard path replaced by a new identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-cli-logout-retry-replaced-"));
  homes.push(home);
  const paths = await interruptedLogout(home, "v1-discard");
  // Write first, then rename over, so the replacement cannot reuse the inode.
  await writeFile(`${paths.approvedUnknown!}.new`, "replacement");
  await rename(`${paths.approvedUnknown!}.new`, paths.approvedUnknown!);

  const refused = await run(home);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(JSON.parse(refused.stderr).error).toMatchObject({
    code: "REPLICA_PURGE_FAILED", message: expect.stringContaining("(gate_unavailable)"),
  });
  expect(await readFile(paths.approvedUnknown!, "utf8")).toBe("replacement");
  expect(await stat(paths.replica)).toBeTruthy();
  expect(await stat(paths.marker)).toBeTruthy();
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await signedOut(paths.directory)).toBe(true);
});

test("plain logout retry shreds credentials but refuses an unapproved new replication path", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-cli-logout-retry-unknown-"));
  homes.push(home);
  const paths = await interruptedLogout(home, "v1");
  const unknown = join(paths.replicationRoot, "unapproved.bin");
  await writeFile(unknown, "local-change");

  const refused = await run(home);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(JSON.parse(refused.stderr).error).toMatchObject({
    code: "REPLICA_PURGE_FAILED", message: expect.stringContaining("(gate_unavailable)"),
  });
  // The committed denial is the durable approval: credentials go, local data stays.
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await signedOut(paths.directory)).toBe(true);
  expect(await readFile(unknown, "utf8")).toBe("local-change");
  expect(await stat(paths.replica)).toBeTruthy();
  expect(await stat(paths.marker)).toBeTruthy();
  expect((await readGateSnapshot(paths.directory))?.principalHash).toBeNull();
});

test("plain logout retry refuses a marker owned by a different session principal without touching anything", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc841-cli-logout-retry-principal-"));
  homes.push(home);
  const paths = await interruptedLogout(home, "v1");
  await writeFile(paths.session, JSON.stringify({ ownerDid: OTHER_PRINCIPAL, spaceId: "default" }));
  const before = await Promise.all([paths.session, paths.key, paths.marker, paths.replica]
    .map((path) => readFile(path)));
  const gate = await readGateSnapshot(paths.directory);

  const refused = await run(home);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(JSON.parse(refused.stderr).error).toMatchObject({ code: "REPLICA_GATED" });
  expect(await Promise.all([paths.session, paths.key, paths.marker, paths.replica]
    .map((path) => readFile(path)))).toEqual(before);
  expect(await readGateSnapshot(paths.directory)).toEqual(gate);
  expect(await signedOut(paths.directory)).toBeUndefined();
});
