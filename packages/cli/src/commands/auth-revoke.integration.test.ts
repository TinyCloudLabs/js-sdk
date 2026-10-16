import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileReplicaPurge, NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { Replica, parseUcanGrant } from "@tinycloud/replica";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { establishSessionStamp, restoreSessionStamp } from "@tinycloud/replica/profile-gate";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import {
  profileConfigPath,
  profilePath,
  sessionPath,
  withProfileLock,
  withTinyCloudStateRoot,
  writeJsonAtomic,
} from "@tinycloud/operations/state";
import { FakeNode, owner, signUcan } from "../../../replica/test/fixtures.js";
import { registerReplicaCommand } from "./replica.js";

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

async function seedLegacyReplica(home: string, host: string, spaceId: string, sessionDid: string): Promise<void> {
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
}

async function seed(home: string, host: string, authMethod: "local" | "openkey" = "local"): Promise<{ db: string; session: string; key: string; delegationCid: string; ownerDid: string; spaceId: string }> {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(OWNER_KEY);
  const address = await signer.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const spaceId = wasm.makeSpaceId(address, 1, "default");
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const sessionDid = manager.getDID("default");
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk,
    issuedAt,
    expirationTime: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  const completed = wasm.completeSessionSetup({ ...prepared, signature });
  const session = {
    ...completed, jwk, address, chainId: 1, spaceId, verificationMethod: sessionDid,
    siwe: prepared.siwe, signature, ownerDid,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  if (authMethod === "openkey") {
    // The fixture signs an owner session, but stores no owner wallet signer in this profile.
    const signed = await parseSignedSiweCacao(
      session.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), session.delegationCid,
    );
    expect(signed.issuer).toBe(ownerDid);
  }
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host, chainId: 1, spaceName: "default", did: ownerDid,
      sessionDid, ownerDid, spaceId, posture: authMethod === "local" ? "local-owner-key" : "owner-openkey",
      authMethod, ...(authMethod === "local" ? { privateKey: OWNER_KEY } : {}),
      operatorType: "human", createdAt: "2026-10-01T00:00:00.000Z",
    });
    const replicaStamp = await withProfileLock(PROFILE,
      () => establishSessionStamp(profilePath(PROFILE), ownerDid, { siweIssuedAt: Date.parse(issuedAt) }),
      { requireProfile: true },
    );
    await writeJsonAtomic(sessionPath(PROFILE), { ...session, replicaStamp });
    const key = join(profilePath(PROFILE), "key.json");
    await writeJsonAtomic(key, jwk);
    const db = join(profilePath(PROFILE), "replicas", "notes", "replica.db");
    return { db, session: sessionPath(PROFILE), key };
  });

  await seedLegacyReplica(home, host, spaceId, sessionDid);
  return { ...paths, delegationCid: session.delegationCid, ownerDid, spaceId };
}

async function seedWithPublicLogin(home: string, host: string): ReturnType<typeof seed> {
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const directory = profilePath(PROFILE);
    return {
      directory, db: join(directory, "replicas", "notes", "replica.db"),
      session: sessionPath(PROFILE), key: join(directory, "key.json"),
    };
  });
  const login = await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"]);
  expect(login.exitCode).toBe(0);
  const session = JSON.parse(await readFile(paths.session, "utf8")) as {
    ownerDid: string; replicaStamp: Parameters<typeof restoreSessionStamp>[2];
    spaceId: string; verificationMethod: string; delegationCid: string;
  };
  expect(session.ownerDid).toBe(ownerDid);
  if (!session.replicaStamp) throw new Error("Public login did not persist a replica stamp");
  expect(await restoreSessionStamp(paths.directory, ownerDid, session.replicaStamp)).toEqual(session.replicaStamp);
  await seedLegacyReplica(home, host, session.spaceId, session.verificationMethod);
  return {
    db: paths.db, session: paths.session, key: paths.key,
    delegationCid: session.delegationCid, ownerDid, spaceId: session.spaceId,
  };
}

