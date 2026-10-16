import { afterEach, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProfileReplicaPurge, PrivateKeySigner, REPLICA_LOGOUT_PENDING_FILE } from "@tinycloud/node-sdk";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import { profileConfigPath, profilePath, sessionPath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { readGateSnapshot } from "@tinycloud/replica/profile-gate";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "tc858-v1-legacy-cli-"));
  homes.push(home);
  let nodeMode: "success" | "fail" = "success";
  let onRevocationReceipt: (() => Promise<void>) | undefined;
  const networkPaths: string[] = [];
  const revokedCids: string[] = [];
  let atRevoke: { session: boolean; key: boolean; replica: boolean; unknown: boolean } | undefined;
  let paths: { directory: string; session: string; key: string; db: string; unknown: string } | undefined;
  const node = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    networkPaths.push(path);
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    if (path === "/revoke" && request.method === "POST") {
      if (paths) atRevoke = {
        session: await Bun.file(paths.session).exists(), key: await Bun.file(paths.key).exists(),
        replica: await Bun.file(paths.db).exists(), unknown: await Bun.file(paths.unknown).exists(),
      };
      if (nodeMode === "fail") return new Response("node unavailable", { status: 503 });
      const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const signed = await parseSignedSiweCacao(authorization);
      const cid = signed.audience.startsWith("ucan:") ? signed.audience.slice("ucan:".length) : "";
      if (!cid) return new Response("exact CID owner proof required", { status: 403 });
      revokedCids.push(cid);
      await onRevocationReceipt?.();
      return Response.json({ cid, revoked: true });
    }
    return new Response("not found", { status: 404 });
  } });
  servers.push(node);
  const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
  paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const directory = profilePath(PROFILE);
    return {
      directory, session: sessionPath(PROFILE), key: join(directory, "key.json"),
      db: join(directory, "replicas", "notes", "replica.db"),
      unknown: join(directory, "replicas", "notes", "future-write.pending"),
    };
  });
  expect((await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"])).exitCode).toBe(0);
  const session = JSON.parse(await readFile(paths.session, "utf8")) as {
    delegationCid: string; spaceId: string; verificationMethod: string;
  };
  const store = await SqliteReplicaStore.open(join(paths.directory, "replicas", "notes"), { create: true });
  try {
    await store.init({
      name: "notes", replicaId: "r-test", host: node.url.origin, space: session.spaceId,
      prefix: "notes/", deviceDid: session.verificationMethod, allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
  } finally {
    await store.close();
  }
  expect(await Bun.file(paths.db).exists()).toBe(true);
  return {
    home, paths, sessionCid: session.delegationCid, networkPaths, revokedCids,
    setMode(value: "success" | "fail") { nodeMode = value; },
    setOnRevocationReceipt(callback: () => Promise<void>) { onRevocationReceipt = callback; },
    atRevoke() { return atRevoke; },
  };
}

async function addUnknown(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "unsynced future bytes");
}

async function expectRetained(paths: { session: string; key: string; db: string; unknown: string }, session: Buffer, key: Buffer) {
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await Bun.file(paths.db).exists()).toBe(true);
  expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
}

test("source-created legacy SQLite layout logs out normally without discard", async () => {
  const { home, paths } = await fixture();
  const logout = await run(home, ["auth", "logout"]);
  expect(logout.exitCode).toBe(0);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.db)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
}, 30_000);

