import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileReplicaPurge, PrivateKeySigner, REPLICA_LOGOUT_PENDING_FILE } from "@tinycloud/node-sdk";
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

test("orphan replica writes refuse plain logout until explicit discard, then shred both credentials and root", async () => {
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
  const pendingDir = join(paths.dir, "replication", "unknown-child");
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, "pending.json"), "{uncertain local writes");
  const refused = await run(home, ["auth", "logout"]);
  expect(refused.exitCode).toBeGreaterThan(0);
  expect(refused.stderr).toContain("REPLICA_GATED");
  expect(refused.stderr).toContain("--discard-local-changes");
  expect(await readFile(paths.session)).toEqual(sessionBefore);
  expect(await readFile(key)).toEqual(keyBefore);
  expect(await readFile(join(pendingDir, "pending.json"), "utf8")).toContain("uncertain local writes");
  const discarded = await run(home, ["auth", "logout", "--discard-local-changes"]);
  expect(discarded.exitCode).toBe(0);
  await expect(readFile(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(pendingDir, "pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(paths.dir, REPLICA_LOGOUT_PENDING_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(paths.dir, "profile.json"), "utf8")).authSignedOut).toBe(true);
}, 30_000);
