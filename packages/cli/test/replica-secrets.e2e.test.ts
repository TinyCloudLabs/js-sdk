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
  let scopedSecret: string;
  let secretsDir: string;
  const nodeSecret = randomBytes(48).toString("base64url");
  const ownerName = `TC733_${randomBytes(8).toString("hex").toUpperCase()}`;
  const secretMarker = secretValue();
  const scopedMarker = secretValue();
  const outsideMarker = secretValue();
  const shortName = "secret-values";

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
    let safeOutput = "";
    const onData = (chunk: Buffer) => {
      safeOutput += chunk.toString();
      if (!sawLaunch && safeOutput.includes("Rocket has launched")) {
        sawLaunch = true;
        launched.resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => {
      if (!sawLaunch) {
        const safe = safeOutput
          .replaceAll(nodeSecret, "[redacted]")
          .replaceAll(secretMarker, "[redacted]")
          .replaceAll(scopedMarker, "[redacted]")
          .replaceAll(outsideMarker, "[redacted]");
        launched.reject(new Error(`local node exited before launch on port ${port} (${code}): ${safe.slice(-1200)}`));
      }
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

  async function tc(args: string[], profile: string, offline = false): Promise<Run> {
    const child = spawn("node", [
      ...(offline ? ["--require", NO_NETWORK] : []), CLI, "-q", "--json", "--profile", profile, ...args,
    ], {
      cwd: home,
      env: { ...cliEnvBase, TMPDIR: temp, TC_HOME: home, HOME: home, TC_NO_NETWORK_LOG: join(home, "network.log") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number>((resolveExit) => child.once("exit", (value) => resolveExit(value ?? -1)));
    return { code, stdout: Buffer.concat(stdout), stderr };
  }

  async function ok<T = unknown>(args: string[], profile: string): Promise<T> {
    const result = await tc(args, profile);
    if (result.code !== 0) {
      let code = "unknown";
      try {
        code = String((JSON.parse(result.stderr) as { error?: { code?: unknown } }).error?.code ?? code);
      } catch {
        // Keep failure output limited to a classification, never command data.
      }
      throw new Error(`local tc command failed with exit ${result.code} (${code})`);
    }
    return JSON.parse(result.stdout.toString()) as T;
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
    expect(features.features).toContain("kv-sync-v1");

    await ok(["--host", host, "init", "--name", "owner", "--key-only"], "owner");
    await ok(["--host", host, "auth", "login", "--method", "local"], "owner");
    const network = await ok<{ networkId: string }>(["--host", host, "secrets", "network", "init"], "owner");
    encryptionNetworkId = network.networkId;
    await ok(["--host", host, "secrets", "put", ownerName, secretMarker], "owner");
    scopedSecret = `vault/secrets/scoped/TC733/${ownerName}`;
    outOfScope = `vault/private/${ownerName}`;
    // A random secret name and random bytes are test fixtures only.
    await ok(["--host", host, "secrets", "put", ownerName, scopedMarker, "--scope", "TC733"], "owner");
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
        ],
      },
    });
    await ownerSdk.signIn();
    const privateWrite = await ownerSdk.kvForSpace(secretsSpace).put(outOfScope, outsideMarker);
    const variableWrite = await ownerSdk.kvForSpace(secretsSpace).put("variables/TC733", outsideMarker);
    expect([privateWrite.ok, variableWrite.ok]).toEqual([true, true]);
    await ok(["profile", "create", "device", "--posture", "delegate-session", "--host", host], "device");
    const deviceProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "device", "profile.json"), "utf8")) as Profile;
    deviceDid = deviceProfile.did.split("#", 1)[0]!;
    await ok(["auth", "request", "--cap", `tinycloud.kv:${secretsSpace}:vault/secrets/:get,list,metadata,sync`, "--expiry", "30d", "--emit", "req.json"], "device");
    const grant = await tc(["auth", "grant", "req.json", "--yes"], "owner");
    if (grant.code !== 0) throw new Error("local owner could not issue replica grant");
    await writeFile(join(home, "grant.json"), grant.stdout);
    syncGrantCid = (await ok<{ delegationCid: string }>(["auth", "import", "grant.json"], "device")).delegationCid;
    const sync = await ok<{ sync: unknown }>(["replica", "sync", "--replica", shortName, "--space", secretsSpace, "--prefix", "vault/secrets/", "--allow-secrets"], "device");
    expect(sync.sync).toBeDefined();
    encrypted = `vault/secrets/${ownerName}`;
    secretsDir = join(home, ".tinycloud", "profiles", "device", "replicas", shortName);
  }, 180_000);

  afterAll(async () => {
    await stopNode();
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("replicates_ciphertext_not_plaintext", async () => {
    const files = await replicaBytes();
    expect(files.some((bytes) => bytes.includes(Buffer.from(secretMarker)))).toBe(false);
    expect(files.some((bytes) => bytes.includes(Buffer.from(scopedMarker)))).toBe(false);
    const envelope = JSON.parse((await tc(["replica", "get", encrypted, "--replica", shortName, "--raw"], "device")).stdout.toString()) as Record<string, unknown>;
    expect(envelope).toMatchObject({ v: 1, alg: "x25519-aes256gcm/v1", networkId: expect.any(String), keyVersion: expect.any(Number) });
    expect(typeof envelope.encryptedSymmetricKey).toBe("string");
    expect(typeof envelope.encryptedSymmetricKeyHash).toBe("string");
    expect(typeof envelope.ciphertext).toBe("string");
    expect(envelope.metadata).toMatchObject({ contentType: "application/json" });
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
    expect(denied.code).not.toBe(0);
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
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout.toString()).value === secretMarker).toBe(true);
  });
  test("cold_offline_decrypt_requires_key_release", async () => {
    await stopNode();
    const cached = await tc(["replica", "get", encrypted, "--replica", shortName, "--raw"], "device", true);
    expect(cached.code).toBe(0);
    const result = await tc(["secrets", "get", ownerName], "device", true);
    expect(result.code).not.toBe(0);
    expect(result.stdout.includes(Buffer.from(secretMarker))).toBe(false);
    expect((await readFile(join(home, "network.log"), "utf8")).includes(host)).toBe(true);
    // The envelope is local; decrypt still needs online node key release,
    // an unexpired decrypt grant, and a device invocation signature.
  });
  test("excludes_sibling_prefix_and_sql_catalog", async () => {
    const files = await replicaBytes();
    for (const bytes of files) {
      expect(bytes.includes(Buffer.from(outOfScope))).toBe(false);
      expect(bytes.includes(Buffer.from("variables/"))).toBe(false);
      expect(bytes.includes(Buffer.from("secret_records"))).toBe(false);
      expect(bytes.includes(Buffer.from(outsideMarker))).toBe(false);
    }
    const outside = await tc(["replica", "get", outOfScope, "--replica", shortName], "device");
    expect(outside.code).toBe(2);
    const db = new Database(join(secretsDir, "replica.db"), { readonly: true });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    db.close();
    expect(tables.some(({ name }) => name === "secret_records")).toBe(false);
    expect(scopedSecret.startsWith("vault/secrets/scoped/")).toBe(true);
    expect(files.some((bytes) => bytes.includes(Buffer.from(scopedSecret)))).toBe(true);
  });

  test("secrets_sync_requires_opt_in", async () => {
    for (const selector of [
      ["--space", secretsSpace],
      ["--space", secretsSpace, "--prefix", "vault/secrets/"],
      ["--prefix", "vault"],
      ["--prefix", "vault/"],
    ]) {
      const denied = await tc(["replica", "sync", ...selector], "device");
      expect(denied.code).toBe(2);
      expect(denied.stderr.includes("SECRETS_OPT_IN_REQUIRED")).toBe(true);
    }
  });

  test("expiry_and_learned_revocation_survive_restart", async () => {
    await ok(["profile", "create", "expiry-device", "--posture", "delegate-session", "--host", host], "expiry-device");
    await ok(["auth", "request", "--cap", `tinycloud.kv:${secretsSpace}:vault/secrets/:get,list,metadata,sync`, "--expiry", "75s", "--emit", "expiry-req.json"], "expiry-device");
    const shortGrant = await tc(["auth", "grant", "expiry-req.json", "--yes"], "owner");
    if (shortGrant.code !== 0) throw new Error("local owner could not issue short-lived replica grant");
    await writeFile(join(home, "expiry-grant.json"), shortGrant.stdout);
    await ok(["auth", "import", "expiry-grant.json"], "expiry-device");
    await ok(["replica", "sync", "--replica", "expiry", "--space", secretsSpace, "--prefix", "vault/secrets/", "--allow-secrets"], "expiry-device");
    // The signed expiry is enforced by the node and CLI wall clocks; fake timers cannot advance either authority check.
    await Bun.sleep(77_000);
    const expired = await tc(["replica", "get", encrypted, "--replica", "expiry"], "expiry-device", true);
    expect(expired.code).toBe(5);

    const ownerProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as Profile;
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
    expect(sync.code).toBe(5);
    const files = await walk(secretsDir);
    const blobs = files.filter((path) => path.includes(`${join(secretsDir, "blobs")}/`));
    expect(blobs.length).toBe(0);
    const storedBytes = await Promise.all(files.map((path) => readFile(path)));
    expect(storedBytes.some((bytes) => bytes.includes(Buffer.from(encrypted)))).toBe(false);
    await stopNode();
    for (const args of [["replica", "get", encrypted, "--replica", shortName], ["replica", "list", "--replica", shortName]]) {
      expect((await tc(args, "device", true)).code).toBe(5);
    }
    const status = await tc(["replica", "status", "--replica", shortName], "device", true);
    const parsed = JSON.parse(status.stdout.toString()) as { authority: { state: string }; counts: unknown };
    expect([status.code, parsed.authority.state, parsed.counts]).toEqual([
      0,
      "revoked",
      { keys: 0, contentMissing: 0, tombstones: 0 },
    ]);
  }, 180_000);

});
