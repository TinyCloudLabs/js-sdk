import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { startUnregisteredLocationRegistry } from "../../../node-sdk/src/test-support/unregistered-location-registry";
import type { UnregisteredLocationRegistry } from "../../../node-sdk/src/test-support/unregistered-location-registry";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

// TC-3802 on a real node with per-secret keys on (`named_keys_v1`, node 1.26.21 / #703):
//   - an OpenKey owner's `secrets put` then `secrets get` takes one approval (the put asks for the secret's exact key
//     with key.create and decrypt, and to read it back);
//   - a secret on its own key, read on the owner path, stores exactly one grant: its exact key, never the root;
//   - `secrets network grant` is wallet-signed for 1 h by default, so the owner's `account delegations revoke` ends it.
// The OpenKey stand-in signs what OpenKey #696 signs. Skipped without TC_NAMED_KEYS_E2E_NODE_BIN.
const NODE_BIN = process.env.TC_NAMED_KEYS_E2E_NODE_BIN;
setDefaultTimeout(120_000);

const root = await mkdtemp(join(tmpdir(), "tc-per-secret-keys-"));
const home = join(root, "home");
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
process.env.HOME = home;
process.env.TC_HOME = home;
delete process.env.TC_HOST;
// Profile state paths resolve at module load, after TC_HOME points at the test home.
const { profileConfigPath, profilePath, readAdditionalDelegations, sessionPath, writeJsonAtomic } =
  await import("@tinycloud/operations/state");
const { registerSecretsCommand } = await import("./secrets.js");

/** Every file under `dir` (relative path → sha256 and text), to see what a command wrote. */
async function snapshotTree(dir: string): Promise<Map<string, { sha: string; text: string }>> {
  const files = new Map<string, { sha: string; text: string }>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    files.set(path, { sha: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") });
  }
  return files;
}

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
  return promise;
}

