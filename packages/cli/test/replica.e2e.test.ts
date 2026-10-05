/**
 * `tc replica` against a real TinyCloud node, through the public CLI only
 * (TC-18). Spawns the built CLI (`node dist/index.js`) in an isolated
 * TC_HOME, and a node binary on SQLite in a temp data directory.
 *
 * Needs TC_REPLICA_E2E_NODE_BIN: a tinycloud node binary serving
 * `kv-sync-v1` (tinycloud-node ≥ d7f511f). Build the CLI first. Set
 * TC_REPLICA_E2E_DATABASE_URL (a fresh, empty database) to run the node on
 * Postgres instead of SQLite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contentHash as hash } from "@tinycloud/replica";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN;
const DATABASE_URL = process.env.TC_REPLICA_E2E_DATABASE_URL || undefined;
const CLI = resolve(import.meta.dir, "../dist/index.js");
const NO_NETWORK = resolve(import.meta.dir, "../test-support/no-network.cjs");
const NODE20 = resolve(import.meta.dir, "../test-support/node20.cjs");

type Run = { code: number; stdout: Buffer; stderr: string };

async function freePort(): Promise<number> {
  const { promise, resolve: done, reject: fail } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => done(port));
  });
  return promise;
}

/** The test's own environment, without a host or profile that would redirect the CLI. */
const { TC_HOST: _host, TC_PROFILE: _profile, ...ambient } = process.env;

type SyncOutput = { sync: Record<string, unknown>; status: { counts: unknown; source: unknown } };

