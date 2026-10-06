import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { TinyCloudNode, NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN;
const CLI = resolve(import.meta.dir, "../dist/index.js");
const NO_NETWORK = resolve(import.meta.dir, "../test-support/no-network.cjs");
const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TC_")));
const cliEnvBase = ambient;

type Profile = { privateKey: string; did: string; spaceId: string };


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
function secretValue(): string {
  return `tc733-${randomBytes(48).toString("base64url")}`;
}

describe.skipIf(!NODE_BIN)("tc replica Secrets against a real local SQLite node", () => {
  let home: string;
  let temp: string;
  let nodeData: string;
  let host: string;
  let port: number;
  let node: ChildProcess | undefined;
  let secretsSpace: string;
  let syncGrantCid: string;
  let deviceDid: string;
  let encrypted: string;
  let encryptionNetworkId: string;
  let outOfScope: string;
  let secretsDir: string;
  const nodeSecret = randomBytes(48).toString("base64url");
  const ownerName = `TC733_${randomBytes(8).toString("hex").toUpperCase()}`;
  const secretMarker = secretValue();
  const scopedMarker = secretValue();
  const outsideMarker = secretValue();
  const shortName = "secret-values";
  const catalogMarker = secretValue();

  async function startNode(): Promise<void> {
    const child = spawn(NODE_BIN!, [], {
      cwd: nodeData,
      env: {
        ...ambient,
        TMPDIR: temp,
        TINYCLOUD_STORAGE__DATADIR: join(nodeData, "data"),
        TINYCLOUD_PORT: String(port),
        TINYCLOUD_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: nodeSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    node = child;
    const launched = Promise.withResolvers<void>();
    let sawLaunch = false;
    let launchWindow = "";
    const onData = (chunk: Buffer) => {
      if (!sawLaunch) {
        launchWindow = (launchWindow + chunk.toString()).slice(-64);
        if (launchWindow.includes("Rocket has launched")) {
          sawLaunch = true;
          launched.resolve();
        }
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => {
      if (!sawLaunch) launched.reject(new Error(`local node exited before launch (${code})`));
    });
    await launched.promise;
  }

  async function stopNode(): Promise<void> {
    const child = node;
    node = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.kill("SIGTERM");
    });
  }

  async function tc(args: string[], profile: string, offline = false, stdin?: string): Promise<Run> {
    const child = spawn("node", [
      ...(offline ? ["--require", NO_NETWORK] : []), CLI, "-q", "--json", "--profile", profile, ...args,
    ], {
      cwd: home,
      env: { ...cliEnvBase, TMPDIR: temp, TC_HOME: home, HOME: home, TC_NO_NETWORK_LOG: join(home, "network.log") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin!.end(stdin ?? "");
    const code = await new Promise<number>((resolveExit) => child.once("exit", (value) => resolveExit(value ?? -1)));
    return { code, stdout: Buffer.concat(stdout), stderr };
  }

  async function ok<T = unknown>(args: string[], profile: string, stdin?: string): Promise<T> {
    const result = await tc(args, profile, false, stdin);
    if (result.code !== 0) throw new Error(`local tc command failed with exit ${result.code}`);
    try {
      return JSON.parse(result.stdout.toString()) as T;
    } catch {
      throw new Error("local tc command returned invalid JSON");
    }
  }

  function expectedEnvelope(bytes: Buffer): boolean {
    try {
      const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
      const metadata = value.metadata as Record<string, unknown> | undefined;
      return value.v === 1 &&
        value.alg === "x25519-aes256gcm/v1" &&
        typeof value.networkId === "string" &&
        typeof value.keyVersion === "number" &&
        typeof value.encryptedSymmetricKey === "string" &&
        typeof value.encryptedSymmetricKeyHash === "string" &&
        typeof value.ciphertext === "string" &&
        metadata?.["x-vault-content-type"] === "application/json" &&
        !("symmetricKey" in value) &&
        !("plaintextKey" in value);
    } catch {
      return false;
    }
  }

  function secretReadMatches(bytes: Buffer, expected: string): boolean {
    try {
      const value = JSON.parse(bytes.toString()) as { value?: unknown };
      return value.value === expected;
    } catch {
      return false;
    }
  }

  function scopedSecretCountIsOne(bytes: Buffer): boolean {
    try {
      const value = JSON.parse(bytes.toString()) as { keys?: { key?: unknown }[] };
      return value.keys?.filter(({ key }) =>
        typeof key === "string" && key.startsWith("vault/secrets/scoped/"),
      ).length === 1;
    } catch {
      return false;
    }
  }

  function expiredGrantClassification(result: Run): boolean {
    if (result.code !== 5) return false;
    try {
      const value = JSON.parse(result.stderr) as { error?: { code?: unknown } };
      return value.error?.code === "GRANT_EXPIRED";
    } catch {
      return false;
    }
  }

  function replicaStatusIsRevoked(result: Run): boolean {
    if (result.code !== 0) return false;
    try {
      const value = JSON.parse(result.stdout.toString()) as {
        authority?: { state?: unknown };
        counts?: { keys?: unknown; contentMissing?: unknown; tombstones?: unknown };
      };
      return value.authority?.state === "revoked" &&
        value.counts?.keys === 0 &&
        value.counts.contentMissing === 0 &&
        value.counts.tombstones === 0;
    } catch {
      return false;
    }
  }

  async function walk(path: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) files.push(...await walk(child));
      else files.push(child);
    }
    return files;
  }

  async function replicaBytes(): Promise<Buffer[]> {
    return Promise.all((await walk(secretsDir)).map((path) => readFile(path)));
  }

  async function secretRead(profile: string): Promise<Run> {
    return tc(["secrets", "get", ownerName], profile);
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "tc733-secrets-home-"));
    temp = join(home, "tmp");
    await mkdir(temp, { mode: 0o700 });
    nodeData = await mkdtemp(join(temp, "node-"));
    port = await freePort();
    host = `http://127.0.0.1:${port}`;
    await startNode();
    const features = await (await fetch(`${host}/info`)).json() as { features?: string[] };
    expect(Array.isArray(features.features) && features.features.includes("kv-sync-v1")).toBe(true);

    await ok(["--host", host, "init", "--name", "owner", "--key-only"], "owner");
    await ok(["--host", host, "auth", "login", "--method", "local"], "owner");
    const network = await ok<{ networkId: string }>(["--host", host, "secrets", "network", "init"], "owner");
    encryptionNetworkId = network.networkId;
    await ok(["--host", host, "secrets", "put", ownerName, "--stdin"], "owner", secretMarker);
    outOfScope = `vault/private/${ownerName}`;
    // A random secret name and random bytes are test fixtures only.
    await ok(["--host", host, "secrets", "put", ownerName, "--scope", "TC733", "--stdin"], "owner", scopedMarker);
    const ownerProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as Profile;
    const ownerSigner = new PrivateKeySigner(ownerProfile.privateKey);
    const wasm = new NodeWasmBindings();
    const ownerAddress = await ownerSigner.getAddress();
    secretsSpace = wasm.makeSpaceId(ownerAddress, 1, "secrets");
    const ownerSdk = new TinyCloudNode({
      host,
      privateKey: ownerProfile.privateKey,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "tc733-secrets-fixture",
        name: "TC-733 local fixture",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: "default",
        permissions: [
          { service: "tinycloud.kv", space: "secrets", path: "vault/private/", actions: ["put"] },
          { service: "tinycloud.kv", space: "secrets", path: "variables/", actions: ["put"] },
          { service: "tinycloud.sql", space: "secrets", path: "default", actions: ["schema", "write", "read"] },
        ],
      },
    });
    await ownerSdk.signIn();
    const privateWrite = await ownerSdk.kvForSpace(secretsSpace).put(outOfScope, outsideMarker);
    const variableWrite = await ownerSdk.kvForSpace(secretsSpace).put("variables/TC733", outsideMarker);
    expect(privateWrite.ok && variableWrite.ok).toBe(true);
    const catalog = ownerSdk.sqlForSpace(secretsSpace).db("default");
    const schema = await catalog.execute(`CREATE TABLE IF NOT EXISTS secret_records (
      scope TEXT NOT NULL, name TEXT NOT NULL, provider_id TEXT, custom_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_tested TEXT,
      test_status TEXT, test_message TEXT, PRIMARY KEY(scope, name)
    )`);
    expect(schema.ok).toBe(true);
    const now = new Date().toISOString();
    const catalogWrite = await catalog.execute(
      "INSERT OR REPLACE INTO secret_records (scope, name, custom_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["TC733", ownerName, catalogMarker, now, now],
    );
    expect(catalogWrite.ok).toBe(true);
    const sourceCatalog = await catalog.query(
      "SELECT custom_note FROM secret_records WHERE scope = ? AND name = ?",
      ["TC733", ownerName],
    );
    expect(sourceCatalog.ok && sourceCatalog.data.rows.length === 1 &&
      sourceCatalog.data.rows[0]?.[0] === catalogMarker).toBe(true);
    await ok(["profile", "create", "device", "--posture", "delegate-session", "--host", host], "device");
    const deviceProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "device", "profile.json"), "utf8")) as Profile;
    deviceDid = deviceProfile.did.split("#", 1)[0]!;
    await ok(["auth", "request", "--cap", `tinycloud.kv:${secretsSpace}:vault/secrets/:get,list,metadata,sync`, "--expiry", "30d", "--emit", "req.json"], "device");
    const grant = await tc(["auth", "grant", "req.json", "--yes"], "owner");
    if (grant.code !== 0) throw new Error("local owner could not issue replica grant");
    await writeFile(join(home, "grant.json"), grant.stdout);
    syncGrantCid = (await ok<{ delegationCid: string }>(["auth", "import", "grant.json"], "device")).delegationCid;
    const sync = await ok<{ sync: unknown }>(["replica", "sync", "--replica", shortName, "--space", secretsSpace, "--prefix", "vault/secrets/", "--allow-secrets"], "device");
    expect(sync.sync !== undefined).toBe(true);
    encrypted = `vault/secrets/${ownerName}`;
    secretsDir = join(home, ".tinycloud", "profiles", "device", "replicas", shortName);
  }, 180_000);

  test("replicates_wrapped_keys_and_ciphertext_not_plaintext", async () => {
    const files = await replicaBytes();
    expect(files.some((bytes) => bytes.includes(Buffer.from(secretMarker)))).toBe(false);
    expect(files.some((bytes) => bytes.includes(Buffer.from(scopedMarker)))).toBe(false);
    const envelope = await tc(["replica", "get", encrypted, "--replica", shortName, "--raw"], "device");
    expect(envelope.code === 0 && expectedEnvelope(envelope.stdout)).toBe(true);
  });
  test("store_files_are_owner_only", async () => {
    const inspect = async (directory: string): Promise<void> => {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    };
    await inspect(secretsDir);
  });


  test("decrypt_grant_is_independent", async () => {
    const denied = await secretRead("device");
    expect(denied.code !== 0).toBe(true);
    const ownerProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as Profile;
    const grantor = new TinyCloudNode({
      host,
      privateKey: ownerProfile.privateKey,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "tc733-decrypt-grant",
        name: "TC-733 local decrypt grant",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: "default",
        permissions: [{
          service: "tinycloud.encryption",
          space: "encryption",
          path: encryptionNetworkId,
          actions: ["decrypt"],
        }],
      },
    });
    await grantor.signIn();
    const issued = await grantor.delegateTo(deviceDid, [{
      service: "tinycloud.encryption",
      space: "encryption",
      path: encryptionNetworkId,
      actions: ["decrypt"],
    }]);
    await writeFile(join(home, "decrypt-grant.json"), JSON.stringify(issued.delegation));
    await ok(["auth", "import", "decrypt-grant.json"], "device");
    const allowed = await secretRead("device");
    expect(allowed.code === 0 && secretReadMatches(allowed.stdout, secretMarker)).toBe(true);
  });

  test("secrets_cli_fails_offline_without_local_plaintext", async () => {
    await stopNode();
    const cached = await tc(["replica", "get", encrypted, "--replica", shortName, "--raw"], "device", true);
    expect(cached.code === 0 && expectedEnvelope(cached.stdout)).toBe(true);
    const result = await tc(["secrets", "get", ownerName], "device", true);
    expect(result.code !== 0).toBe(true);
    expect(!result.stdout.includes(Buffer.from(secretMarker)) && !result.stderr.includes(secretMarker)).toBe(true);
    const files = await replicaBytes();
    expect(files.some((bytes) => bytes.includes(Buffer.from(secretMarker)))).toBe(false);
    // Proves offline CLI failure and absence of plaintext fixtures, not that node-side key release was reached.
  });
  test("excludes_sibling_prefix_and_sql_catalog", async () => {
    const files = await replicaBytes();
    for (const bytes of files) {
      expect(bytes.includes(Buffer.from(outOfScope))).toBe(false);
      expect(bytes.includes(Buffer.from("variables/"))).toBe(false);
      expect(bytes.includes(Buffer.from("secret_records"))).toBe(false);
      expect(bytes.includes(Buffer.from(outsideMarker))).toBe(false);
      expect(bytes.includes(Buffer.from(catalogMarker))).toBe(false);
    }
    const outside = await tc(["replica", "get", outOfScope, "--replica", shortName], "device");
    expect(outside.code === 2).toBe(true);
    const db = new Database(join(secretsDir, "replica.db"), { readonly: true });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    db.close();
    expect(tables.some(({ name }) => name === "secret_records")).toBe(false);
    const listed = await tc(["replica", "list", "--replica", shortName], "device");
    expect(listed.code === 0 && scopedSecretCountIsOne(listed.stdout)).toBe(true);
  });

  test("secrets_sync_requires_opt_in", async () => {
    for (const [index, selector] of [
      ["--space", secretsSpace, "--prefix", "unrelated/"],
      ["--space", secretsSpace, "--prefix", "vault/secrets/"],
      ["--prefix", "vault"],
      ["--prefix", "vault/"],
    ].entries()) {
      const denied = await tc(["replica", "sync", "--replica", `denied-${index}`, ...selector], "device", true);
      expect(denied.code).toBe(2);
      expect(denied.stderr.includes("SECRETS_OPT_IN_REQUIRED")).toBe(true);
    }
  });

  test("expiry_and_learned_revocation_survive_restart", async () => {
    if (node === undefined || node.exitCode !== null) await startNode();
    await ok(["profile", "create", "expiry-device", "--posture", "delegate-session", "--host", host], "expiry-device");
    const expiryDevice = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "expiry-device", "profile.json"), "utf8")) as Profile;
    const expiryDid = expiryDevice.did.split("#", 1)[0]!;
    const ownerProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as Profile;
    const grantor = new TinyCloudNode({
      host,
      privateKey: ownerProfile.privateKey,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "tc733-expiry-grant",
        name: "TC-733 expiring replica grant",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: "default",
        permissions: [{
          service: "tinycloud.kv",
          space: "secrets",
          path: "vault/secrets/",
          actions: ["get", "list", "metadata", "sync"],
        }],
      },
    });
    await grantor.signIn();
    const issued = await grantor.delegateTo(expiryDid, [{
      service: "tinycloud.kv",
      space: secretsSpace,
      path: "vault/secrets/",
      actions: ["get", "list", "metadata", "sync"],
    }], { expiry: "75s" });
    await writeFile(join(home, "expiry-grant.json"), JSON.stringify(issued.delegation));
    await ok(["auth", "import", "expiry-grant.json"], "expiry-device");
    await ok(["replica", "sync", "--replica", "expiry", "--space", secretsSpace, "--prefix", "vault/secrets/", "--allow-secrets"], "expiry-device");
    const expiryDir = join(home, ".tinycloud", "profiles", "expiry-device", "replicas", "expiry");
    const snapshotExpiryBlobs = async (): Promise<readonly (readonly [string, Buffer])[]> => {
      const blobRoot = `${join(expiryDir, "blobs")}/`;
      const paths = (await walk(expiryDir)).filter((path) => path.startsWith(blobRoot)).sort();
      return Promise.all(paths.map(async (path) => [path, await readFile(path)] as const));
    };
    const beforeExpiry = await snapshotExpiryBlobs();
    expect(beforeExpiry.length > 0).toBe(true);
    // The signed expiry is enforced by the node and CLI wall clocks; fake timers cannot advance either authority check.
    await Bun.sleep(77_000);
    const expired = await tc(["replica", "get", encrypted, "--replica", "expiry"], "expiry-device", true);
    expect(expiredGrantClassification(expired)).toBe(true);
    const afterExpiry = await snapshotExpiryBlobs();
    expect(afterExpiry.length === beforeExpiry.length).toBe(true);
    expect(afterExpiry.every(([path, bytes], index) =>
      path === beforeExpiry[index]![0] && bytes.equals(beforeExpiry[index]![1])
    )).toBe(true);

    const owner = new TinyCloudNode({
      host,
      privateKey: ownerProfile.privateKey,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "tc733-secrets-e2e",
        name: "TC-733 local test owner",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: "default",
        permissions: [{ service: "tinycloud.delegation", space: "default", path: "", actions: ["revoke"] }],
      },
    });
    await owner.signIn();
    const revoked = await owner.revokeDelegation(syncGrantCid);
    if (!revoked.ok) throw new Error("local owner could not revoke replica grant");
    const sync = await tc(["replica", "sync", "--replica", shortName, "--allow-secrets"], "device");
    expect(sync.code === 5).toBe(true);
    const files = await walk(secretsDir);
    const blobs = files.filter((path) => path.includes(`${join(secretsDir, "blobs")}/`));
    expect(blobs.length === 0).toBe(true);
    const storedBytes = await Promise.all(files.map((path) => readFile(path)));
    expect(storedBytes.some((bytes) => bytes.includes(Buffer.from(encrypted)))).toBe(false);
    await stopNode();
    for (const args of [["replica", "get", encrypted, "--replica", shortName], ["replica", "list", "--replica", shortName]]) {
      expect((await tc(args, "device", true)).code === 5).toBe(true);
    }
    const status = await tc(["replica", "status", "--replica", shortName], "device", true);
    expect(replicaStatusIsRevoked(status)).toBe(true);
  }, 180_000);

});
