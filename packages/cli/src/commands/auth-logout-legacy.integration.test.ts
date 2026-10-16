import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProfileReplicaPurge, PrivateKeySigner, REPLICA_LOGOUT_PENDING_FILE } from "@tinycloud/node-sdk";
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
    expect(networkPaths).toHaveLength(before);
    expect(await readGateSnapshot(paths.directory)).toEqual(gate);
    expect(await Bun.file(join(paths.directory, REPLICA_LOGOUT_PENDING_FILE)).exists()).toBe(false);
    await expectRetained(paths, session, key);
  }
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
  await expectRetained(paths, session, key);
  setMode("success");
  const retried = await run(home, ["auth", "logout", "--revoke", "--discard-local-changes"]);
  expect(retried.exitCode).toBe(0);
  expect(revokedCids).toEqual([sessionCid]);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.db)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(paths.unknown)).rejects.toMatchObject({ code: "ENOENT" });
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
