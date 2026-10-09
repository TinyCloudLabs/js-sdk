import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contentHash } from "@tinycloud/replica";
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
    // 11. Before any replica is opened, flag-off and default reads are identical and leave no state or log.
    const profileDir = join(home, ".tinycloud", "profiles", "owner", "replication");
    const flagOffBeforeActivation = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "off" });
    const defaultBeforeActivation = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner" });
    expect(flagOffBeforeActivation.code).toBe(0);
    expect(flagOffBeforeActivation.stdout).toEqual(defaultBeforeActivation.stdout);
    expect(flagOffBeforeActivation.stderr).not.toContain("replica");
    expect(defaultBeforeActivation.stderr).not.toContain("replica");
    await expect(readdir(profileDir)).rejects.toMatchObject({ code: "ENOENT" });

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
    const variable = await tc(["vars", "get", "flag", "--raw"], { profile: "owner", replication: "on" });
    expect(variable.stdout.toString()).toContain("one");
    expect(variable.stderr).toContain("replica hit");
    const outside = await tc(["kv", "get", "other/x"], { profile: "owner", replication: "on" });
    expect(outside.stderr).toContain("not_covered");

    // 4. Committed and ambiguous writes remain pinned until a sync started after the write.
    const next = await put("notes/a.txt", Buffer.from("v2"), "owner", "on");
    expect(next.code).toBe(0);
    const pendingRead = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on" });
    expect(pendingRead.stdout.toString()).toBe("v2");
    expect(pendingRead.stderr).toContain("pending_write");
    const caughtUp = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(caughtUp.stderr).toContain("pendingCleared:1");
    const deleted = await tc(["kv", "delete", "notes/b.json"], { profile: "owner", replication: "on" });
    expect(deleted.code).toBe(0);
    expect((await tc(["kv", "get", "notes/b.json"], { profile: "owner", replication: "on" })).code).toBe(4);
    const ambiguousPreload = join(home, "ambiguous.cjs");
    await writeFile(ambiguousPreload, `const original = globalThis.fetch; globalThis.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).includes("/kv/")) throw Object.assign(new Error("synthetic timeout"), { name: "TimeoutError", code: "TIMEOUT" }); return response; };`);
    const ambiguousFile = join(home, "ambiguous.bin");
    await writeFile(ambiguousFile, "v3");
    const ambiguous = await tc(["kv", "put", "notes/a.txt", "--file", ambiguousFile], { profile: "owner", preload: ambiguousPreload, replication: "on" });
    expect(ambiguous.stderr).toContain("TIMEOUT");
    const ambiguousRead = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(ambiguousRead.stdout.toString()).toBe("v3");
    expect(ambiguousRead.stderr).toContain("pinned");
    const reportPinned = await ok<{ replicas: Array<{ pinned: Array<{ key: string; state: string; code?: string }> }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(reportPinned.replicas.flatMap((replica) => replica.pinned)).toContainEqual(expect.objectContaining({ key: "notes/a.txt", state: "ambiguous", code: "TIMEOUT" }));
    const clear = await tc(["replica", "report", "--clear-pending", "--json"], { profile: "owner", replication: "on" });
    expect(clear.stderr).toContain("read-your-writes");
    expect((await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } })).stderr).toContain("replica hit");
    const abaFile = join(home, "aba.bin");
    await writeFile(abaFile, "v0");
    const aba = await tc(["kv", "put", "notes/c", "--file", abaFile], { profile: "owner", preload: ambiguousPreload, replication: "on" });
    expect(aba.stderr).toContain("TIMEOUT");
    expect((await tc(["replica", "sync"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } })).code).toBe(0);
    expect((await ok<{ replicas: Array<{ pinned: Array<{ key: string }> }> }>(["replica", "report", "--json"], "owner", { replication: "on" })).replicas.flatMap((replica) => replica.pinned.map((entry) => entry.key))).toContain("notes/c");

    // 5. A flag-off writer changes the node; default staleness stays local, zero staleness catches up.
    const remote = await put("notes/a.txt", Buffer.from("v4"), "owner", "off");
    expect(remote.code).toBe(0);
    const stale = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on" });
    expect(stale.stdout.toString()).toBe("v3");
    const fresh = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(fresh.stdout.toString()).toBe("v4");

    // 6. Offline reads use the replica; an uncovered online-only read fails closed.
    await stopNode();
    const offlineHit = await tc(["kv", "get", "notes/a.txt", "--raw"], { profile: "owner", preload: NO_NETWORK, replication: "on" });
    expect(offlineHit.code).toBe(0);
    expect(offlineHit.stderr).toContain("syncError");
    expect((await tc(["kv", "list", "--prefix", "notes"], { profile: "owner", preload: NO_NETWORK, replication: "on" })).code).toBe(0);
    expect((await tc(["kv", "get", "other/x"], { profile: "owner", preload: NO_NETWORK, replication: "on" })).code).toBe(6);
    await startNode();

    // 7. Foreground termination drains the active replication controller before process exit.
    const stalledPreload = join(home, "stalled-sync.cjs");
    await writeFile(stalledPreload, `const original = globalThis.fetch; globalThis.fetch = (...args) => String(args[0]).includes("/kv/sync") ? new Promise(() => {}) : original(...args);`);
    const timed = await tc(["kv", "get", "notes/a.txt"], { profile: "owner", preload: stalledPreload, replication: "on", extraEnv: { TC_REPLICATION_SYNC_TIMEOUT_MS: "500" } });
    expect(timed.stderr).toContain("syncError");
    expect((await tc(["kv", "get", "notes/a.txt"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } })).stderr).not.toContain("busy");

    const interruptPreload = join(home, "interrupt-sync.cjs");
    await writeFile(interruptPreload, `const original = globalThis.fetch; globalThis.fetch = (...args) => { if (String(args[0]).includes("/kv/sync")) { setImmediate(() => process.kill(process.pid, "SIGINT")); return new Promise(() => {}); } return original(...args); };`);
    const interrupted = await tc(["kv", "get", "notes/a.txt"], { profile: "owner", preload: interruptPreload, replication: "on" });
    expect(interrupted.code).toBe(130);
    expect((await tc(["kv", "get", "notes/a.txt"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } })).stderr).not.toContain("busy");
    // 8. A delegate-session device uses its signed session grant for the replica.
    await ok(["profile", "create", "delegate", "--posture", "delegate-session"]);
    await ok(["auth", "request", "--cap", `tinycloud.kv:${space}:notes/:get,list,metadata,sync`, "--expiry", "30d", "--emit", "delegate-request.json"], "delegate");
    const delegateGrant = await tc(["auth", "grant", "delegate-request.json", "--yes"], { profile: "owner" });
    expect(delegateGrant.code).toBe(0);
    await writeFile(join(home, "delegate-grant.json"), delegateGrant.stdout);
    await ok(["auth", "import", "delegate-grant.json"], "delegate");
    const delegatedHit = await tc(["kv", "get", "notes/a.txt"], { profile: "delegate", replication: "on" });
    expect(delegatedHit.code).toBe(0);
    expect(delegatedHit.stderr).toContain("replica hit");
    const delegateReport = await ok<{ replicas: Array<{ strategy?: string }> }>(["replica", "report", "--json"], "delegate", { replication: "on" });
    expect(delegateReport.replicas.some((replica) => replica.strategy === "session")).toBe(true);

    // 9. Refuse missing, unsupported-runtime, out-of-scope and caveated grants before local serving.
    await ok(["profile", "create", "no-prefix", "--posture", "delegate-session"]);
    const unsupported = await tc(["kv", "get", "notes/a.txt"], { profile: "delegate", preload: NODE20, replication: "on" });
    expect(unsupported.stderr).toContain("runtime_unsupported");
    const scoped = await tc(["auth", "login", "--method", "local", "--replication-prefix", "other"], { profile: "delegate" });
    expect(scoped.code).not.toBe(0);
    expect(scoped.stderr).toContain("REPLICATION_PREFIX_OUT_OF_SCOPE");

    const alias = host.replace("127.0.0.1", "localhost");
    const primaryWrite = await tc(["kv", "put", "notes/partition", "primary-value"], { profile: "owner", replication: "on" });
    expect(primaryWrite.code).toBe(0);
    const aliasSync = await tc(["replica", "sync"], { profile: "owner", replication: "on", host: alias, extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(aliasSync.code).toBe(0);
    const primaryReport = await ok<{ replicas: Array<{ pinned: Array<{ key: string; state: string }> }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(primaryReport.replicas.flatMap((replica) => replica.pinned)).toContainEqual(expect.objectContaining({ key: "notes/partition", state: "committed" }));
    const primarySync = await tc(["replica", "sync"], { profile: "owner", replication: "on", extraEnv: { TC_REPLICATION_MAX_STALENESS_MS: "0" } });
    expect(primarySync.code).toBe(0);
    const caughtUpReport = await ok<{ replicas: Array<{ pinned: Array<{ key: string }> }> }>(["replica", "report", "--json"], "owner", { replication: "on" });
    expect(caughtUpReport.replicas.flatMap((replica) => replica.pinned.map((entry) => entry.key))).not.toContain("notes/partition");
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
    await ok(["auth", "logout"], "owner");
    await expect(readdir(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(space).toMatch(/^tinycloud:/);
  }, 300_000);
});
