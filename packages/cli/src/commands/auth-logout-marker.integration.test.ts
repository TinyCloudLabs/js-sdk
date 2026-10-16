import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileReplicaPurge, PrivateKeySigner, REPLICA_LOGOUT_PENDING_FILE } from "@tinycloud/node-sdk";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { profileConfigPath, profilePath, sessionPath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { readGateSnapshot } from "@tinycloud/replica/profile-gate";

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

test("a crash immediately after durable marker write removes both credentials before status can report a session", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-logout-marker-cli-"));
  homes.push(home);
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response("not found", { status: 404 });
  } });
  servers.push(node);
  const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return { dir: profilePath(PROFILE), session: sessionPath(PROFILE) };
  });
  expect((await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"])).exitCode).toBe(0);
  const key = join(paths.dir, "key.json");
  const marker = join(paths.dir, REPLICA_LOGOUT_PENDING_FILE);
  const guard = <T>(section: () => Promise<T>): Promise<T> =>
    withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true }));
  const purge = createProfileReplicaPurge({ profileDir: paths.dir, guard });
  expect(await purge.prepareLogoutPending({ principal: ownerDid })).toMatchObject({ v: 1, principalHash: expect.any(String) });
  expect(await readFile(paths.session, "utf8")).toContain("delegationCid");
  expect(await readFile(key, "utf8")).toContain('"d"');
  expect(await readFile(marker, "utf8")).toContain("principalHash");

  const status = await run(home, ["auth", "status"]);
  expect(status.exitCode).toBe(0);
  const report = JSON.parse(status.stdout) as { authenticated: boolean; hasKey: boolean };
  expect(report).toMatchObject({ authenticated: false, hasKey: false });
  await expect(readFile(paths.session, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(key, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readGateSnapshot(paths.dir))?.principalHash).toBeNull();
}, 30_000);