async function server(mode: "fail" | "hold" | "success", cid: () => string) {
  const requests: string[] = [];
  const snapshots: Array<{ session: boolean; db: boolean }> = [];
  const revokedCids: string[] = [];
  const queryRequests: string[] = [];
  const authorizationKinds: Array<{ scheme: string; encoding: string; prefix: string; dots: number }> = [];
  const networkPaths: string[] = [];
  let queryRecords: Array<Record<string, unknown>> | undefined;
  const started = Promise.withResolvers<void>();
  let state = mode;
  let localPaths: { session: string; db: string } | undefined;
  const node = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      networkPaths.push(path);
      if (path === "/delegation/query" && request.method === "POST" && queryRecords !== undefined) {
        queryRequests.push(request.headers.get("authorization") ?? "");
        return Response.json({ schemaVersion: 2, items: queryRecords });
      }
      if (path === "/revoke" && request.method === "POST") {
        requests.push(request.headers.get("authorization") ?? "");
        if (localPaths) snapshots.push({
          session: await exists(localPaths.session), db: await exists(localPaths.db),
        });
        started.resolve();
        if (state === "hold") return new Promise<Response>(() => {});
        if (queryRecords !== undefined) {
          const authorization = request.headers.get("authorization") ?? "";
          const scheme = /^([A-Za-z][A-Za-z0-9_-]*)\s+/.exec(authorization)?.[1]?.toLowerCase() ?? "none";
          const token = authorization.replace(/^Bearer\s+/i, "");
          authorizationKinds.push({
            scheme,
            encoding: /^[A-Za-z0-9_-]+={0,2}$/.test(token)
              ? "base64url"
              : token.split(".").length === 3 ? "compact-jwt" : "other",
            prefix: token.startsWith("o2Foo") ? "cacao-cbor"
              : token.startsWith("eyJ") ? "json-token"
              : token.startsWith("Bearer ") ? "nested-bearer" : "other",
            dots: (token.match(/\./g) ?? []).length,
          });
          const signed = await parseSignedSiweCacao(token);
          const target = signed.audience.startsWith("ucan:") ? signed.audience.slice("ucan:".length) : "";
          if (target.length === 0) return new Response("CID-bound owner proof required", { status: 403 });
          revokedCids.push(target);
          return Response.json({ cid: target, revoked: true });
        }
        if (state === "fail") return new Response("node unavailable", { status: 503 });
        return Response.json({ cid: cid(), revoked: true });
      }
      if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
      if (path === "/healthz") return new Response("ok");
      if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(node);
  return {
    host: node.url.origin,
    requests,
    revokedCids,
    queryRequests,
    networkPaths,
    setQueryRecords(records: Array<Record<string, unknown>>) { queryRecords = records; },
    authorizationKinds,
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
    expect(denied.stderr).toContain("REPLICA_GATED");
    expect(await exists(paths.db)).toBe(true);
  }
  expect(await readFile(paths.session)).toEqual(sessionBefore);
  expect(await readFile(paths.key)).toEqual(keyBefore);
}