describe.skipIf(!NODE_BIN)(`tc replica against a real node (${DATABASE_URL === undefined ? "SQLite" : "Postgres"})`, () => {
  let home: string;
  let dataDir: string;
  let host: string;
  let port: number;
  let node: ChildProcess | undefined;
  let space: string;
  const nodeSecret = randomBytes(48).toString("base64url");

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
        // One static host key across restarts: the feed cursor is sealed under it.
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: nodeSecret,
        // Optional: run the node on Postgres (a fresh database per run) instead of SQLite.
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
    child.once("exit", (code) => launched.reject(new Error(`node exited (${code}) before launching:\n${output.slice(-2000)}`)));
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

  async function tc(args: string[], options: { profile: string; preload?: string; input?: string }): Promise<Run> {
    const netLog = join(home, "network-attempts.log");
    const child = spawn(
      "node",
      [...(options.preload ? ["--require", options.preload] : []), CLI, "-q", "--json", "--profile", options.profile, ...args],
      {
        cwd: home,
        env: { ...ambient, TC_HOME: home, HOME: home, TC_NO_NETWORK_LOG: netLog },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = Promise.withResolvers<number>();
    child.once("exit", (exit) => exited.resolve(exit ?? -1));
    const code = await exited.promise;
    return { code, stdout: Buffer.concat(stdout), stderr };
  }

  /** Run a command that must succeed; its JSON output, typed by the caller (test-only parse). */
  async function ok<T = unknown>(args: string[], profile: string): Promise<T> {
    const run = await tc(args, { profile });
    if (run.code !== 0) throw new Error(`tc ${args.join(" ")} exited ${run.code}\n${run.stderr}\n${run.stdout}`);
    return JSON.parse(run.stdout.toString()) as T;
  }

  /** A read with the network disabled: any attempt fails the test. */
  async function offline(args: string[]): Promise<Run> {
    return tc(args, { profile: "device", preload: NO_NETWORK });
  }

  // Written out of key order: the feed then lists changes out of key order too.
  const fixtures = {
    "notes/deep/c.json": Buffer.from(JSON.stringify({ c: 3 })),
    "notes/bin": Buffer.from([0, 1, 2, 255, 254, 10, 13]),
    "notes/a.txt": Buffer.from("alpha note"),
  } as const;
  const outOfScope = {
    "notes-secret/x": Buffer.from("OUT-OF-SCOPE-SECRET-BYTES"),
    "other/y": Buffer.from("OUT-OF-SCOPE-OTHER-BYTES"),
  } as const;

  async function put(key: string, bytes: Buffer): Promise<void> {
    const file = join(home, "put.bin");
    await writeFile(file, bytes);
    await ok(["--host", host, "kv", "put", key, "--file", file], "owner");
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "tc-replica-e2e-home-"));
    dataDir = await mkdtemp(join(tmpdir(), "tc-replica-e2e-node-"));
    port = await freePort();
    host = `http://127.0.0.1:${port}`;
    await startNode();
    const info = (await (await fetch(`${host}/info`)).json()) as { features?: string[] };
    expect(info.features).toContain("kv-sync-v1");
  }, 60_000);

  afterAll(async () => {
    await stopNode();
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  test("grant, sync, offline restart reads, catch-up and scope", async () => {
    // 1. The owner writes notes and grants a device key get,list,metadata,sync on notes/.
    await ok(["--host", host, "init", "--name", "owner", "--key-only"], "owner");
    const login = await ok<{ spaceId: string }>(["--host", host, "auth", "login", "--method", "local"], "owner");
    space = login.spaceId;
    for (const [key, bytes] of Object.entries({ ...fixtures, ...outOfScope })) await put(key, bytes);
    await ok(["profile", "create", "device", "--posture", "delegate-session", "--host", host], "device");
    await ok(
      ["auth", "request", "--cap", `tinycloud.kv:${space}:notes/:get,list,metadata,sync`, "--expiry", "30d", "--emit", "req.json"],
      "device",
    );
    const grant = await tc(["auth", "grant", "req.json", "--yes"], { profile: "owner" });
    expect(grant.code).toBe(0);
    await writeFile(join(home, "grant.json"), grant.stdout);
    await ok(["auth", "import", "grant.json"], "device");

    // 2. tc replica sync.
    const first = await ok<SyncOutput>(["replica", "sync", "--prefix", "notes/"], "device");
    expect(first.sync).toMatchObject({ changes: 3, fetched: 3, coverage: "complete", promotedGrant: true });
    expect(first.status.counts).toEqual({ keys: 3, contentMissing: 0, tombstones: 0 });
    expect(first.status.source).toMatchObject({ host, space, prefix: "notes/" });

    // 3. Stop the node; a new CLI process reads blake3-identical bytes with the network disabled.
    await stopNode();
    for (const [key, bytes] of Object.entries(fixtures)) {
      const read = await offline(["replica", "get", key, "--raw"]);
      expect(read.code).toBe(0);
      expect(hash(read.stdout)).toBe(hash(bytes));
    }
    const listed = await offline(["replica", "list"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout.toString()).keys.map((entry: { key: string }) => entry.key)).toEqual(Object.keys(fixtures).sort());
    const toFile = await offline(["replica", "get", "notes/bin", "-o", "bin.out"]);
    expect(toFile.code).toBe(0);
    expect(hash(await readFile(join(home, "bin.out")))).toBe(hash(fixtures["notes/bin"]));
    const outside = await offline(["replica", "get", "notes-secret/x"]);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("NOT_COVERED");
    const status = await offline(["replica", "status"]);
    expect(JSON.parse(status.stdout.toString()).replicas[0].authority.state).toBe("valid");
    expect(await readFile(join(home, "network-attempts.log"), "utf8").catch(() => "")).toBe("");
    // The preload really blocks: an online command under it records its attempt.
    const blockedSync = await offline(["replica", "sync"]);
    expect(blockedSync.code).toBe(6);
    expect(await readFile(join(home, "network-attempts.log"), "utf8")).toContain("127.0.0.1");
    await rm(join(home, "network-attempts.log"));
    // With the node down, sync is a network error and reads still work.
    const down = await tc(["replica", "sync"], { profile: "device" });
    expect(down.code).toBe(6);
    expect((await offline(["replica", "get", "notes/a.txt", "--raw"])).code).toBe(0);

    // 4. Restart the node; the owner updates, deletes and adds while the device is away.
    await startNode();
    const added = Buffer.from("gamma");
    await put("notes/deep/new", added);
    const updated = Buffer.from("alpha note, second version");
    await put("notes/a.txt", updated);
    await ok(["--host", host, "kv", "delete", "notes/bin"], "owner");
    await put("notes-secret/x", Buffer.from("OUT-OF-SCOPE-SECRET-BYTES-2"));

    // 5. Sync; the replica converges.
    const second = await ok<SyncOutput>(["replica", "sync"], "device");
    expect(second.sync).toMatchObject({ changes: 3, deleted: 1, fetched: 2, resets: 0 });
    expect(second.status.counts).toEqual({ keys: 3, contentMissing: 0, tombstones: 1 });
    expect((await ok<SyncOutput>(["replica", "sync"], "device")).sync).toMatchObject({ changes: 0, cursorAdvanced: false });
    await stopNode();
    expect(hash((await offline(["replica", "get", "notes/a.txt", "--raw"])).stdout)).toBe(hash(updated));
    expect(hash((await offline(["replica", "get", "notes/deep/new", "--raw"])).stdout)).toBe(hash(added));
    const deleted = await offline(["replica", "get", "notes/bin"]);
    expect(deleted.code).toBe(4);
    expect(deleted.stderr).toContain("KEY_DELETED");
    expect((await offline(["replica", "get", "notes/never"])).code).toBe(4);

    // 6. Nothing outside notes/ reached the replica's files: no names, no bytes.
    const dir = join(home, ".tinycloud", "profiles", "device", "replicas", "notes");
    const files: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await walk(child);
        else files.push(child);
      }
    };
    await walk(dir);
    expect(files.some((file) => file.endsWith("replica.db"))).toBe(true);
    for (const file of files) {
      const bytes = await readFile(file);
      for (const needle of ["notes-secret", "other/y", "OUT-OF-SCOPE"]) {
        expect({ file, found: bytes.includes(needle) }).toEqual({ file, found: false });
      }
    }
    expect(await readFile(join(home, "network-attempts.log"), "utf8").catch(() => "")).toBe("");
    await startNode();
  }, 180_000);

  test("an expired grant blocks offline reads; a retain grant keeps them, marked expired, until retainUntil", async () => {
    // Real waits: grant windows are signed absolute times that the node attests
    // and the spawned CLI enforces with its own clock, which a test cannot
    // move. node-sdk refuses to issue a grant expiring within 60 s, so these
    // are about the shortest windows the public CLI can produce.
    const waitUntil = async (iso: string) => {
      const remaining = Date.parse(iso) + 1500 - Date.now();
      if (remaining > 0) await Bun.sleep(remaining);
    };
    await ok(["profile", "create", "dev2", "--posture", "delegate-session", "--host", host], "dev2");
    const grant = async (actions: string, expiry: string, file: string): Promise<string> => {
      await ok(["auth", "request", "--cap", `tinycloud.kv:${space}:notes/:${actions}`, "--expiry", expiry, "--emit", `${file}.req.json`], "dev2");
      const granted = await tc(["auth", "grant", `${file}.req.json`, "--yes"], { profile: "owner" });
      if (granted.code !== 0) throw new Error(`tc auth grant exited ${granted.code}\n${granted.stderr}`);
      await writeFile(join(home, `${file}.json`), granted.stdout);
      return (await ok<{ delegationCid: string }>(["auth", "import", `${file}.json`], "dev2")).delegationCid;
    };
    await grant("get,list,metadata,sync", "75s", "short-sync");
    const retain = await grant("retain", "150s", "retain");

    type Authority = { expiresAt: string; retainUntil: string | null; retentionGrantCid: string | null };
    const plain = await ok<{ status: { authority: Authority } }>(["replica", "sync", "--prefix", "notes/", "--replica", "plain"], "dev2");
    expect(plain.status.authority.retainUntil).toBeNull();
    const kept = await ok<{ status: { authority: Authority } }>(
      ["replica", "sync", "--prefix", "notes/", "--replica", "keep", "--retention-grant", retain],
      "dev2",
    );
    expect(kept.status.authority).toMatchObject({ retentionGrantCid: retain });
    const retainUntil = kept.status.authority.retainUntil!;
    expect(Date.parse(retainUntil)).toBeGreaterThan(Date.parse(kept.status.authority.expiresAt));

    const read = (replica: string) => tc(["replica", "get", "notes/a.txt", "--replica", replica], { profile: "dev2", preload: NO_NETWORK });
    expect((await read("plain")).code).toBe(0);
    await waitUntil(plain.status.authority.expiresAt);

    const expired = await read("plain");
    expect({ code: expired.code, stderr: expired.stderr }).toMatchObject({ code: 5, stderr: expect.stringContaining("GRANT_EXPIRED") });
    const retained = await read("keep");
    expect(retained.code).toBe(0);
    expect(JSON.parse(retained.stdout.toString()).meta.authority).toBe("expired");
    // No new sync after expiry, decided before any network attempt.
    const refused = await tc(["replica", "sync", "--replica", "keep"], { profile: "dev2", preload: NO_NETWORK });
    expect({ code: refused.code, stderr: refused.stderr }).toMatchObject({ code: 5, stderr: expect.stringContaining("GRANT_EXPIRED") });
    expect(await readFile(join(home, "network-attempts.log"), "utf8").catch(() => "")).toBe("");

    await waitUntil(retainUntil);
    const ended = await read("keep");
    expect({ code: ended.code, stderr: ended.stderr }).toMatchObject({ code: 5, stderr: expect.stringContaining("GRANT_EXPIRED") });
  }, 240_000);

  test("on Node.js 20, tc replica fails with RUNTIME_UNSUPPORTED and other commands still run", async () => {
    const replica = await tc(["replica", "status"], { profile: "device", preload: NODE20 });
    expect(replica.code).toBe(1);
    expect(replica.stderr).toContain("RUNTIME_UNSUPPORTED");
    const other = await tc(["profile", "list"], { profile: "device", preload: NODE20 });
    expect(other.code).toBe(0);
  });
});
