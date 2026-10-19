import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { profileConfigPath, profilePath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

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

test("plain logout with no gate or replica roots durably bars implicit local-key reauthentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-null-marker-logout-"));
  homes.push(home);
  let networkRequests = 0;
  const node = Bun.serve({ port: 0, fetch() { networkRequests++; return new Response("unexpected", { status: 500 }); } });
  servers.push(node);
  const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
  const dir = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });
  const logout = await run(home, ["auth", "logout"]);
  expect(logout.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, "profile.json"), "utf8")).authSignedOut).toBe(true);
  await expect(readFile(join(dir, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(dir, "key.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const ordinary = await run(home, ["kv", "get", "notes/a"]);
  expect(ordinary.exitCode).toBeGreaterThan(0);
  expect(ordinary.stderr).toContain("AUTH_REQUIRED");
  expect(ordinary.stdout).not.toContain("notes/a");
  expect(networkRequests).toBe(0);
}, 30_000);

test("failed network-only revoke retains credentials, then successful retry shreds them and fences stored-key sign-in", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-null-marker-revoke-"));
  homes.push(home);
  const calls: string[] = [];
  let mode: "fail" | "success" = "fail";
  let sessionFile = "";
  let keyFile = "";
  const node = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    if (path === "/revoke" && request.method === "POST") {
      expect(await readFile(sessionFile, "utf8")).toContain("delegationCid");
      expect(await readFile(keyFile, "utf8")).toContain('"d"');
      const header = request.headers.get("authorization") ?? "";
      const signed = await parseSignedSiweCacao(header.replace(/^Bearer\s+/i, ""));
      const cid = signed.audience.replace(/^ucan:/, "");
      calls.push(cid);
      if (mode === "fail") return new Response("unavailable", { status: 503 });
      return Response.json({ cid, revoked: true });
    }
    return new Response("unexpected", { status: 404 });
  } });
  servers.push(node);
  const ownerDid = `did:pkh:eip155:1:${await new PrivateKeySigner(OWNER_KEY).getAddress()}`;
  const dir = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });
  sessionFile = join(dir, "session.json");
  keyFile = join(dir, "key.json");
  expect((await run(home, ["auth", "login", "--method", "local"])).exitCode).toBe(0);
  const session = JSON.parse(await readFile(sessionFile, "utf8")) as { delegationCid: string };
  const sessionBefore = await readFile(sessionFile);
  const keyBefore = await readFile(keyFile);
  const failed = await run(home, ["auth", "logout", "--revoke"]);
  expect(failed.exitCode).toBeGreaterThan(0);
  expect(failed.stderr).toContain("REVOCATION_FAILED");
  expect(await readFile(sessionFile)).toEqual(sessionBefore);
  expect(await readFile(keyFile)).toEqual(keyBefore);
  expect(JSON.parse(await readFile(join(dir, "profile.json"), "utf8")).authSignedOut).not.toBe(true);
  mode = "success";
  const revoked = await run(home, ["auth", "logout", "--revoke"]);
  expect(revoked.exitCode).toBe(0);
  expect(JSON.parse(revoked.stdout).revokedCids).toEqual([session.delegationCid]);
  expect(calls).toEqual([session.delegationCid, session.delegationCid]);
  await expect(readFile(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(keyFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(dir, "profile.json"), "utf8")).authSignedOut).toBe(true);
  const ordinary = await run(home, ["kv", "get", "notes/a"]);
  expect(ordinary.exitCode).toBeGreaterThan(0);
  expect(ordinary.stderr).toContain("AUTH_REQUIRED");
  expect(calls).toEqual([session.delegationCid, session.delegationCid]);
}, 30_000);
