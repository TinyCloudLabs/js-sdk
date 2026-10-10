import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contentHash, parseUcanGrant } from "@tinycloud/replica";
import { NodeWasmBindings, TinyCloudNode } from "@tinycloud/node-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN;
const DATABASE_URL = process.env.TC_REPLICA_E2E_DATABASE_URL || undefined;
const CLI = resolve(import.meta.dir, "../dist/index.js");
type ReplicationRunOptions = { profile: string; preload?: string; input?: string; replication?: "on" | "off" | "env"; extraEnv?: Record<string, string>; host?: string };
const NO_NETWORK = resolve(import.meta.dir, "../test-support/no-network.cjs");
const NODE20 = resolve(import.meta.dir, "../test-support/node20.cjs");
const { TC_HOST: _host, TC_PROFILE: _profile, TC_REPLICATION: _replication, ...ambient } = process.env;

type Run = { code: number; stdout: Buffer; stderr: string };
type ReplicationEventLog = {
  type: string;
  key?: string;
  source?: string;
  reason?: string;
  syncError?: string;
  syncedBeforeRead?: boolean;
  pendingCleared?: number;
  outcome?: string;
};

describe.skipIf(!NODE_BIN)(`replication flag against a real node (${DATABASE_URL === undefined ? "SQLite" : "Postgres"})`, () => {
  let home: string;
  let dataDir: string;
  let host: string;
  let port: number;
  let node: ChildProcess | undefined;
  let space: string;
  const nodeSecret = randomBytes(48).toString("base64url");
  const initial = {
    "notes/a.txt": Buffer.from("v1"),
    "notes/b.json": Buffer.from('{"version":1}'),
    "notes/bin": Buffer.from([0, 1, 2, 255, 254]),
    "notes/c": Buffer.from("v0"),
    "other/x": Buffer.from("outside notes"),
  } as const;

  async function freePort(): Promise<number> {
    const { promise, resolve: done, reject: fail } = Promise.withResolvers<number>();
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => done(address.port));
    });
    return promise;
  }

  async function startNode(): Promise<void> {
    const child = spawn(NODE_BIN!, [], {
      cwd: dataDir,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(dataDir, "data"),
        TINYCLOUD_PORT: String(port),
        TINYCLOUD_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: nodeSecret,
        ...(DATABASE_URL === undefined ? {} : { TINYCLOUD_STORAGE__DATABASE: DATABASE_URL }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    node = child;
    const launched = Promise.withResolvers<void>();
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Rocket has launched")) launched.resolve();
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => launched.reject(new Error(`node exited (${code}) before launch:\n${output.slice(-2000)}`)));
    await launched.promise;
  }

  async function stopNode(): Promise<void> {
    const child = node;
    node = undefined;
    if (child === undefined || child.exitCode !== null) return;
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    child.kill("SIGTERM");
    await exited.promise;
  }

  async function tc(args: string[], options: ReplicationRunOptions): Promise<Run> {
    const child = spawn("node", [
      ...(options.preload ? ["--require", options.preload] : []), CLI, "-q", "--json", "--profile", options.profile,
      "--host", options.host ?? host,
      ...(options.replication === "on" ? ["--replication", "--replication-debug"] : []),
      ...(options.replication === "off" ? ["--no-replication"] : []),
      ...args,
    ], {
      cwd: home,
      env: {
        ...ambient,
        TC_HOME: home,
        HOME: home,
        TC_NO_NETWORK_LOG: join(home, "network-attempts.log"),
        ...(options.replication === "env" ? { TC_REPLICATION: "1" } : {}),
        ...options.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = Promise.withResolvers<number>();
    child.once("exit", (code) => exited.resolve(code ?? -1));
    return { code: await exited.promise, stdout: Buffer.concat(stdout), stderr };
  }
  async function replicationEvents(profile = "owner"): Promise<ReplicationEventLog[]> {
    const path = join(home, ".tinycloud", "profiles", profile, "replication", "events.jsonl");
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReplicationEventLog);
  }
  async function filesNamed(root: string, filename: string): Promise<string[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) found.push(...await filesNamed(path, filename));
        else if (entry.name === filename) found.push(path);
      }
      return found;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function ok<T = unknown>(args: string[], profile = "owner", options: Omit<ReplicationRunOptions, "profile"> = {}): Promise<T> {
    const result = await tc(args, { profile, ...options });
    if (result.code !== 0) throw new Error(`tc ${args.join(" ")} exited ${result.code}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout.toString()) as T;
  }

  async function put(key: string, bytes: Buffer, profile = "owner", replication?: ReplicationRunOptions["replication"]): Promise<Run> {
    const file = join(home, "put.bin");
    await writeFile(file, bytes);
    return tc(["kv", "put", key, "--file", file], { profile, ...(replication ? { replication } : {}) });
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "tc-replication-flag-home-"));
    dataDir = await mkdtemp(join(tmpdir(), "tc-replication-flag-node-"));
    port = await freePort();
    host = `http://127.0.0.1:${port}`;
    await startNode();
    const info = await (await fetch(`${host}/info`)).json() as { features?: string[] };
    expect(info.features).toContain("kv-sync-v1");
  }, 60_000);

  afterAll(async () => {
    await stopNode();
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  test("covers the 12 Phase 1 CLI acceptance steps", async () => {
    // 1. The local-key sign-in recap must request get+sync for the configured prefix.
    await ok(["init", "--name", "owner", "--key-only"]);
    const login = await ok<{ spaceId: string }>(["auth", "login", "--method", "local", "--replication-prefix", "notes", "--replication-prefix", "variables"]);
    space = login.spaceId;
    expect(space).toMatch(/^tinycloud:/);

    // 2. Seed covered and uncovered keys, including the vars namespace.
    for (const [key, value] of Object.entries(initial)) {
      const result = await put(key, value);
      expect(result.code).toBe(0);
    }
    const profile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as { privateKey: string; replication?: { prefixes: string[] } };
    expect(profile.replication?.prefixes).toEqual(["notes", "variables"]);
    const varsPut = await tc(["vars", "put", "flag", "one"], { profile: "owner", extraEnv: { TC_PRIVATE_KEY: profile.privateKey } });
    expect(varsPut.code).toBe(0);
    // 11. A report may inspect status but must not initialize a never-opened replica partition.
    const profileDir = join(home, ".tinycloud", "profiles", "owner", "replication");
    const beforeActivationReport = await tc(["replica", "report", "--json"], { profile: "owner", replication: "on" });
    expect(beforeActivationReport.code).toBe(0);
    expect(JSON.parse(beforeActivationReport.stdout.toString()).replicas).toEqual([]);
    await expect(readdir(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    // Before any replica is opened, flag-off and default reads are identical and leave no state or log.
    const flagOffBeforeActivation = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "off" });
    const defaultBeforeActivation = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner" });
    expect(flagOffBeforeActivation.code).toBe(0);
    expect(flagOffBeforeActivation.stdout).toEqual(defaultBeforeActivation.stdout);
    expect(flagOffBeforeActivation.stderr).not.toContain("replica");
    expect(defaultBeforeActivation.stderr).not.toContain("replica");

    // 3. Both explicit and environment activation serve covered reads locally; raw data is byte-identical.
    const hit = await tc(["kv", "get", "notes/a.txt"], { profile: "owner", replication: "on" });
    expect(hit.code).toBe(0);
    expect(hit.stderr).toContain("replica hit");
    expect(hit.stderr).toContain("syncedBeforeRead");
    const raw = await tc(["kv", "get", "notes/bin", "--raw"], { profile: "owner", replication: "env" });
    expect(raw.code).toBe(0);
    expect(contentHash(raw.stdout)).toBe(contentHash(initial["notes/bin"]));
    const list = await tc(["kv", "list", "--prefix", "notes"], { profile: "owner", replication: "on" });
    expect(list.stderr).toContain("replica hit");
    const variable = await tc(["vars", "get", "flag", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_PRIVATE_KEY: profile.privateKey } });
    expect(variable.code).toBe(0);
    expect(variable.stdout.toString()).toContain("one");
    expect(variable.stderr).toContain("replica hit");
    const outside = await tc(["kv", "get", "other/x"], { profile: "owner", replication: "on" });
    expect(outside.stderr).toContain("not_covered");
    // TC-721 expected-unsupported: exercise the real compact-delegate revocation endpoint.
    const manager = new NodeWasmBindings().createSessionManager();
    const recipientKey = manager.createSessionKey("tc-721-compact-delegate");
    const recipientDid = manager.getDID(recipientKey)!.split("#")[0]!;
    const ownerSdk = new TinyCloudNode({ host, privateKey: profile.privateKey, autoBootstrapAccount: false, autoCreateSpace: true, includeAccountRegistryPermissions: false });
    try {
      await ownerSdk.signIn();
      const compactGrant = await ownerSdk.delegateTo(recipientDid, [{
        service: "tinycloud.kv",
        space,
        path: "notes/",
        actions: ["tinycloud.kv/get"],
      }]);
      const revocation = await ownerSdk.revokeDelegation(compactGrant.delegation.cid);
      expect(revocation.ok).toBe(false);
      expect(JSON.stringify(revocation.error)).toMatch(/403|Unauthorized Revoker/i);
      process.stderr.write("EXPECTED-UNSUPPORTED TC-721: compact delegate revoke is rejected; no revoked-sync result is simulated.\n");
    } finally {
      await ownerSdk.replication?.close();
    }

    // 4. Committed writes return the new value: either network fallback or one catch-up sync.
    const next = await put("notes/a.txt", Buffer.from("v2"), "owner", "on");
    expect(next.code).toBe(0);
    const pendingReadEventsStart = await replicationEvents();
    const pendingRead = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on" });
    const pendingReadEvents = (await replicationEvents()).slice(pendingReadEventsStart.length);
    const pendingReadEvent = pendingReadEvents.find((event) => event.type === "replication.read" && event.key === "notes/a.txt");
    expect(pendingRead.stdout.toString()).toBe("v2");
    const networkPending = pendingReadEvent?.source === "network" && pendingReadEvent.reason === "pending_write";
    const caughtUpBeforeRead = pendingReadEvents.some((event) => event.type === "replication.sync" && event.outcome === "ok" && (event.pendingCleared ?? 0) >= 1);
    const syncedBeforeRead = pendingReadEvent?.source === "replica" && pendingReadEvent.syncedBeforeRead === true && caughtUpBeforeRead;
    expect(networkPending || syncedBeforeRead).toBe(true);
    if (networkPending) {
      const caughtUpEventsStart = await replicationEvents();
      const caughtUp = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
      const caughtUpEvents = (await replicationEvents()).slice(caughtUpEventsStart.length);
      expect(caughtUp.stdout.toString()).toBe("v2");
      expect(caughtUpEvents.some((event) => event.type === "replication.sync" && event.outcome === "ok" && (event.pendingCleared ?? 0) >= 1)).toBe(true);
    }
    const heldSyncPreload = join(home, "held-sync.cjs");
    await writeFile(heldSyncPreload, `const original = globalThis.fetch; let held = false; globalThis.fetch = (...args) => { if (!held && String(args[0]).endsWith("/invoke")) { const signal = args[1]?.signal ?? args[0]?.signal; if (signal) { held = true; return new Promise((_, reject) => { const keepAlive = setTimeout(() => reject(Object.assign(new Error("held sync timeout"), { name: "TimeoutError", code: "TIMEOUT" })), 1500); const abort = () => { clearTimeout(keepAlive); reject(signal.reason ?? new Error("held sync aborted")); }; if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }); } } return original(...args); };`);
    expect((await put("notes/held-sync", Buffer.from("before"), "owner", "off")).code).toBe(0);
    expect((await put("notes/held-sync", Buffer.from("committed"), "owner", "on")).code).toBe(0);
    const pendingHeldEventsStart = await replicationEvents();
    const pendingDuringHeldSync = await tc(["kv", "get", "notes/held-sync", "--raw"], {
      profile: "owner",
      preload: heldSyncPreload,
      replication: "on",
      extraEnv: { TC_REPLICATION_SYNC_TIMEOUT_MS: "500", TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    const pendingHeldEvents = (await replicationEvents()).slice(pendingHeldEventsStart.length);
    const pendingHeldRead = pendingHeldEvents.find((event) => event.type === "replication.read" && event.key === "notes/held-sync");
    expect(pendingDuringHeldSync.code).toBe(0);
    expect(pendingDuringHeldSync.stdout.toString()).toBe("committed");
    expect(pendingHeldRead).toMatchObject({
      type: "replication.read",
      key: "notes/held-sync",
      source: "network",
      reason: "pending_write",
      outcome: "found",
    });
    const pendingRecoveryEventsStart = await replicationEvents();
    const recoveredPendingSync = await tc(["kv", "get", "notes/held-sync", "--raw"], {
      profile: "owner",
      replication: "on",
      extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    const pendingRecoveryEvents = (await replicationEvents()).slice(pendingRecoveryEventsStart.length);
    expect(recoveredPendingSync.code).toBe(0);
    expect(recoveredPendingSync.stdout.toString()).toBe("committed");
    expect(pendingRecoveryEvents.some((event) => event.type === "replication.sync" && event.outcome === "ok" && (event.pendingCleared ?? 0) >= 1)).toBe(true);


    const deleted = await tc(["kv", "delete", "notes/b.json"], { profile: "owner", replication: "on" });
    expect(deleted.code).toBe(0);
    expect((await tc(["kv", "get", "notes/b.json"], { profile: "owner", replication: "on" })).code).toBe(4);
    const ambiguousPreload = join(home, "ambiguous.cjs");
    await writeFile(ambiguousPreload, `const original = globalThis.fetch; globalThis.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).includes("/invoke")) throw Object.assign(new Error("synthetic timeout"), { name: "TimeoutError", code: "TIMEOUT" }); return response; };`);
    const ambiguousFile = join(home, "ambiguous.bin");
    await writeFile(ambiguousFile, "v3");
    const ambiguous = await tc(["kv", "put", "notes/a.txt", "--file", ambiguousFile], { profile: "owner", preload: ambiguousPreload, replication: "on" });
    expect(ambiguous.stderr).toContain("ambiguous NETWORK_ERROR");
    const ambiguousRead = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(ambiguousRead.stdout.toString()).toBe("v3");
    expect(ambiguousRead.stderr).toContain("network pending_write");
    const reportPinned = await ok<{ replicas: Array<{ pinned: Array<{ key: string; state: string; code?: string }> }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(reportPinned.replicas.flatMap((replica) => replica.pinned)).toContainEqual(expect.objectContaining({ key: "notes/a.txt", state: "ambiguous", code: "NETWORK_ERROR" }));
    const clear = await tc(["replica", "report", "--clear-pending", "--json"], { profile: "owner", replication: "on" });
    expect(clear.code).toBe(0);
    expect(clear.stderr).toContain("Clearing pending writes stops pinning keys");
    expect((await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } })).stderr).toContain("replica hit");
    const abaFile = join(home, "aba.bin");
    await writeFile(abaFile, "v0");
    const aba = await tc(["kv", "put", "notes/c", "--file", abaFile], { profile: "owner", preload: ambiguousPreload, replication: "on" });
    expect(aba.stderr).toContain("ambiguous NETWORK_ERROR");
    const abaRead = await tc(["kv", "get", "notes/c", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(abaRead.stdout.toString()).toBe("v0");
    expect(abaRead.stderr).toContain("network pending_write");
    expect(abaRead.stderr).toContain("pendingCleared:0");
    const abaPinned = await ok<{ replicas: Array<{ pinned: Array<{ key: string; state: string; code?: string }> }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(abaPinned.replicas.flatMap((replica) => replica.pinned)).toContainEqual(expect.objectContaining({ key: "notes/c", state: "ambiguous", code: "NETWORK_ERROR" }));
    const abaClear = await tc(["replica", "report", "--clear-pending", "--json"], { profile: "owner", replication: "on" });
    expect(abaClear.code).toBe(0);

    // 5. A flag-off writer changes the node; default staleness stays local, zero staleness catches up.
    const remote = await put("notes/a.txt", Buffer.from("v4"), "owner", "off");
    expect(remote.code).toBe(0);
    const stale = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on" });
    expect(stale.stdout.toString()).toBe("v3");
    const fresh = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(fresh.stdout.toString()).toBe("v4");

    // 6. Offline reads use the replica; an uncovered online-only read fails closed.
    await stopNode();
    const offlineEventsStart = await replicationEvents();
    const offlineHit = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", preload: NO_NETWORK, replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    const offlineEvents = (await replicationEvents()).slice(offlineEventsStart.length);
    const offlineRead = offlineEvents.find((event) => event.type === "replication.read" && event.key === "notes/a.txt");
    expect(offlineHit.code).toBe(0);
    expect(offlineRead).toMatchObject({ type: "replication.read", source: "replica", outcome: "found" });
    expect(["TIMEOUT", "NETWORK_ERROR"]).toContain(offlineRead?.syncError);
    const offlineList = await tc(["kv", "list", "--prefix", "notes"], { profile: "owner", preload: NO_NETWORK, replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(offlineList.code === 0, `${offlineList.code}\n${offlineList.stderr}`).toBe(true);
    const offlineOutside = await tc(["kv", "get", "other/x"], { profile: "owner", replication: "on" });
    const offlineOutsideOff = await tc(["kv", "get", "other/x"], { profile: "owner", replication: "off" });
    expect(offlineOutside.code).toBe(offlineOutsideOff.code);
    expect(offlineOutside.code).toBe(1);
    expect(offlineOutside.stderr).toBe(offlineOutsideOff.stderr);
    expect(offlineOutside.stderr).toContain("NETWORK_ERROR");
    await startNode();

    // 7. A held stale sync serves offline; SIGINT still drains the active controller.
    // The next invocation must complete a real sync, not only escape a busy state.
    const stalledEventsStart = await replicationEvents();
    const stalled = await tc(["kv", "get", "notes/a.txt", "--raw"], {
      profile: "owner",
      preload: heldSyncPreload,
      replication: "on",
      extraEnv: { TC_REPLICATION_SYNC_TIMEOUT_MS: "500", TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    const stalledEvents = (await replicationEvents()).slice(stalledEventsStart.length);
    const stalledRead = stalledEvents.find((event) => event.type === "replication.read" && event.key === "notes/a.txt");
    expect(stalled.code).toBe(0);
    expect(stalled.stdout.toString()).toBe("v4");
    expect(stalledRead).toMatchObject({
      type: "replication.read",
      key: "notes/a.txt",
      source: "replica",
      outcome: "found",
    });
    expect(["TIMEOUT", "NETWORK_ERROR"]).toContain(stalledRead?.syncError);
    const recoveredEventsStart = await replicationEvents();
    const recoveredSync = await tc(["kv", "get", "notes/a.txt", "--raw"], {
      profile: "owner",
      replication: "on",
      extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    const recoveredEvents = (await replicationEvents()).slice(recoveredEventsStart.length);
    expect(recoveredSync.code).toBe(0);
    expect(recoveredSync.stdout.toString()).toBe("v4");
    expect(recoveredEvents.some((event) => event.type === "replication.sync" && event.outcome === "ok")).toBe(true);

    const interruptPreload = join(home, "interrupt-sync.cjs");
    await writeFile(interruptPreload, `const original = globalThis.fetch; globalThis.fetch = (...args) => { if (!String(args[0]).includes("/invoke")) return original(...args); setImmediate(() => process.kill(process.pid, "SIGINT")); const signal = args[1]?.signal ?? args[0]?.signal; if (!signal) return original(...args); return new Promise((_, reject) => { const keepAlive = setTimeout(() => reject(Object.assign(new Error("synthetic fetch timeout"), { name: "TimeoutError", code: "TIMEOUT" })), 5000); const abort = () => { clearTimeout(keepAlive); reject(signal.reason ?? new Error("aborted")); }; if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }); };`);
    const interrupted = await tc(["kv", "get", "notes/a.txt"], { profile: "owner", preload: interruptPreload, replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(interrupted.code).toBe(130);
    expect((await tc(["kv", "get", "notes/a.txt"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } })).stderr).not.toContain("busy");
    // 8. A delegate-session device uses its signed session grant for the replica.
    await ok(["profile", "create", "delegate", "--posture", "delegate-session"]);
    // Profiles have no config-only CLI command; seed the persisted setting created by auth login.
    const delegateProfilePath = join(home, ".tinycloud", "profiles", "delegate", "profile.json");
    const delegateProfile = JSON.parse(await readFile(delegateProfilePath, "utf8")) as Record<string, unknown>;
    await writeFile(delegateProfilePath, JSON.stringify({ ...delegateProfile, replication: { prefixes: ["notes"] } }, null, 2));
    await ok(["auth", "request", "--cap", `tinycloud.kv:${space}:notes:get,list,metadata,sync`, "--expiry", "30d", "--emit", "delegate-request.json"], "delegate");
    const delegateGrant = await tc(["auth", "grant", "delegate-request.json", "--yes"], { profile: "owner" });
    expect(delegateGrant.code).toBe(0);
    const grantArtifact = JSON.parse(delegateGrant.stdout.toString()) as { delegation: { delegationHeader: { Authorization: string } } };
    const signedGrant = parseUcanGrant(grantArtifact.delegation.delegationHeader.Authorization);
    const signedScopes = Object.entries(signedGrant.att).map(([resource, actions]) => ({ resource, actions: Object.keys(actions) }));
    expect(signedScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: `${space}/kv/notes`,
        actions: expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/sync"]),
      }),
    ]));
    await writeFile(join(home, "delegate-grant.json"), delegateGrant.stdout);
    const importedDelegate = await ok<{ delegationCid: string; permissions: Array<{ service: string; space: string; path: string; actions: string[] }> }>(["auth", "import", "delegate-grant.json"], "delegate");
    expect(importedDelegate.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: "tinycloud.kv",
        space,
        path: "notes",
        actions: expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/sync"]),
      }),
    ]));
    const delegateIdentity = await ok<{ spaceId: string; sessionDid: string }>(["auth", "whoami"], "delegate");
    expect(delegateIdentity.spaceId).toBe(space);
    expect(signedGrant.audience.split("#", 1)[0]).toBe(delegateIdentity.sessionDid.split("#", 1)[0]);
    const delegatedHit = await tc(["kv", "get", "notes/a.txt"], { profile: "delegate", replication: "on" });
    expect(delegatedHit.code).toBe(0);
    expect(delegatedHit.stderr).toContain("replica hit");
    const revoker = new TinyCloudNode({
      host,
      privateKey: profile.privateKey,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "tc-replication-flag",
        name: "tc replication flag revoker",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: "default",
        permissions: [{ service: "tinycloud.delegation", space: "default", path: "", actions: ["revoke"] }],
      },
    });
    await revoker.signIn();
    try {
      const result = await revoker.revokeDelegation(importedDelegate.delegationCid);
      if (!result.ok) throw new Error(`owner revoke failed: ${JSON.stringify(result.error)}`);
    } finally {
      await revoker.replication?.close();
    }
    const revokedRead = await tc(["kv", "get", "notes/a.txt"], {
      profile: "delegate",
      replication: "on",
      extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    expect(revokedRead.stderr).toContain("GRANT_REVOKED");
    const revokedReport = await ok<{ replicas: Array<{ prefix: string; state: string; counts?: { keys: number; contentMissing: number; tombstones: number } }> }>(
      ["replica", "report", "--json"],
      "delegate",
      { replication: "on" },
    );
    const revokedEntry = revokedReport.replicas.find((entry) => entry.prefix === "notes");
    expect(revokedEntry === undefined || revokedEntry.state === "revoked").toBe(true);
    if (revokedEntry) {
      expect(revokedEntry.counts).toEqual({ keys: 0, contentMissing: 0, tombstones: 0 });
    }
    const offlineRevokedRead = await tc(["kv", "get", "notes/a.txt", "--raw"], {
      profile: "delegate",
      preload: NO_NETWORK,
      replication: "on",
      extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    expect(offlineRevokedRead.code).not.toBe(0);
    expect(offlineRevokedRead.stderr).not.toContain("replica hit");
    expect(offlineRevokedRead.stdout.toString()).not.toBe("v4");

    // 9. Node 20 is refused; the real grant revocation path was exercised above.
    const unsupported = await tc(["kv", "get", "notes/a.txt"], { profile: "delegate", preload: NODE20, replication: "on" });
    expect(unsupported.stderr).toContain("runtime_unsupported");
    // Grant edge cases use the real node and fail closed at the login boundary.
    await ok(["init", "--name", "owner-no-prefix", "--key-only"], "owner-no-prefix");
    await ok(["auth", "login", "--method", "local"], "owner-no-prefix");
    expect((await put("notes/no-sync", Buffer.from("network-only"), "owner-no-prefix", "off")).code).toBe(0);
    const noPrefixProfilePath = join(home, ".tinycloud", "profiles", "owner-no-prefix", "profile.json");
    const noPrefixProfile = JSON.parse(await readFile(noPrefixProfilePath, "utf8")) as Record<string, unknown>;
    await writeFile(noPrefixProfilePath, JSON.stringify({ ...noPrefixProfile, replication: { prefixes: ["notes"] } }, null, 2));
    const missingGrant = await tc(["kv", "get", "notes/no-sync", "--raw"], {
      profile: "owner-no-prefix",
      replication: "on",
      extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" },
    });
    expect(missingGrant.code).toBe(0);
    expect(missingGrant.stdout.toString()).toBe("network-only");
    expect(missingGrant.stderr).toContain("grant_missing");
    expect(missingGrant.stderr.match(/Warning:/g) ?? []).toHaveLength(1);

    await ok(["init", "--name", "outside-scope", "--key-only"], "outside-scope");
    const outsideManifest = join(home, "outside-scope-manifest.json");
    await writeFile(outsideManifest, JSON.stringify({
      app_id: "tc858-outside-scope",
      space: "default",
      permissions: [
        { service: "tinycloud.kv", path: "other/", skipPrefix: true, actions: ["tinycloud.kv/get"] },
      ],
    }));
    const outsideLogin = await tc(["auth", "login", "--method", "openkey", "--manifest", outsideManifest, "--replication-prefix", "notes"], { profile: "outside-scope" });
    expect(outsideLogin.code).toBe(2);
    expect(outsideLogin.stderr).toContain("REPLICATION_PREFIX_OUTSIDE_SCOPE");
    expect((JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "outside-scope", "profile.json"), "utf8")) as { replication?: unknown }).replication).toBeUndefined();

    await ok(["init", "--name", "caveated-scope", "--key-only"], "caveated-scope");
    const caveatedManifest = join(home, "caveated-scope-manifest.json");
    await writeFile(caveatedManifest, JSON.stringify({
      app_id: "tc858-caveated-scope",
      space: "default",
      permissions: [
        { service: "tinycloud.kv", path: "notes", skipPrefix: true, actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }] },
      ],
    }));
    const caveatedLogin = await tc(["auth", "login", "--method", "openkey", "--manifest", caveatedManifest, "--replication-prefix", "notes"], { profile: "caveated-scope" });
    expect(caveatedLogin.code).toBe(2);
    expect(caveatedLogin.stderr).toContain("REPLICATION_PREFIX_CAVEATED");
    expect((JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "caveated-scope", "profile.json"), "utf8")) as { replication?: unknown }).replication).toBeUndefined();

    const alias = host.replace("127.0.0.1", "localhost");
    const primaryWrite = await tc(["kv", "put", "notes/partition", "primary-value"], { profile: "owner", replication: "on" });
    if (primaryWrite.code !== 0) throw new Error(`primary write failed\n${primaryWrite.stderr}\n${primaryWrite.stdout}`);
    const aliasRead = await tc(["kv", "get", "notes/partition", "--raw"], { profile: "owner", replication: "on", host: alias, extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    if (aliasRead.code !== 0) throw new Error(`alias replica read failed\n${aliasRead.stderr}\n${aliasRead.stdout}`);
    expect(aliasRead.stdout.toString()).toBe("primary-value");
    expect(aliasRead.stderr).toContain("replica hit");
    const primaryReport = await ok<{ replicas: Array<{ prefix: string; pending: { committed: number } }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(primaryReport.replicas.find((replica) => replica.prefix === "notes")?.pending.committed).toBe(1);
    const primarySync = await tc(["kv", "get", "notes/partition", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(primarySync.code).toBe(0);
    expect(primarySync.stdout.toString()).toBe("primary-value");
    expect(primarySync.stderr).toContain("replica hit");
    const caughtUpReport = await ok<{ replicas: Array<{ prefix: string; pending: { committed: number } }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(caughtUpReport.replicas.find((replica) => replica.prefix === "notes")?.pending.committed).toBe(0);
    const aliasReport = await tc(["replica", "report", "--json"], { profile: "owner", replication: "on", host: alias });
    expect(aliasReport.code).toBe(0);
    expect((await readdir(profileDir)).length).toBeGreaterThan(1);
    // 11. Later flag-off invocation preserves output and emits no replication log.
    const flagOff = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "off" });
    expect(flagOff.code).toBe(0);
    expect(flagOff.stderr).not.toContain("replica");
    const withoutFlag = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner" });
    expect(withoutFlag.stdout).toEqual(flagOff.stdout);
    expect(flagOff.stderr).not.toContain("replica");
    expect(withoutFlag.stderr).not.toContain("replica");
    // 12. JSON report reflects recorded read events and logout purges every identity partition.
    const report = await ok<{ totals: { reads: number; replicaReads: number }; replicas: unknown[]; partitions: unknown[] }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(report.totals.replicaReads).toBeGreaterThan(0);
    expect(report.replicas.length).toBeGreaterThan(0);
    expect(report.partitions.length).toBeGreaterThan(0);
    const purgeReport = await ok<{
      replicas: Array<{ prefix: string }>;
      partitions: Array<{ idHash: string; host: string | null }>;
      purged: { purged: string[]; failed: Array<{ prefix: string; code: string }> };
    }>(["replica", "report", "--json", "--purge"], "owner", { replication: "on" });
    expect(purgeReport.purged.purged).toContain("notes");
    expect(purgeReport.purged.failed).toEqual([]);
    expect(purgeReport.replicas.some((replica) => replica.prefix === "notes")).toBe(false);
    const primaryPartitions = purgeReport.partitions.filter((partition) => partition.host === host);
    expect(primaryPartitions.length).toBeGreaterThan(0);
    const remainingPrimaryDatabases = (await Promise.all(
      primaryPartitions.map((partition) => filesNamed(join(profileDir, partition.idHash), "replica.db")),
    )).flat();
    expect(remainingPrimaryDatabases).toEqual([]);
    await ok(["auth", "logout"], "owner");
    await expect(readdir(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(space).toMatch(/^tinycloud:/);
  }, 300_000);
});