test("orphan v2 marker refuses a corrupt replacement gate before credential or legacy cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-orphan-replacement-cli-"));
  homes.push(home);
  const networkPaths: string[] = [];
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    networkPaths.push(path);
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response("not found", { status: 404 });
  } });
  servers.push(node);
  const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const dir = profilePath(PROFILE);
    return {
      dir, session: sessionPath(PROFILE), key: join(dir, "key.json"),
      db: join(dir, "replicas", "notes", "replica.db"),
      marker: join(dir, REPLICA_LOGOUT_PENDING_FILE), gate: join(dir, "replica-gate.json"),
    };
  });
  expect((await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"])).exitCode).toBe(0);
  const session = JSON.parse(await readFile(paths.session, "utf8")) as { spaceId: string; verificationMethod: string };
  const store = await SqliteReplicaStore.open(join(paths.dir, "replicas", "notes"), { create: true });
  try {
    await store.init({
      name: "notes", replicaId: "r-test", host: node.url.origin, space: session.spaceId,
      prefix: "notes/", deviceDid: session.verificationMethod, allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
  } finally {
    await store.close();
  }
  await writeFile(paths.gate, "{original-corrupt");
  const purge = createProfileReplicaPurge({
    profileDir: paths.dir,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
  });
  const approval = await purge.preflightLogout({ principal: ownerDid, discardLocalChanges: true });
  expect(await purge.prepareLogoutPending({ principal: ownerDid, approval, discardLocalChanges: true }))
    .toMatchObject({ v: 2, scope: "orphan_profile" });
  await expect(readFile(paths.gate)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(paths.gate, "{replacement-corrupt");
  const marker = await readFile(paths.marker);
  const sessionBefore = await readFile(paths.session);
  const keyBefore = await readFile(paths.key);
  const dbBefore = await readFile(paths.db);
  const requestsBefore = networkPaths.length;

  const refused = await run(home, ["auth", "status"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toMatch(/REPLICA_GATED|gate_unavailable/i);
  expect(networkPaths).toHaveLength(requestsBefore);
  expect(await readFile(paths.marker)).toEqual(marker);
  expect(await readFile(paths.session)).toEqual(sessionBefore);
  expect(await readFile(paths.key)).toEqual(keyBefore);
  expect(await readFile(paths.db)).toEqual(dbBefore);
  expect(await readFile(paths.gate, "utf8")).toBe("{replacement-corrupt");
  expect(JSON.parse(await readFile(join(paths.dir, "profile.json"), "utf8")).authSignedOut).not.toBe(true);

  await rm(paths.gate);
  const recovered = await run(home, ["auth", "status"]);
  expect(recovered.exitCode, recovered.stderr).toBe(0);
  expect(networkPaths).toHaveLength(requestsBefore);
  for (const path of [paths.marker, paths.session, paths.key, paths.db, paths.gate]) {
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(JSON.parse(await readFile(join(paths.dir, "profile.json"), "utf8")).authSignedOut).toBe(true);
}, 30_000);

for (const layout of ["unknown-child", "missing-pending"] as const) test(
  `orphan ${layout} refuses plain logout until explicit discard, then shreds both credentials and root`,
  async () => {
    const home = await mkdtemp(join(tmpdir(), "tc858-orphan-logout-cli-"));
    homes.push(home);
    const node = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
      if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
      return new Response("not found", { status: 404 });
    } });
    servers.push(node);
    const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
    const paths = await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(PROFILE), {
        name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
        ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      return { dir: profilePath(PROFILE), session: sessionPath(PROFILE) };
    });
    expect((await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"])).exitCode).toBe(0);
    const key = join(paths.dir, "key.json");
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(key);
    await rm(join(paths.dir, "replica-gate.json"));
    const pendingDir = layout === "missing-pending"
      ? join(paths.dir, "replication", "a".repeat(26))
      : join(paths.dir, "replication", "unknown-child");
    await mkdir(pendingDir, { recursive: true });
    const uncertain = layout === "missing-pending" ? join(pendingDir, "identity.json") : join(pendingDir, "pending.json");
    await writeFile(uncertain, layout === "missing-pending"
      ? JSON.stringify({ host: node.url.origin, space: `tinycloud:pkh:eip155:1:${ownerDid.split(":").at(-1)}:default`, principal: ownerDid })
      : "{uncertain local writes");
    const refused = await run(home, ["auth", "logout"]);
    expect(refused.exitCode).toBeGreaterThan(0);
    expect(refused.stderr).toContain("REPLICA_GATED");
    expect(refused.stderr).toContain("--discard-local-changes");
    expect(await readFile(paths.session)).toEqual(sessionBefore);
    expect(await readFile(key)).toEqual(keyBefore);
    expect(await readFile(uncertain, "utf8")).toContain(layout === "missing-pending" ? ownerDid : "uncertain local writes");
    const discarded = await run(home, ["auth", "logout", "--discard-local-changes"]);
    expect(discarded.exitCode).toBe(0);
    await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(uncertain)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(paths.dir, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(paths.dir, "profile.json"), "utf8")).authSignedOut).toBe(true);
  }, 30_000,
);

test("inactive gate marker survives credential-unlink crash and recovers legacy data before reopening profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-inactive-logout-cli-"));
  homes.push(home);
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response("not found", { status: 404 });
  } });
  servers.push(node);
  const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return { dir: profilePath(PROFILE), session: sessionPath(PROFILE) };
  });
  expect((await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"])).exitCode).toBe(0);
  const legacyDir = join(paths.dir, "replicas", "notes");
  const legacy = join(legacyDir, "replica.db");
  const key = join(paths.dir, "key.json");
  const session = JSON.parse(await readFile(paths.session, "utf8")) as { spaceId: string; verificationMethod: string };
  const store = await SqliteReplicaStore.open(legacyDir, { create: true });
  try {
    await store.init({
      name: "notes", replicaId: "r-test", host: node.url.origin, space: session.spaceId,
      prefix: "notes/", deviceDid: session.verificationMethod, allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
  } finally {
    await store.close();
  }
  const purge = createProfileReplicaPurge({
    profileDir: paths.dir,
    guard: <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true })),
  });
  expect((await purge.deny({ reason: "sign_out", principal: ownerDid })).status).toBe("denied");
  const approval = await purge.preflightLogout({ principal: ownerDid });
  expect(await purge.prepareLogoutPending({ principal: ownerDid, approval }))
    .toMatchObject({ v: 3, scope: "inactive_gate" });
  expect(await readFile(paths.session, "utf8")).toContain("delegationCid");
  expect(await readFile(key, "utf8")).toContain('"d"');
  const deniedRead = await run(home, ["replica", "get", "notes/a"]);
  expect(deniedRead.exitCode).toBeGreaterThan(0);
  expect(deniedRead.stderr).toContain("REPLICA_GATED");
  expect(deniedRead.stdout).not.toContain("ciphertext");
  const status = await run(home, ["auth", "status"]);
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ authenticated: false, hasKey: false });
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(paths.dir, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(paths.dir, "profile.json"), "utf8")).authSignedOut).toBe(true);
}, 30_000);
