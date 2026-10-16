import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { Replica, parseUcanGrant } from "@tinycloud/replica";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import {
  profileConfigPath,
  profilePath,
  sessionPath,
  withTinyCloudStateRoot,
  writeJsonAtomic,
} from "@tinycloud/operations/state";
import { FakeNode, owner, signUcan } from "../../../replica/test/fixtures.js";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function spawnCli(home: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  return Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

async function run(home: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawnCli(home, args);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function seed(home: string, host: string): Promise<{ db: string; session: string; key: string; delegationCid: string }> {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(OWNER_KEY);
  const address = await signer.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const spaceId = wasm.makeSpaceId(address, 1, "default");
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const sessionDid = manager.getDID("default");
  const prepared = wasm.prepareSession({
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  const completed = wasm.completeSessionSetup({ ...prepared, signature });
  const session = {
    ...completed, jwk, address, chainId: 1, spaceId, verificationMethod: sessionDid,
    siwe: prepared.siwe, signature, ownerDid,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host, chainId: 1, spaceName: "default", did: ownerDid,
      sessionDid, ownerDid, spaceId, posture: "local-owner-key", authMethod: "local",
      privateKey: OWNER_KEY, operatorType: "human", createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), session);
    const key = join(profilePath(PROFILE), "key.json");
    await writeJsonAtomic(key, jwk);
    const db = join(profilePath(PROFILE), "replicas", "notes", "replica.db");
    return { db, session: sessionPath(PROFILE), key };
  });

  const replicaDir = join(home, ".tinycloud", "profiles", PROFILE, "replicas", "notes");
  const store = await SqliteReplicaStore.open(replicaDir, { create: true });
  try {
    await store.init({
      name: "notes", replicaId: "r-test", host, space: spaceId, prefix: "notes/",
      deviceDid: sessionDid, allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.installGrant(parseUcanGrant(signUcan(owner, {
      aud: sessionDid.split("#", 1)[0], exp: Math.floor(Date.now() / 1000) + 3_600,
      att: { [`${spaceId}/kv/notes/`]: {
        "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}], "tinycloud.kv/sync": [{}],
      } },
      prf: ["bafyparent"],
    })));
    const fake = new FakeNode();
    fake.space = spaceId;
    fake.put("notes/a", "private replica value");
    await new Replica({ store, transport: fake }).sync();
  } finally {
    await store.close();
  }
  return { ...paths, delegationCid: session.delegationCid };
}

async function server(mode: "fail" | "hold" | "success", cid: () => string) {
  const requests: string[] = [];
  const snapshots: Array<{ session: boolean; db: boolean }> = [];
  const started = Promise.withResolvers<void>();
  let state = mode;
  let localPaths: { session: string; db: string } | undefined;
  const node = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/revoke" && request.method === "POST") {
        requests.push(request.headers.get("authorization") ?? "");
        if (localPaths) snapshots.push({
          session: await exists(localPaths.session), db: await exists(localPaths.db),
        });
        started.resolve();
        if (state === "hold") return new Promise<Response>(() => {});
        if (state === "fail") return new Response("node unavailable", { status: 503 });
        return Response.json({ cid: cid(), revoked: true });
      }
      if (path === "/healthz") return new Response("ok");
      if (path === "/info") return Response.json({ nodeId: "did:key:z6MkLocalNodeTc841" });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(node);
  return {
    host: node.url.origin,
    requests,
    snapshots,
    started: started.promise,
    setMode(value: "fail" | "hold" | "success") { state = value; },
    setPaths(paths: { session: string; db: string }) { localPaths = paths; },
    stop() { node.stop(true); servers.splice(servers.indexOf(node), 1); },
  };
}

async function expectDeniedButRetained(
  home: string,
  paths: { session: string; key: string; db: string },
  sessionBefore: Buffer,
  keyBefore: Buffer,
): Promise<void> {
  expect(await readFile(paths.session)).toEqual(sessionBefore);
  expect(await readFile(paths.key)).toEqual(keyBefore);
  expect(await exists(paths.db)).toBe(true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const denied = await run(home, ["replica", "get", "notes/a", "--replica", "notes", "--raw"]);
    expect(denied.exitCode).toBeGreaterThan(0);
    expect(denied.stdout).not.toContain("private replica value");
    expect(denied.stderr).toMatch(/denied|revoked|blocked/i);
    expect(await exists(paths.db)).toBe(true);
  }
  expect(await readFile(paths.session)).toEqual(sessionBefore);
  expect(await readFile(paths.key)).toEqual(keyBefore);
}

describe("tc auth logout --revoke with durable replica denial", () => {
  test("failed node revoke blocks local reads without erasing the session, key, or replica across restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-fail-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("fail", () => delegationCid);
    const paths = await seed(home, node.host);
    delegationCid = paths.delegationCid;
    node.setPaths(paths);
    const before = await run(home, ["replica", "get", "notes/a", "--replica", "notes", "--raw"]);
    expect(before).toMatchObject({ exitCode: 0, stdout: "private replica value" });
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);

    const failed = await run(home, ["auth", "logout", "--revoke"]);
    expect(failed.exitCode).toBeGreaterThan(0);
    expect(failed.stderr).toMatch(/revocation failed/i);
    expect(node.requests).toHaveLength(1);
    await expectDeniedButRetained(home, paths, sessionBefore, keyBefore);
  });

  test("offline revocation denies reads while keeping the session, key, and replica after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-offline-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("success", () => delegationCid);
    const paths = await seed(home, node.host);
    delegationCid = paths.delegationCid;
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    node.stop();

    const failed = await run(home, ["auth", "logout", "--revoke"]);
    expect(failed.exitCode).toBeGreaterThan(0);
    expect(failed.stderr).toMatch(/revocation failed/i);
    expect(node.requests).toEqual([]);
    await expectDeniedButRetained(home, paths, sessionBefore, keyBefore);
  });

  test("interrupted online revocation leaves durable denial, session, key, and files", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-interrupted-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("hold", () => delegationCid);
    const paths = await seed(home, node.host);
    delegationCid = paths.delegationCid;
    node.setPaths(paths);
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    const child = spawnCli(home, ["auth", "logout", "--revoke"]);
    try {
      await Promise.race([
        node.started,
        child.exited.then(() => { throw new Error("CLI exited before the online revoke request"); }),
      ]);
      expect(node.snapshots).toEqual([{ session: true, db: true }]);
    } finally {
      child.kill();
      await child.exited;
    }
    await expectDeniedButRetained(home, paths, sessionBefore, keyBefore);
  });

  test("a successful online retry revokes the CID before erasing the persisted replica", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-retry-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("fail", () => delegationCid);
    const paths = await seed(home, node.host);
    delegationCid = paths.delegationCid;
    node.setPaths(paths);

    expect((await run(home, ["auth", "logout", "--revoke"])).exitCode).toBeGreaterThan(0);
    expect(await exists(paths.db)).toBe(true);
    node.setMode("success");
    const retried = await run(home, ["auth", "logout", "--revoke"]);
    expect(retried.exitCode).toBe(0);
    expect(node.requests).toHaveLength(2);
    expect(node.snapshots).toEqual([
      { session: true, db: true },
      { session: true, db: true },
    ]);
    expect(await exists(paths.session)).toBe(false);
    expect(await exists(paths.db)).toBe(false);
  });
});