describe.skipIf(!NODE_BIN)("per-secret keys against a real node", () => {
  const wasm = new NodeWasmBindings();
  let node: ChildProcess | undefined;
  let registry: UnregisteredLocationRegistry;
  let host: string;
  let owner: PrivateKeySigner;
  let ownerDid: string;
  let spaceId: string;

  async function tc(args: string[], stdin = ""): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../index.ts"), "-q", "--json", ...args], {
      env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  async function ok(args: string[], stdin = ""): Promise<void> {
    const run = await tc(args, stdin);
    expect({ args, exitCode: run.exitCode, stderr: run.stderr }).toEqual({ args, exitCode: 0, stderr: "" });
  }

  /** An OpenKey owner profile whose signed session holds no secret authority, so every secret command asks. */
  async function openKeyOwner(name: string): Promise<{ sessionKey: object; sessionDid: string }> {
    const manager = wasm.createSessionManager();
    const sessionKey = JSON.parse(manager.jwk("default")!);
    const sessionDid = manager.getDID("default");
    const address = await owner.getAddress();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const prepared = wasm.prepareSession({
      abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
      address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk: sessionKey,
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
    });
    const signature = await owner.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    const activated = await fetch(`${host}/delegate`, { method: "POST", headers: { Authorization: session.delegationHeader.Authorization } });
    expect(activated.status).toBe(200);
    await writeJsonAtomic(profileConfigPath(name), {
      name, host, tinycloudRegistryUrl: registry.url.origin, chainId: 1, spaceName: "secrets", spaceId,
      did: ownerDid, sessionDid, ownerDid, operatorType: "human", authMethod: "openkey", posture: "owner-openkey",
      createdAt: new Date().toISOString(),
    });
    await writeJsonAtomic(join(profilePath(name), "key.json"), sessionKey);
    await writeJsonAtomic(sessionPath(name), {
      ...session, jwk: sessionKey, address, chainId: 1, spaceId, verificationMethod: sessionDid,
      siwe: prepared.siwe, signature, ownerDid, expiresAt, tinycloudHosts: [host],
    });
    return { sessionKey, sessionDid };
  }

  /** Run one secrets command in this process as an owner at a terminal, approving through the OpenKey stand-in. */
  async function asOpenKeyOwner(profile: string, keys: { sessionKey: object; sessionDid: string }, args: string[]) {
    const openKey = openKeyDelegate({ wasm, signer: owner, ...keys });
    let stdout = "";
    const output = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = output.write;
    const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`secrets ${args[0]} exited with ${code}`);
    }) as typeof process.exit);
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    output.write = (chunk: unknown) => { stdout += String(chunk); return true; };
    try {
      const program = new Command();
      program.option("-p, --profile <name>").option("--json");
      registerSecretsCommand(program, (did, options) => openKey.delegate(did, options));
      await program.parseAsync(["node", "tc", "--profile", profile, "--json", "secrets", ...args], { from: "node" });
    } catch (error) {
      // Name what the stand-in refused, if anything; the CLI reports only "invalid approval request".
      throw new Error(`${(error as Error).message}; refused: ${JSON.stringify(openKey.refusals.map((refusal) => refusal.message))}`);
    } finally {
      output.write = originalWrite;
      exit.mockRestore();
      if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
    return { stdout, requests: openKey.requests, refusals: openKey.refusals };
  }

  const encryptionPaths = async (profile: string) =>
    (await readAdditionalDelegations<{ authorityRequest?: { requested?: Array<{ service: string; path?: string }> } }>(profile))
      .map((record) => (record.authorityRequest?.requested ?? [])
        .filter((permission) => permission.service === "tinycloud.encryption").map((permission) => permission.path));

  beforeAll(async () => {
    await mkdir(join(root, "node", "data"), { recursive: true });
    const port = await freePort();
    host = `http://127.0.0.1:${port}`;
    registry = startUnregisteredLocationRegistry();
    node = spawn(NODE_BIN!, [], {
      cwd: join(root, "node"),
      env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: root,
        TINYCLOUD_STORAGE__DATADIR: join(root, "node", "data"),
        TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: "127.0.0.1", ROCKET_PORT: String(port), ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static", TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
        TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1: "true",
        TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH: join(root, "node", "ledger"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = Promise.withResolvers<void>();
    let window = "";
    const onData = (chunk: Buffer) => {
      window = (window + chunk.toString()).slice(-128);
      if (window.includes("Rocket has launched")) launched.resolve();
    };
    node.stdout?.on("data", onData);
    node.stderr?.on("data", onData);
    node.once("close", (code) => launched.reject(new Error(`node exited before launch (${code})`)));
    await launched.promise;

    // A local-key owner hosts the space, creates the default network and makes the first round trip.
    await ok(["--profile", "owner", "--host", host, "init", "--name", "owner", "--key-only"]);
    const config = JSON.parse(await readFile(profileConfigPath("owner"), "utf8"));
    await writeJsonAtomic(profileConfigPath("owner"), { ...config, tinycloudRegistryUrl: registry.url.origin });
    await ok(["--profile", "owner", "--host", host, "auth", "login", "--method", "local"]);
    await ok(["--profile", "owner", "--host", host, "secrets", "network", "init"]);
    const signed = JSON.parse(await readFile(profileConfigPath("owner"), "utf8")) as { privateKey: string };
    owner = new PrivateKeySigner(signed.privateKey);
    ownerDid = `did:pkh:eip155:1:${await owner.getAddress()}`;
    spaceId = wasm.makeSpaceId(await owner.getAddress(), 1, "secrets");
  });

  afterAll(async () => {
    node?.kill("SIGTERM");
    registry?.stop?.();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTcHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = originalTcHome;
    await rm(root, { recursive: true, force: true });
  });

  test("a local-key owner's put then get reads the value back with no approval", async () => {
    const value = `local-${randomBytes(12).toString("hex")}`;
    await ok(["--profile", "owner", "secrets", "put", "LOCAL_ROUNDTRIP", "--stdin"], value);
    const read = await tc(["--profile", "owner", "secrets", "get", "LOCAL_ROUNDTRIP"]);
    expect({ exitCode: read.exitCode, stderr: read.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(read.stdout).value).toBe(value);
  });

  test("a `secrets network grant` lasts 1 h by default and the owner's `account delegations revoke` ends it", async () => {
    const recipient = wasm.createSessionManager().getDID("default").split("#")[0]!;
    const before = Date.now();
    const granted = await tc(["--profile", "owner", "secrets", "network", "grant", recipient]);
    expect({ exitCode: granted.exitCode, stderr: granted.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const { cid, expiresAt } = JSON.parse(granted.stdout) as { cid: string; expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(before);
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(Date.now() + 3_600_000);

    // A session-signed encryption-only grant answers 403 here (the node lets an owner revoke it only as delegator).
    const revoked = await tc(["--profile", "owner", "account", "delegations", "revoke", cid, "--space", "secrets"]);
    expect({ exitCode: revoked.exitCode, stderr: revoked.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(revoked.stdout)).toMatchObject({ cid, revoked: true });
  });

  test("a CLI agent asks for one secret, the owner grants exactly that, and the agent reads the value on its own key", async () => {
    const value = `agent-${randomBytes(12).toString("hex")}`;
    await ok(["--profile", "owner", "secrets", "put", "AGENT_V2", "--stdin"], value);
    await ok(["profile", "create", "agent", "--posture", "delegate-session", "--host", host, "--registry-url", registry.url.origin]);

    // The agent first holds a read of the secret's record, as an agent set up for it would.
    const kvRequest = join(root, "agent-kv-request.json");
    await ok(["--profile", "agent", "auth", "request", "--cap", `tinycloud.kv:${spaceId}:vault/secrets/AGENT_V2:get`, "--emit", kvRequest]);
    const kvGrant = await tc(["--profile", "owner", "auth", "grant", kvRequest]);
    expect(kvGrant.exitCode).toBe(0);
    await Bun.write(join(root, "agent-kv-grant.json"), kvGrant.stdout);
    await ok(["--profile", "agent", "auth", "import", join(root, "agent-kv-grant.json")]);

    // The agent asks for the secret: the CLI stores the request it needs approved, on the secret's own key.
    const asked = await tc(["--profile", "agent", "secrets", "get", "AGENT_V2"]);
    expect(asked.exitCode).not.toBe(0);
    const { readProfileStore } = await import("@tinycloud/operations/state");
    const stored = (await readProfileStore<{ requested: Array<{ service: string; path: string }> }>("agent", "auth-requests")).records;
    const request = stored.at(-1)!;
    expect(request.requested.map(({ service, path }) => ({ service, path }))).toEqual([{
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${ownerDid}:default/secrets/agent_v2`,
    }]);

    // The owner approves exactly the stored request with `tc auth grant`: the owner's wallet key signs a one-use
    // session holding just that secret's key, and the grant is cut from it (1 h, the secret-key default).
    const requestFile = join(root, "agent-secret-request.json");
    await Bun.write(requestFile, JSON.stringify(request));
    const before = Date.now();
    const treeBefore = await snapshotTree(home);
    const granted = await tc(["--profile", "owner", "auth", "grant", requestFile]);
    expect({ exitCode: granted.exitCode, stderr: granted.stderr.slice(-300) }).toMatchObject({ exitCode: 0 });
    // The one-use session is never written: the owner's stored session and profile are byte-for-byte unchanged, and no
    // file anywhere under the home holds a signed sign-in message or a private key that was not there before.
    const treeAfter = await snapshotTree(home);
    for (const stable of [sessionPath("owner"), profileConfigPath("owner")]) {
      expect(treeAfter.get(stable)?.sha).toBe(treeBefore.get(stable)?.sha);
    }
    for (const [path, file] of treeAfter) {
      if (treeBefore.get(path)?.sha === file.sha) continue;
      expect({ path, signedSignIn: /wants you to sign in with your Ethereum account/.test(file.text) }).toEqual({ path, signedSignIn: false });
      expect({ path, privateJwk: /"kty"\s*:\s*"OKP"[^}]*"d"\s*:/.test(file.text) || /"d"\s*:[^}]*"kty"\s*:\s*"OKP"/.test(file.text) }).toEqual({ path, privateJwk: false });
    }
    const grant = JSON.parse(granted.stdout) as { delegation: { path: string }; expiry: string };
    expect(grant.delegation.path).toBe(request.requested[0]!.path);
    expect(Date.parse(grant.expiry)).toBeGreaterThan(before);
    expect(Date.parse(grant.expiry)).toBeLessThanOrEqual(Date.now() + 3_600_000);
    await Bun.write(join(root, "agent-secret-grant.json"), granted.stdout);
    await ok(["--profile", "agent", "auth", "import", join(root, "agent-secret-grant.json")]);

    const read = await tc(["--profile", "agent", "secrets", "get", "AGENT_V2"]);
    expect({ exitCode: read.exitCode, stderr: read.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(read.stdout).value).toBe(value);
  });

  test("one `tc auth grant` of a request holding the record read and the secret's key covers both", async () => {
    const value = `agent-${randomBytes(12).toString("hex")}`;
    await ok(["--profile", "owner", "secrets", "put", "AGENT_V2_ONCE", "--stdin"], value);
    await ok(["profile", "create", "agent-once", "--posture", "delegate-session", "--host", host, "--registry-url", registry.url.origin]);

    // The agent asks for the record read and the secret's own key in one request.
    const permissionFile = join(root, "agent-once-permissions.json");
    await Bun.write(permissionFile, JSON.stringify({
      permissions: [
        { service: "tinycloud.kv", space: spaceId, path: "vault/secrets/AGENT_V2_ONCE", skipPrefix: true, actions: ["tinycloud.kv/get"] },
        {
          service: "tinycloud.encryption",
          path: `urn:tinycloud:encryption:${ownerDid}:default/secrets/agent_v2_once`,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ],
    }));
    const kvRequest = join(root, "agent-once-request.json");
    await ok(["--profile", "agent-once", "auth", "request", "--permission", permissionFile, "--emit", kvRequest]);

    const granted = await tc(["--profile", "owner", "auth", "grant", kvRequest]);
    expect({ exitCode: granted.exitCode, stderr: granted.stderr.slice(-300) }).toMatchObject({ exitCode: 0 });
    await Bun.write(join(root, "agent-once-grant.json"), granted.stdout);
    await ok(["--profile", "agent-once", "auth", "import", join(root, "agent-once-grant.json")]);

    const read = await tc(["--profile", "agent-once", "secrets", "get", "AGENT_V2_ONCE"]);
    expect({ exitCode: read.exitCode, stderr: read.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(read.stdout).value).toBe(value);
  });

  test("an OpenKey owner's put then get takes one approval, on the secret's exact key", async () => {
    const keys = await openKeyOwner("openkey-writer");
    const value = `openkey-${randomBytes(12).toString("hex")}`;

    const put = await asOpenKeyOwner("openkey-writer", keys, ["put", "OPENKEY_ROUNDTRIP", value]);
    expect(put.refusals).toEqual([]);
    expect(put.requests).toHaveLength(1);
    const get = await asOpenKeyOwner("openkey-writer", keys, ["get", "OPENKEY_ROUNDTRIP"]);
    expect(get.requests).toEqual([]);
    expect(JSON.parse(get.stdout).value).toBe(value);
    expect(await encryptionPaths("openkey-writer")).toEqual([[`urn:tinycloud:encryption:${ownerDid}:default/secrets/openkey_roundtrip`]]);
  });

  test("a secret on its own key, read on the owner path, stores exactly one grant: the exact key, no root", async () => {
    const keys = await openKeyOwner("openkey-reader");
    const read = await asOpenKeyOwner("openkey-reader", keys, ["get", "OPENKEY_ROUNDTRIP"]);
    expect(read.refusals).toEqual([]);
    expect(read.requests).toHaveLength(1);
    expect(JSON.parse(read.stdout).name).toBe("OPENKEY_ROUNDTRIP");
    expect(await encryptionPaths("openkey-reader")).toEqual([[`urn:tinycloud:encryption:${ownerDid}:default/secrets/openkey_roundtrip`]]);
  });
});