describe("legacy replica read gate", () => {
  test("deferred denial blocks get, list, and status across fresh CLI processes without deleting the legacy database", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-legacy-denial-"));
    homes.push(home);
    const paths = await seed(home, "https://node.example.test");
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    const commands = [
      ["replica", "get", "notes/a", "--replica", "notes", "--raw"],
      ["replica", "list", "--replica", "notes"],
      ["replica", "status", "--replica", "notes"],
      ["replica", "status"],
    ];
    for (const command of commands) {
      expect((await run(home, command)).exitCode).toBe(0);
    }

    const profileDir = join(home, ".tinycloud", "profiles", PROFILE);
    const guard = <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true }));
    const purge = createProfileReplicaPurge({ profileDir, guard });
    const session = JSON.parse(sessionBefore.toString("utf8")) as { ownerDid: string };
    const denied = await purge.deny({ reason: "sign_out", principal: session.ownerDid }, { deferErase: true });
    expect(denied.status).toBe("denied");
    if (denied.status !== "denied" || !denied.resumeToken) throw new Error("Missing durable denial token");
    expect(await purge.deferredErase()).toEqual(denied.resumeToken);
    expect(await exists(paths.db)).toBe(true);

    for (const command of commands) {
      const refused = await run(home, command);
      expect(refused.exitCode).toBeGreaterThan(0);
      expect(refused.stdout).not.toContain("private replica value");
      expect(refused.stderr).toContain("REPLICA_GATED");
      expect(await exists(paths.db)).toBe(true);
    }
    expect(await readFile(paths.session)).toEqual(sessionBefore);
    expect(await readFile(paths.key)).toEqual(keyBefore);
  }, 30_000);

  test("a held legacy read delivers before a concurrent durable deny can commit", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-legacy-race-"));
    homes.push(home);
    const paths = await seed(home, "https://node.example.test");
    const profileDir = join(home, ".tinycloud", "profiles", PROFILE);
    const guard = <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true }));
    const entered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const originalGet = SqliteReplicaStore.prototype.get;
    const originalWrite = process.stdout.write;
    const originalHome = process.env.TC_HOME;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSignal = process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    const signalPath = join(home, "read-contended");
    const events: string[] = [];
    process.env.TC_HOME = home;
    process.env.NODE_ENV = "test";
    process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = signalPath;
    SqliteReplicaStore.prototype.get = async function (key) {
      const entry = await originalGet.call(this, key);
      entered.resolve();
      await releaseRead.promise;
      return entry;
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      events.push("delivered");
      expect(Buffer.from(chunk).toString("utf8")).toBe("private replica value");
      return true;
    }) as typeof process.stdout.write;
    const program = new Command().option("-p, --profile <name>");
    registerReplicaCommand(program);
    let done = false;
    try {
      const reading = withTinyCloudStateRoot(home, () => program.parseAsync(
        ["--profile", PROFILE, "replica", "get", "notes/a", "--replica", "notes", "--raw"],
        { from: "user" },
      ));
      await entered.promise;
      const purge = createProfileReplicaPurge({ profileDir, guard });
      const session = JSON.parse((await readFile(paths.session)).toString("utf8")) as { ownerDid: string };
      const denial = purge.deny({ reason: "sign_out", principal: session.ownerDid }, { deferErase: true });
      const contention = (async () => {
        while (!done) {
          if (await exists(signalPath)) return "contended" as const;
        }
        return "stopped" as const;
      })();
      try {
        expect(await Promise.race([contention, denial.then(() => "committed" as const)])).toBe("contended");
        expect(await exists(paths.db)).toBe(true);
      } finally {
        done = true;
        releaseRead.resolve();
        await reading;
      }
      const outcome = await denial;
      expect(outcome.status).toBe("denied");
      events.push("denied");
      expect(events).toEqual(["delivered", "denied"]);
    } finally {
      done = true;
      releaseRead.resolve();
      SqliteReplicaStore.prototype.get = originalGet;
      process.stdout.write = originalWrite;
      if (originalHome === undefined) delete process.env.TC_HOME;
      else process.env.TC_HOME = originalHome;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalSignal === undefined) delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
      else process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = originalSignal;
    }
  }, 15_000);

  test("a missing persisted stamp or missing/corrupt gate cannot authorize a legacy get", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-legacy-unstamped-"));
    homes.push(home);
    const paths = await seed(home, "https://node.example.test");
    const stored = JSON.parse((await readFile(paths.session)).toString("utf8")) as Record<string, unknown>;
    expect((await run(home, ["replica", "get", "notes/a", "--replica", "notes", "--raw"])).exitCode).toBe(0);
    const stamp = stored.replicaStamp;
    delete stored.replicaStamp;
    await writeFile(paths.session, JSON.stringify(stored));
    const unstamped = await run(home, ["replica", "get", "notes/a", "--replica", "notes", "--raw"]);
    expect(unstamped.exitCode).toBeGreaterThan(0);
    expect(unstamped.stdout).not.toContain("private replica value");
    expect(unstamped.stderr).toContain("REPLICA_GATED");

    const gatePath = join(home, ".tinycloud", "profiles", PROFILE, REPLICA_GATE_FILE);
    await writeFile(paths.session, JSON.stringify({ ...stored, replicaStamp: stamp }));
    await rm(gatePath);
    const missing = await run(home, ["replica", "get", "notes/a", "--replica", "notes", "--raw"]);
    expect(missing.exitCode).toBeGreaterThan(0);
    expect(missing.stdout).not.toContain("private replica value");
    expect(missing.stderr).toContain("REPLICA_GATED");
    await writeFile(gatePath, "{invalid");
    const corrupt = await run(home, ["replica", "get", "notes/a", "--replica", "notes", "--raw"]);
    expect(corrupt.exitCode).toBeGreaterThan(0);
    expect(corrupt.stdout).not.toContain("private replica value");
    expect(corrupt.stderr).toContain("REPLICA_GATED");
    expect(await exists(paths.db)).toBe(true);
  }, 20_000);

  test("a crash-before-unlink logout marker blocks fresh legacy get, list, and status without erasing credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-legacy-logout-marker-"));
    homes.push(home);
    const paths = await seed(home, "https://node.example.test");
    const commands = [
      ["replica", "get", "notes/a", "--replica", "notes", "--raw"],
      ["replica", "list", "--replica", "notes"],
      ["replica", "status", "--replica", "notes"],
    ];
    for (const command of commands) expect((await run(home, command)).exitCode).toBe(0);
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    const profileDir = join(home, ".tinycloud", "profiles", PROFILE);
    const guard = <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true }));
    const purge = createProfileReplicaPurge({ profileDir, guard });
    expect(await purge.prepareLogoutPending({ principal: paths.ownerDid })).not.toBeNull();

    for (const command of commands) {
      const denied = await run(home, command);
      expect(denied.exitCode).toBeGreaterThan(0);
      expect(denied.stderr).toContain("REPLICA_GATED");
      expect(denied.stdout).not.toContain("notes/a");
      expect(denied.stdout).not.toContain("private replica value");
    }
    expect(await readFile(paths.session)).toEqual(sessionBefore);
    expect(await readFile(paths.key)).toEqual(keyBefore);
    expect(await exists(paths.db)).toBe(true);
  }, 30_000);

  test("an already-open legacy read checks a newly committed logout marker before delivering bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-legacy-marker-race-"));
    homes.push(home);
    const paths = await seed(home, "https://node.example.test");
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    const profileDir = join(home, ".tinycloud", "profiles", PROFILE);
    // Simulate an external marker arriving while this CLI command holds its cooperative profile lock.
    const markerWriter = createProfileReplicaPurge({ profileDir, guard: async (section) => section() });
    const originalGet = SqliteReplicaStore.prototype.get;
    const originalWrite = process.stdout.write;
    const originalError = process.stderr.write;
    const originalHome = process.env.TC_HOME;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let markerWritten = false;
    process.env.TC_HOME = home;
    SqliteReplicaStore.prototype.get = async function (key) {
      const entry = await originalGet.call(this, key);
      expect(await markerWriter.prepareLogoutPending({ principal: paths.ownerDid })).not.toBeNull();
      markerWritten = true;
      return entry;
    };
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(Buffer.from(chunk).toString("utf8")); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(Buffer.from(chunk).toString("utf8")); return true; }) as typeof process.stderr.write;
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error("CLI exited"), { commandExitCode: code });
    }) as typeof process.exit);
    try {
      const program = new Command().option("-p, --profile <name>").option("--json");
      registerReplicaCommand(program);
      let exitCode: number | undefined;
      try {
        await withTinyCloudStateRoot(home, () => program.parseAsync(
          ["--profile", PROFILE, "--json", "replica", "get", "notes/a", "--replica", "notes", "--raw"],
          { from: "user" },
        ));
      } catch (error) {
        if (!error || typeof error !== "object" || !("commandExitCode" in error)) throw error;
        exitCode = error.commandExitCode as number;
      }
      expect(markerWritten).toBe(true);
      expect(exitCode).toBeGreaterThan(0);
      expect(stderr.join("")).toContain("REPLICA_GATED");
      expect(stdout.join("")).not.toContain("private replica value");
      expect(await readFile(paths.session)).toEqual(sessionBefore);
      expect(await readFile(paths.key)).toEqual(keyBefore);
      expect(await exists(paths.db)).toBe(true);
    } finally {
      SqliteReplicaStore.prototype.get = originalGet;
      process.stdout.write = originalWrite;
      process.stderr.write = originalError;
      exit.mockRestore();
      if (originalHome === undefined) delete process.env.TC_HOME;
      else process.env.TC_HOME = originalHome;
    }
  }, 20_000);

});

