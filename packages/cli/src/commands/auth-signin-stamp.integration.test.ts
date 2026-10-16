import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { restoreSessionStamp } from "@tinycloud/replica/profile-gate";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("fresh local sign-in persists its verified replica stamp beside the owner session", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-local-stamp-"));
  homes.push(home);
  let networkRequests = 0;
  const node = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      networkRequests++;
      if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
      if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
      return new Response(`Unsupported fake node request: ${request.method} ${path}`, { status: 404 });
    },
  });
  servers.push(node);
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return { directory: profilePath(PROFILE), session: sessionPath(PROFILE) };
  });
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "local", "--replication-prefix", "notes/"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  const session = JSON.parse(await readFile(paths.session, "utf8"));
  expect(session.ownerDid).toBe(ownerDid);
  expect(await restoreSessionStamp(paths.directory, ownerDid, session.replicaStamp)).toEqual(session.replicaStamp);
  const keyPath = join(paths.directory, "key.json");
  expect(JSON.parse(await readFile(keyPath, "utf8"))).toEqual(session.jwk);
  const logout = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "logout"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [, logoutStderr, logoutExit] = await Promise.all([
    new Response(logout.stdout).text(), new Response(logout.stderr).text(), logout.exited,
  ]);
  expect({ logoutExit, logoutStderr }).toMatchObject({ logoutExit: 0 });
  await expect(readFile(paths.session, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(keyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await withTinyCloudStateRoot(home, () => readFile(profileConfigPath(PROFILE), "utf8"))).authSignedOut).toBe(true);
  const beforeOrdinaryCommand = networkRequests;
  const ordinary = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "kv", "get", "notes/a"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [ordinaryStdout, ordinaryStderr, ordinaryExit] = await Promise.all([
    new Response(ordinary.stdout).text(), new Response(ordinary.stderr).text(), ordinary.exited,
  ]);
  expect(ordinaryExit).toBeGreaterThan(0);
  expect(ordinaryStderr).toContain("AUTH_REQUIRED");
  expect(ordinaryStdout).not.toContain("private replica value");
  expect(networkRequests).toBe(beforeOrdinaryCommand);
  await expect(readFile(paths.session, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(keyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const again = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "local", "--replication-prefix", "notes/"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [, againStderr, againExit] = await Promise.all([
    new Response(again.stdout).text(), new Response(again.stderr).text(), again.exited,
  ]);
  expect({ againExit, againStderr }).toMatchObject({ againExit: 0 });
  const nextSession = JSON.parse(await readFile(paths.session, "utf8"));
  const nextKey = JSON.parse(await readFile(keyPath, "utf8"));
  expect(nextSession.ownerDid).toBe(ownerDid);
  expect(nextSession.verificationMethod).not.toBe(session.verificationMethod);
  expect(nextKey).toEqual(nextSession.jwk);
  expect(await restoreSessionStamp(paths.directory, ownerDid, nextSession.replicaStamp)).toEqual(nextSession.replicaStamp);
  expect(JSON.parse(await withTinyCloudStateRoot(home, () => readFile(profileConfigPath(PROFILE), "utf8"))).authSignedOut).toBe(false);
});

test("a durable signed-out profile never exposes leftover key or session bytes through ProfileManager", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-signed-out-readers-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example", chainId: 1, spaceName: "default",
      did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      privateKey: OWNER_KEY, authSignedOut: true, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(join(profilePath(PROFILE), "key.json"), { d: "persisted private session key" });
    await writeJsonAtomic(sessionPath(PROFILE), { jwk: { d: "persisted private session key" } });
  });
  const { ProfileManager } = await import("../config/profiles.js");
  const path = await withTinyCloudStateRoot(home, () => Promise.resolve(profilePath(PROFILE)));
  expect(await readFile(join(path, "key.json"), "utf8")).toContain("persisted private session key");
  const [key, session] = await withTinyCloudStateRoot(home, () =>
    Promise.all([ProfileManager.getKey(PROFILE), ProfileManager.getSession(PROFILE)]));
  expect(key).toBeNull();
  expect(session).toBeNull();
  const status = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, "auth", "status"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(status.stdout).text(), new Response(status.stderr).text(), status.exited,
  ]);
  expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(stdout)).toMatchObject({ authenticated: false, hasKey: false });
  await expect(readFile(join(path, "key.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(path, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(path, "profile.json"), "utf8")).authSignedOut).toBe(true);
});