test("plain logout overrides a failed remote revocation and ends the retained session", async () => {
  const { home, paths, networkPaths, setMode } = await fixture();
  setMode("fail");
  const failed = await run(home, ["auth", "logout", "--revoke"]);
  expect(failed.exitCode).toBeGreaterThan(0);
  expect(failed.stderr).toContain("REVOCATION_FAILED");
  expect(JSON.parse(await readFile(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE), "utf8")).remotePending).toBe(true);
  expect(await Bun.file(paths.session).exists()).toBe(true);
  expect(await Bun.file(paths.key).exists()).toBe(true);
  expect(await Bun.file(paths.db).exists()).toBe(true);
  const requestsBeforePlain = networkPaths.length;

  const plain = await run(home, ["auth", "logout"]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(networkPaths).toHaveLength(requestsBeforePlain);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.db)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
  await expect(readFile(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("plain logout retries a durable remote-abandoned marker after a pre-shred crash", async () => {
  const { home, paths, networkPaths, setMode } = await fixture();
  setMode("fail");
  expect((await run(home, ["auth", "logout", "--revoke"])).exitCode).toBeGreaterThan(0);
  const principal = JSON.parse(await readFile(paths.session, "utf8")).ownerDid as string;
  const purge = createProfileReplicaPurge({
    profileDir: paths.directory,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
  });
  const approval = await purge.preflightLogout({ principal });
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  expect(await purge.abandonRemoteLogout({ principal, approval })).toMatchObject({
    v: 1, remoteAbandoned: true,
  });
  expect(JSON.parse(await readFile(markerPath, "utf8")).remotePending).not.toBe(true);
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).not.toBe(true);
  for (const file of [paths.session, paths.key, paths.db]) expect(await Bun.file(file).exists()).toBe(true);
  const before = networkPaths.length;

  const retried = await run(home, ["auth", "logout"]);
  expect(retried.exitCode, retried.stderr).toBe(0);
  expect(networkPaths).toHaveLength(before);
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
  for (const file of [paths.session, paths.key, paths.db, markerPath]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30_000);

test("plain retry after remote abandonment retains credentials when an approved DB identity changes", async () => {
  const { home, paths, networkPaths, setMode } = await fixture();
  setMode("fail");
  expect((await run(home, ["auth", "logout", "--revoke"])).exitCode).toBeGreaterThan(0);
  const principal = JSON.parse(await readFile(paths.session, "utf8")).ownerDid as string;
  const purge = createProfileReplicaPurge({
    profileDir: paths.directory,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
  });
  await purge.abandonRemoteLogout({ principal, approval: await purge.preflightLogout({ principal }) });
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  const marker = await readFile(markerPath);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  await copyFile(paths.db, `${paths.db}.replacement`);
  await rename(`${paths.db}.replacement`, paths.db);
  const changedDb = await readFile(paths.db);
  const before = networkPaths.length;

  const refused = await run(home, ["auth", "logout"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("REPLICA_GATED");
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(changedDb);
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).not.toBe(true);
}, 30_000);

test("malformed durable logout marker refuses with a typed error before mutation or node I/O", async () => {
  const { home, paths, networkPaths } = await fixture();
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  await writeFile(markerPath, "{invalid marker json");
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const gate = await readGateSnapshot(paths.directory);
  const before = networkPaths.length;

  const refused = await run(home, ["auth", "logout"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("REPLICA_GATED");
  expect(refused.stderr).not.toContain("SyntaxError");
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath, "utf8")).toBe("{invalid marker json");
  expect(await readGateSnapshot(paths.directory)).toEqual(gate);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
}, 30_000);

test("a changed known SQLite inode needs a second explicit token before plain logout", async () => {
  const { home, paths, networkPaths, setMode } = await fixture();
  setMode("fail");
  expect((await run(home, ["auth", "logout", "--revoke"])).exitCode).toBeGreaterThan(0);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  const marker = await readFile(markerPath);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const originalInode = (await stat(paths.db, { bigint: true })).ino;
  const replacement = `${paths.db}.replacement`;
  await copyFile(paths.db, replacement);
  await rename(replacement, paths.db);
  expect((await stat(paths.db, { bigint: true })).ino).not.toBe(originalInode);
  const before = networkPaths.length;

  const refused = await run(home, ["auth", "logout"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  const token = refused.stderr.match(/--approve-inventory ([0-9a-f]{32})\b/)?.[1];
  expect(token).toBeDefined();
  const printedEntries = refused.stderr.match(/^Inventory approval entries: (.+)$/m)?.[1];
  expect(printedEntries).toBeDefined();
  expect(JSON.parse(printedEntries!)).toContainEqual(expect.objectContaining({
    path: "replicas/notes/replica.db", kind: "file", dev: expect.any(String), ino: expect.any(String),
  }));
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);

  const confirmed = await run(home, ["auth", "logout", "--discard-local-changes", "--approve-inventory", token!]);
  expect(confirmed.exitCode, confirmed.stderr).toBe(0);
  expect(networkPaths).toHaveLength(before);
  for (const file of [paths.session, paths.key, paths.db, markerPath]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
  expect((await run(home, ["auth", "logout", "--discard-local-changes", "--approve-inventory", token!])).exitCode)
    .toBeGreaterThan(0);
}, 30_000);

test("changed inventory before plain override leaves failed remote logout retryable", async () => {
  const { home, paths, networkPaths, setMode } = await fixture();
  await addUnknown(paths.unknown);
  const flagPath = join(paths.directory, "replication", "future-flag.pending");
  await addUnknown(flagPath);
  setMode("fail");
  const failed = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(failed.exitCode).toBeGreaterThan(0);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  const marker = await readFile(markerPath);
  expect(JSON.parse(marker.toString()).remotePending).toBe(true);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const latePath = join(dirname(paths.unknown), "late-write.pending");
  await addUnknown(latePath);
  const before = networkPaths.length;
  const withoutDiscard = await run(home, ["auth", "logout"]);
  expect(withoutDiscard.exitCode).toBeGreaterThan(0);
  expect(withoutDiscard.stderr).toContain("late-write.pending");
  expect(withoutDiscard.stderr).toMatch(/--approve-inventory [0-9a-f]{32}\b/);
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(flagPath, "utf8")).toBe("unsynced future bytes");

  const refused = await run(home, ["auth", "logout", "--discard-local-changes"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("late-write.pending");
  const printedEntries = refused.stderr.match(/^Inventory approval entries: (.+)$/m)?.[1];
  expect(printedEntries).toBeDefined();
  const boundEntries = JSON.parse(printedEntries!) as Array<{ path: string; kind: string; dev: string; ino: string }>;
  expect(boundEntries).toContainEqual(expect.objectContaining({
    path: "replicas/notes/replica.db", kind: "file", dev: expect.any(String), ino: expect.any(String),
  }));
  expect(boundEntries).toContainEqual(expect.objectContaining({
    path: "replicas/notes/late-write.pending", kind: "file", dev: expect.any(String), ino: expect.any(String),
  }));
  expect(boundEntries).toContainEqual(expect.objectContaining({
    path: "replication/future-flag.pending", kind: "file", dev: expect.any(String), ino: expect.any(String),
  }));
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
  expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
  expect(await readFile(latePath, "utf8")).toBe("unsynced future bytes");
  expect(await readFile(flagPath, "utf8")).toBe("unsynced future bytes");
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).not.toBe(true);
  const token = refused.stderr.match(/--approve-inventory ([0-9a-f]{32})\b/)?.[1];
  expect(token).toBeDefined();
  const secondLatePath = join(dirname(paths.unknown), "still-later.pending");
  await addUnknown(secondLatePath);
  const stale = await run(home, ["auth", "logout", "--discard-local-changes", "--approve-inventory", token!]);
  expect(stale.exitCode).toBeGreaterThan(0);
  expect(stale.stderr).toContain("still-later.pending");
  const freshToken = stale.stderr.match(/--approve-inventory ([0-9a-f]{32})\b/)?.[1];
  expect(freshToken).toMatch(/^[0-9a-f]{32}$/);
  expect(freshToken).not.toBe(token);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(networkPaths).toHaveLength(before);

  const confirmed = await run(home, ["auth", "logout", "--discard-local-changes", "--approve-inventory", freshToken!]);
  expect(confirmed.exitCode, confirmed.stderr).toBe(0);
  expect(networkPaths).toHaveLength(before);
  for (const file of [paths.session, paths.key, paths.db, paths.unknown, flagPath, latePath, secondLatePath, markerPath]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
  const reused = await run(home, ["auth", "logout", "--discard-local-changes", "--approve-inventory", freshToken!]);
  expect(reused.exitCode).toBeGreaterThan(0);
  expect(networkPaths).toHaveLength(before);
}, 30_000);

test("inventory approval requires both a token and explicit discard consent", async () => {
  const { home, paths, networkPaths } = await fixture();
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const requestsBefore = networkPaths.length;
  for (const [args, message] of [
    [["auth", "logout", "--approve-inventory"], /--approve-inventory.*(requires|missing)/i],
    [["auth", "logout", "--approve-inventory", "0".repeat(32)], /--discard-local-changes/],
  ] as const) {
    const refused = await run(home, args);
    expect(refused.exitCode).toBeGreaterThan(0);
    expect(refused.stderr).toMatch(message);
    expect(await readFile(paths.session)).toEqual(session);
    expect(await readFile(paths.key)).toEqual(key);
    expect(await Bun.file(paths.db).exists()).toBe(true);
    expect(networkPaths).toHaveLength(requestsBefore);
  }
}, 30_000);

test("changed inventory after a failed revoke cannot send another CID", async () => {
  const { home, paths, networkPaths, setMode } = await fixture();
  await addUnknown(paths.unknown);
  setMode("fail");
  expect((await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"])).exitCode).toBeGreaterThan(0);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  const marker = await readFile(markerPath);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const latePath = join(dirname(paths.unknown), "late-write.pending");
  await addUnknown(latePath);
  const before = networkPaths.length;
  setMode("ok");

  const refused = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("late-write.pending");
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
  expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
  expect(await readFile(latePath, "utf8")).toBe("unsynced future bytes");
}, 30_000);

test("unexpected SQLite outbox refuses logout before a marker, credentials or node request", async () => {
  const { home, paths, networkPaths } = await fixture();
  const database = new Database(paths.db);
  try {
    database.exec("CREATE TABLE pending_outbox (id TEXT PRIMARY KEY, payload BLOB NOT NULL)");
    database.exec("INSERT INTO pending_outbox VALUES ('unsynced', X'01')");
  } finally {
    database.close();
  }
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const gate = await readGateSnapshot(paths.directory);
  const before = networkPaths.length;
  for (const args of [["auth", "logout"], ["auth", "logout", "--revoke"]]) {
    const refusal = await run(home, args);
    expect(refusal.exitCode).toBeGreaterThan(0);
    expect(refusal.stderr).toMatch(/--discard-local-changes|pending_outbox/);
    expect(networkPaths).toHaveLength(before);
    expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(false);
    expect(await readGateSnapshot(paths.directory)).toEqual(gate);
    expect(await readFile(paths.session)).toEqual(session);
    expect(await readFile(paths.key)).toEqual(key);
    expect(await readFile(paths.db)).toEqual(db);
  }
}, 30_000);

test("unknown legacy file refuses plain and online logout before marker, credentials, gate or node request", async () => {
  const { home, paths, networkPaths } = await fixture();
  await addUnknown(paths.unknown);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const gate = await readGateSnapshot(paths.directory);
  const before = networkPaths.length;
  for (const args of [["auth", "logout"], ["auth", "logout", "--revoke"]]) {
    const refusal = await run(home, args);
    expect(refusal.exitCode).toBeGreaterThan(0);
    expect(refusal.stderr).toContain("--discard-local-changes");
    expect(refusal.stderr).toContain("future-write.pending");
    const proposal = refusal.stderr.match(/^Local replica paths requiring explicit discard approval: (.+)$/m)?.[1];
    expect(proposal).toBeDefined();
    const inventory = JSON.parse(proposal!);
    const dbIdentity = await stat(paths.db, { bigint: true });
    const unknownIdentity = await stat(paths.unknown, { bigint: true });
    expect(inventory.knownEntries).toContainEqual({
      path: "replicas/notes/replica.db", kind: "file",
      dev: dbIdentity.dev.toString(), ino: dbIdentity.ino.toString(),
    });
    expect(inventory.knownRoots).toContainEqual(expect.objectContaining({
      path: "replicas/notes", kind: "directory", dev: expect.any(String), ino: expect.any(String),
    }));
    expect(inventory.unknownEntries).toContainEqual({
      path: "replicas/notes/future-write.pending", kind: "file",
      dev: unknownIdentity.dev.toString(), ino: unknownIdentity.ino.toString(),
    });
    expect(networkPaths).toHaveLength(before);
    expect(await readGateSnapshot(paths.directory)).toEqual(gate);
    expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(false);
    await expectRetained(paths, session, key);
  }
}, 30_000);

test("a DB-absent nonempty legacy child refuses online logout without changing user files", async () => {
  const { home, paths, networkPaths } = await fixture();
  const unrecognized = join(paths.directory, "replicas", "future", "payload.bin");
  await addUnknown(unrecognized);
  const [session, key, db, unknown, gate] = await Promise.all([
    readFile(paths.session), readFile(paths.key), readFile(paths.db),
    readFile(unrecognized), readGateSnapshot(paths.directory),
  ]);
  const before = networkPaths.length;

  const refusal = await run(home, ["auth", "logout", "--revoke"]);
  expect(refusal.exitCode).toBeGreaterThan(0);
  expect(refusal.stderr).toContain("--discard-local-changes");
  expect(networkPaths).toHaveLength(before);
  expect(await readGateSnapshot(paths.directory)).toEqual(gate);
  expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(false);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
  expect(await readFile(unrecognized)).toEqual(unknown);
}, 30_000);

test("explicit discard of unknown legacy files succeeds on plain logout", async () => {
  const { home, paths } = await fixture();
  await addUnknown(paths.unknown);
  expect((await run(home, ["auth", "logout", "--discard-local-changes"])).exitCode).toBe(0);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.db)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.unknown)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("discard plus online revoke retains all local files on 503 then erases only after exact-CID success", async () => {
  const { home, paths, sessionCid, networkPaths, revokedCids, atRevoke, setMode } = await fixture();
  await addUnknown(paths.unknown);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  setMode("fail");
  const failed = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(failed.exitCode).toBeGreaterThan(0);
  expect(failed.stderr).toContain("REVOCATION_FAILED");
  expect(networkPaths).toContain("/revoke");
  expect(atRevoke()).toEqual({ session: true, key: true, replica: true, unknown: true });
  expect((await readGateSnapshot(paths.directory))?.principalHash).toBeNull();
  expect(JSON.parse(await readFile(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE), "utf8")).remotePending).toBe(true);
  const requestsBeforeStatus = networkPaths.length;
  const blocked = await run(home, ["auth", "status"]);
  expect(blocked.exitCode).toBeGreaterThan(0);
  expect(blocked.stdout).not.toContain("unsynced future bytes");
  expect(networkPaths).toHaveLength(requestsBeforeStatus);
  await expectRetained(paths, session, key);
  setMode("success");
  const retried = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(retried.exitCode, retried.stderr).toBe(0);
  expect(revokedCids).toEqual([sessionCid]);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.db)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.unknown)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("corrupt-gate orphan revoke commits v2 marker before node receipt and never mints a replacement gate", async () => {
  const { home, paths, sessionCid, revokedCids, atRevoke, setOnRevocationReceipt } = await fixture();
  await addUnknown(paths.unknown);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  const gatePath = join(paths.directory, REPLICA_GATE_FILE);
  await writeFile(gatePath, "{corrupt");
  setOnRevocationReceipt(async () => {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(marker).toMatchObject({ v: 2, scope: "orphan_profile", remotePending: true });
    expect(marker.deniedEpoch).toBeUndefined();
    expect(marker.resumeToken).toBeUndefined();
    await expect(readFile(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Bun.file(paths.session).exists()).toBe(true);
    expect(await Bun.file(paths.key).exists()).toBe(true);
    expect(await Bun.file(paths.db).exists()).toBe(true);
  });

  const logout = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(logout.exitCode, logout.stderr).toBe(0);
  expect(atRevoke()).toEqual({ session: true, key: true, replica: true, unknown: true });
  expect(revokedCids).toEqual([sessionCid]);
  for (const file of [paths.session, paths.key, paths.db, paths.unknown, markerPath, gatePath]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
}, 30_000);

test("corrupt-gate orphan revoke failure keeps the remote-pending marker and all retry credentials", async () => {
  const { home, paths, sessionCid, networkPaths, revokedCids, setMode } = await fixture();
  await addUnknown(paths.unknown);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  const gatePath = join(paths.directory, REPLICA_GATE_FILE);
  await writeFile(gatePath, "{corrupt");
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  setMode("fail");

  const refused = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("REVOCATION_FAILED");
  expect(networkPaths).toContain("/revoke");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  expect(marker).toMatchObject({ v: 2, scope: "orphan_profile", remotePending: true });
  expect(marker.deniedEpoch).toBeUndefined();
  expect(marker.resumeToken).toBeUndefined();
  await expect(readFile(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
  expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
  const blocked = await run(home, ["auth", "status"]);
  expect(blocked.exitCode).toBeGreaterThan(0);
  expect(revokedCids).toEqual([]);

  setMode("success");
  const retried = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(retried.exitCode, retried.stderr).toBe(0);
  expect(revokedCids).toEqual([sessionCid]);
  for (const file of [paths.session, paths.key, paths.db, paths.unknown, markerPath, gatePath]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30_000);

test("crash after v2 marker fsync keeps a corrupt gate and refuses a direct retry until repaired", async () => {
  const { home, paths, networkPaths } = await fixture();
  await addUnknown(paths.unknown);
  const principal = JSON.parse(await readFile(paths.session, "utf8")).ownerDid as string;
  const gatePath = join(paths.directory, REPLICA_GATE_FILE);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  await writeFile(gatePath, "{corrupt original gate");
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const gateBytes = await readFile(gatePath);
  const before = networkPaths.length;
  const interrupted = createProfileReplicaPurge({
    profileDir: paths.directory,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
    dirSync: async (path) => {
      const directory = await open(path, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      throw new Error("simulated interruption after logout marker fsync");
    },
  });
  const approval = await interrupted.preflightLogout({ principal, discardLocalChanges: true });
  await expect(interrupted.prepareLogoutPending({ principal, approval, discardLocalChanges: true }))
    .rejects.toThrow("simulated interruption");
  expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({ v: 2, scope: "orphan_profile" });
  expect(await readFile(gatePath)).toEqual(gateBytes);
  const marker = await readFile(markerPath);

  const refused = await run(home, ["auth", "logout", "--discard-local-changes"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("REPLICA_GATED");
  expect(refused.stderr).toMatch(/replica-gate\.json|corrupt gate.*(remove|resolve)/i);
  expect(networkPaths).toHaveLength(before);
  expect(await readFile(markerPath)).toEqual(marker);
  expect(await readFile(gatePath)).toEqual(gateBytes);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
  expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).not.toBe(true);

  await rm(gatePath);
  const resumed = await run(home, ["auth", "logout", "--discard-local-changes"]);
  expect(resumed.exitCode, resumed.stderr).toBe(0);
  expect(networkPaths).toHaveLength(before);
  for (const file of [paths.session, paths.key, paths.db, paths.unknown, markerPath, gatePath]) {
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
}, 30_000);

for (const replacement of ["corrupt", "valid"] as const)
  test(`online orphan revoke retains completed marker on late ${replacement} gate replacement`, async () => {
    const { home, paths, sessionCid, networkPaths, revokedCids, atRevoke, setOnRevocationReceipt } = await fixture();
    const gatePath = join(paths.directory, REPLICA_GATE_FILE);
    const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
    const originalGate = await readFile(gatePath);
    await writeFile(gatePath, "{initial-corrupt");
    let releaseBusy: (() => Promise<void>) | undefined;
    setOnRevocationReceipt(async () => {
      const store = await SqliteReplicaStore.open(dirname(paths.db), { create: false });
      await store.open();
      const lease = await store.acquireSyncLease(60_000);
      if (!lease) {
        await store.close();
        throw new Error("The online receipt must hold the legacy SQLite lease before cleanup.");
      }
      releaseBusy = async () => {
        await store.releaseLease(lease);
        await store.close();
      };
    });
    try {
      const incomplete = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
      expect(incomplete.exitCode).toBeGreaterThan(0);
      expect(incomplete.stderr).toContain("REPLICA_BUSY");
      expect(revokedCids).toEqual([sessionCid]);
      expect(atRevoke()).toEqual({ session: true, key: true, replica: true, unknown: false });
      expect(JSON.parse(await readFile(markerPath, "utf8")).remotePending).not.toBe(true);
      expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
      await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await Bun.file(paths.db).exists()).toBe(true);
    } finally {
      await releaseBusy?.();
    }

    const marker = await readFile(markerPath);
    const replacementBytes = replacement === "corrupt" ? Buffer.from("{replacement-corrupt") : originalGate;
    await writeFile(gatePath, replacementBytes);
    const requestsBefore = networkPaths.length;
    const refused = await run(home, ["auth", "status"]);
    expect(refused.exitCode).toBeGreaterThan(0);
    expect(refused.stderr).toContain(replacement === "corrupt" ? "gate_unavailable" : "stamp_stale");
    expect(networkPaths).toHaveLength(requestsBefore);
    expect(revokedCids).toEqual([sessionCid]);
    expect(await readFile(markerPath)).toEqual(marker);
    await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Bun.file(paths.db).exists()).toBe(true);
    expect(await readFile(gatePath)).toEqual(replacementBytes);
    if (replacement === "corrupt") {
      await addUnknown(paths.unknown);
      const reapproval = await run(home, ["auth", "logout", "--discard-local-changes"]);
      expect(reapproval.exitCode).toBeGreaterThan(0);
      expect(reapproval.stderr).toContain("replica-gate.json");
      expect(networkPaths).toHaveLength(requestsBefore);
      expect(await readFile(markerPath)).toEqual(marker);
      await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await Bun.file(paths.db).exists()).toBe(true);
      expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
      await rm(paths.unknown);
    }

    await rm(gatePath);
    const recovered = await run(home, ["auth", "status"]);
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    expect(networkPaths).toHaveLength(requestsBefore);
    for (const file of [paths.session, paths.key, paths.db, markerPath, gatePath]) {
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);

test("markerless deferred v1 gate refuses online revoke before node I/O and retains the owner session", async () => {
  const { home, paths, networkPaths } = await fixture();
  const principal = JSON.parse(await readFile(paths.session, "utf8")).ownerDid as string;
  const purge = createProfileReplicaPurge({
    profileDir: paths.directory,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
  });
  const denied = await purge.deny({ reason: "sign_out", principal }, { deferErase: true });
  expect(denied).toMatchObject({ status: "denied", resumeToken: expect.any(Object) });
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  expect(await Bun.file(markerPath).exists()).toBe(false);
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const before = networkPaths.length;

  const refused = await run(home, ["auth", "logout", "--revoke"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toMatch(/REPLICA_GATED|stamp_stale/i);
  expect(networkPaths).toHaveLength(before);
  expect(await Bun.file(markerPath).exists()).toBe(false);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
  expect((await readGateSnapshot(paths.directory))?.principalHash).toBeNull();
}, 30_000);

test("a sidecar-shaped approved unknown cannot become a source-owned SQLite file after remote receipt", async () => {
  if (process.platform !== "linux") return;
  const { home, paths, sessionCid, networkPaths, revokedCids, setOnRevocationReceipt } = await fixture();
  const sidecar = `${paths.db}-shm`;
  const outside = join(home, "outside-sentinel");
  await writeFile(outside, "outside-stays");
  await rm(sidecar, { force: true });
  await symlink(outside, sidecar);
  expect((await lstat(sidecar)).isSymbolicLink()).toBe(true);
  setOnRevocationReceipt(async () => {
    await rm(sidecar);
    await writeFile(sidecar, "replacement-sidecar");
  });

  const incomplete = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(incomplete.exitCode).toBeGreaterThan(0);
  expect(incomplete.stderr).toMatch(/cleanup incomplete|approval.*changed/i);
  expect(revokedCids).toEqual([sessionCid]);
  const markerPath = join(paths.directory, REPLICA_LOGOUT_PENDING_FILE);
  expect(JSON.parse(await readFile(markerPath, "utf8")).remotePending).not.toBe(true);
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(paths.db).exists()).toBe(true);
  expect((await lstat(sidecar)).isFile()).toBe(true);
  expect(await readFile(outside, "utf8")).toBe("outside-stays");

  const requestsBefore = networkPaths.length;
  const blocked = await run(home, ["auth", "status"]);
  expect(blocked.exitCode).toBeGreaterThan(0);
  expect(networkPaths).toHaveLength(requestsBefore);
  expect(await Bun.file(markerPath).exists()).toBe(true);
  expect(await Bun.file(paths.db).exists()).toBe(true);
}, 30_000);

test("a new unknown path after online success retains the marker and requires fresh approval without another revoke", async () => {
  const { home, paths, sessionCid, networkPaths, revokedCids, setOnRevocationReceipt } = await fixture();
  await addUnknown(paths.unknown);
  const latePath = join(dirname(paths.unknown), "late-write.pending");
  setOnRevocationReceipt(() => addUnknown(latePath));

  const incomplete = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(incomplete.exitCode).toBeGreaterThan(0);
  expect(incomplete.stderr).toMatch(/cleanup incomplete|approval.*changed/i);
  expect(revokedCids).toEqual([sessionCid]);
  expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(true);
  expect(JSON.parse(await readFile(join(paths.directory, "profile.json"), "utf8")).authSignedOut).toBe(true);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(paths.db).exists()).toBe(true);
  expect(await readFile(paths.unknown, "utf8")).toBe("unsynced future bytes");
  expect(await readFile(latePath, "utf8")).toBe("unsynced future bytes");

  const requestsBefore = networkPaths.length;
  const retried = await run(home, ["auth", "logout", "--discard-local-changes"]);
  expect(retried.exitCode, retried.stderr).toBe(0);
  expect(retried.stderr).toContain("late-write.pending");
  expect(networkPaths).toHaveLength(requestsBefore);
  expect(revokedCids).toEqual([sessionCid]);
  expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(false);
  await expect(readFile(paths.db)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.unknown)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(latePath)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("startup completes a pinned empty legacy child left after the database was unlinked under a durable v1 marker", async () => {
  const { home, paths } = await fixture();
  const ownerDid = JSON.parse(await readFile(paths.session, "utf8")).ownerDid as string;
  const purge = createProfileReplicaPurge({
    profileDir: paths.directory,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
  });
  expect(await purge.prepareLogoutPending({ principal: ownerDid })).toMatchObject({ v: 1 });
  const legacyDir = dirname(paths.db);
  for (const child of await readdir(legacyDir)) {
    await rm(join(legacyDir, child), { recursive: true, force: true });
  }
  expect(await readdir(legacyDir)).toEqual([]);
  const recovered = await run(home, ["auth", "status"]);
  expect(recovered.exitCode).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({ authenticated: false, hasKey: false });
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(legacyDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("startup refuses a corrupt gate without a logout marker before network restore or local byte delivery", async () => {
  const { home, paths, networkPaths } = await fixture();
  const session = await readFile(paths.session);
  const key = await readFile(paths.key);
  const db = await readFile(paths.db);
  const requestsBefore = networkPaths.length;
  await writeFile(join(paths.directory, REPLICA_GATE_FILE), "{invalid gate json");
  expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(false);

  const status = await run(home, ["auth", "status"]);
  expect(status.exitCode).toBeGreaterThan(0);
  expect(status.stdout).not.toContain("private replica value");
  expect(status.stderr).toMatch(/gate_unavailable|REPLICA_GATED|REPLICA_PURGE_FAILED/);
  expect(networkPaths).toHaveLength(requestsBefore);
  expect(await readFile(paths.session)).toEqual(session);
  expect(await readFile(paths.key)).toEqual(key);
  expect(await readFile(paths.db)).toEqual(db);
}, 30_000);