describe("tc auth logout --revoke with durable replica denial", () => {
  test("OpenKey without an owner revoke signer defers erase and refuses online revocation without losing local state", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-openkey-"));
    homes.push(home);
    const node = await server("success", () => "should-not-revoke");
    const paths = await seed(home, node.host, "openkey");
    const profile = JSON.parse(await withTinyCloudStateRoot(home, () =>
      readFile(profileConfigPath(PROFILE), "utf8"))) as Record<string, unknown>;
    expect(profile.authMethod).toBe("openkey");
    expect("privateKey" in profile).toBe(false);
    const commands = [
      ["replica", "get", "notes/a", "--replica", "notes", "--raw"],
      ["replica", "list", "--replica", "notes"],
      ["replica", "status", "--replica", "notes"],
    ];
    for (const [index, command] of commands.entries()) {
      const before = await run(home, command);
      expect(before.exitCode).toBe(0);
      if (index === 0) expect(before.stdout).toBe("private replica value");
    }
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    const historyCid = new NodeWasmBindings().computeCid(new TextEncoder().encode("tc841-openkey-owned-history"), 0x55n);
    await withTinyCloudStateRoot(home, () =>
      writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), profile: PROFILE, source: "cli",
        delegationCid: historyCid, expiry: new Date(Date.now() + 3_600_000).toISOString(), addedCaps: [],
      }) + "\n", { mode: 0o600 }));
    expect(node.networkPaths).toEqual([]);

    const refused = await run(home, ["auth", "logout", "--revoke"]);
    expect(refused.exitCode).toBeGreaterThan(0);
    const error = JSON.parse(refused.stderr) as { error?: { code?: string; message?: string } };
    expect(error.error?.code).toBe("REVOCATION_AUTHORITY_UNAVAILABLE");
    expect(error.error?.message).toMatch(/OpenKey/i);
    expect(error.error?.message).toMatch(/owner.*(key|signer)|revoke-control/i);
    expect(node.requests).toHaveLength(0);
    expect(node.networkPaths).toEqual([]);
    const profileDir = join(home, ".tinycloud", "profiles", PROFILE);
    const guard = <T>(section: () => Promise<T>): Promise<T> =>
      withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true }));
    const purge = createProfileReplicaPurge({ profileDir, guard });
    const token = await purge.deferredErase();
    expect(token).toMatchObject({ deniedEpoch: expect.any(Number), principalHash: expect.any(String) });
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass === 1) {
        await purge.recover({ signal: new AbortController().signal });
        expect(await purge.deferredErase()).toEqual(token);
      }
      for (const command of commands) {
        const denied = await run(home, command);
        expect(denied.exitCode).toBeGreaterThan(0);
        expect(denied.stderr).toContain("REPLICA_GATED");
        expect(denied.stdout).not.toContain("notes/a");
        expect(denied.stdout).not.toContain("private replica value");
      }
      expect(await readFile(paths.session)).toEqual(sessionBefore);
      expect(await readFile(paths.key)).toEqual(keyBefore);
      expect(await exists(paths.db)).toBe(true);
    }
    expect(node.networkPaths).toEqual([]);
  }, 40_000);

  test("failed node revoke blocks local reads without erasing the session, key, or replica across restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-fail-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("fail", () => delegationCid);
    const paths = await seedWithPublicLogin(home, node.host);
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
  }, 30_000);

  test("offline revocation denies reads while keeping the session, key, and replica after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-offline-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("success", () => delegationCid);
    const paths = await seedWithPublicLogin(home, node.host);
    delegationCid = paths.delegationCid;
    const sessionBefore = await readFile(paths.session);
    const keyBefore = await readFile(paths.key);
    node.stop();

    const failed = await run(home, ["auth", "logout", "--revoke"]);
    expect(failed.exitCode).toBeGreaterThan(0);
    expect(failed.stderr).toMatch(/revocation failed/i);
    expect(node.requests).toEqual([]);
    await expectDeniedButRetained(home, paths, sessionBefore, keyBefore);
  }, 30_000);

  test("interrupted online revocation leaves durable denial, session, key, and files", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-interrupted-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("hold", () => delegationCid);
    const paths = await seedWithPublicLogin(home, node.host);
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
  }, 30_000);

  test("a successful online retry revokes the CID before erasing the persisted replica", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-retry-"));
    homes.push(home);
    let delegationCid = "";
    const node = await server("fail", () => delegationCid);
    const paths = await seedWithPublicLogin(home, node.host);
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
    expect(await exists(paths.key)).toBe(false);
  }, 30_000);

  test("history-only owner grants revoke before the session, while imported and expired source-cli rows are excluded", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc841-revoke-history-"));
    homes.push(home);
    let sessionCid = "";
    const node = await server("success", () => sessionCid);
    const paths = await seedWithPublicLogin(home, node.host);
    sessionCid = paths.delegationCid;
    node.setPaths(paths);

    const wasm = new NodeWasmBindings();
    const cid = (name: string) => wasm.computeCid(new TextEncoder().encode(name), 0x55n);
    const issuedCid = cid("tc841-history-owner-issued");
    const importedCid = cid("tc841-history-imported");
    const expiredCid = cid("tc841-history-owner-expired");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const history = [
      [issuedCid, future], [importedCid, future], [expiredCid, past],
    ].map(([delegationCid, expiry]) => JSON.stringify({
      ts: new Date().toISOString(), profile: PROFILE,
      source: "cli", delegationCid, expiry, addedCaps: [],
    })).join("\n") + "\n";
    await withTinyCloudStateRoot(home, () =>
      writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"), history, { mode: 0o600 }));
    const record = (delegationCid: string, delegatorDid: string, status: "active" | "expired", expiresAt: string) => ({
      cid: delegationCid,
      direction: delegatorDid === paths.ownerDid ? "granted" : "received",
      delegatorDid,
      delegateDid: delegatorDid === paths.ownerDid
        ? "did:key:z6MkRecipientTc841"
        : paths.ownerDid,
      resources: [{
        resource: `${paths.spaceId}/kv/notes/`,
        actions: ["tinycloud.kv/get"],
        caveats: [],
      }],
      parents: [],
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      notBefore: null,
      expiresAt,
      status,
    });
    node.setQueryRecords([
      record(issuedCid, paths.ownerDid, "active", future),
      record(importedCid, "did:pkh:eip155:1:0x1111111111111111111111111111111111111111", "active", future),
      record(expiredCid, paths.ownerDid, "expired", past),
    ]);

    const logout = await run(home, ["auth", "logout", "--revoke"]);
    expect(node.authorizationKinds[0]).toMatchObject({ encoding: "base64url", prefix: "cacao-cbor", dots: 0 });
    expect(logout.exitCode).toBe(0);
    expect(node.queryRequests.length).toBeGreaterThan(0);
    expect(node.revokedCids).toEqual([issuedCid, sessionCid]);
    expect(node.snapshots).toEqual([
      { session: true, db: true },
      { session: true, db: true },
    ]);
    const report = JSON.parse(logout.stdout) as {
      revocationExcluded: Array<{ cid: string; reason: string }>;
    };
    expect(report.revocationExcluded).toEqual([
      { cid: importedCid, reason: "inbound" },
      { cid: expiredCid, reason: "expired" },
    ]);
    expect(await exists(paths.session)).toBe(false);
    expect(await exists(paths.db)).toBe(false);
  }, 30_000);
});
