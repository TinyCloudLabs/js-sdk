import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { startUnregisteredLocationRegistry } from "../../../node-sdk/src/test-support/unregistered-location-registry";
import type { UnregisteredLocationRegistry } from "../../../node-sdk/src/test-support/unregistered-location-registry";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

// TC-3802 on a real node with per-secret keys on (node 1.26.21): a secret on its own key is read by a profile whose
// scoped OpenKey login named only that key's decrypt, with NO put through that profile first. The signed session reports
// each grant with `caveats: []`; a get used to ask for decrypt on the whole network and fail for want of a browser.
// The OpenKey stand-in signs what OpenKey #696 signs. Skipped without TC_NAMED_KEYS_E2E_NODE_BIN.
const NODE_BIN = process.env.TC_NAMED_KEYS_E2E_NODE_BIN;
setDefaultTimeout(120_000);

const root = await mkdtemp(join(tmpdir(), "tc-scoped-get-"));
const home = join(root, "home");
const cliEntry = join(import.meta.dir, "../index.ts");

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

describe.skipIf(!NODE_BIN)("a scoped OpenKey session reads a secret on its own key", () => {
  const wasm = new NodeWasmBindings();
  let node: ChildProcess | undefined;
  let registry: UnregisteredLocationRegistry;
  let host: string;
  let owner: PrivateKeySigner;
  let address: string;
  let ownerDid: string;

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: process.env.PATH ?? "", HOME: home, TC_HOME: home, ...extra };
  }

  async function tc(args: string[], stdin = "", extra: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, cliEntry, "-q", "--json", ...args], { env: env(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(stdin);
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  async function ok(args: string[], stdin = "", extra: Record<string, string> = {}): Promise<string> {
    const run = await tc(args, stdin, extra);
    expect({ args, exitCode: run.exitCode, stderr: run.stderr }).toEqual({ args, exitCode: 0, stderr: "" });
    return run.stdout;
  }

  /** `tc auth login --method openkey --paste` with a manifest, answered the way OpenKey answers it. */
  async function scopedLogin(profile: string, manifest: object): Promise<void> {
    const manifestPath = join(root, `${profile}.manifest.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const child = spawn(process.execPath, [cliEntry, "-q", "--json", "--profile", profile, "--host", host,
      "auth", "login", "--method", "openkey", "--paste", "--no-popup", "--manifest", manifestPath, "--owner", ownerDid, "--expiry", "1h", "--no-renew"],
    { env: env(), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let answered = false;
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      const url = /\/delegate\?(\S+)/.exec(stderr)?.[1];
      if (answered || url === undefined || !stderr.includes("Enter short code")) return;
      answered = true;
      void (async () => {
        const query = new URLSearchParams(url);
        const sessionDid = query.get("did")!;
        const sessionKey = JSON.parse(Buffer.from(query.get("jwk")!, "base64url").toString()) as { kty: string; crv: string; x: string };
        const { permissions } = JSON.parse(Buffer.from(query.get("permissions")!, "base64url").toString());
        const openKey = openKeyDelegate({ wasm, signer: owner, sessionKey, sessionDid });
        const session = await openKey.delegate(sessionDid, { permissions });
        // OpenKey activates the delegation at the node before it hands the code back.
        const activated = await fetch(`${host}/delegate`, { method: "POST", headers: { Authorization: session.delegationHeader.Authorization } });
        expect(activated.status).toBe(200);
        child.stdin!.write(`${JSON.stringify({ ...session, ownerDid, jwk: { kty: sessionKey.kty, crv: sessionKey.crv, x: sessionKey.x } })}\n`);
        child.stdin!.end();
      })();
    });
    const closed = Promise.withResolvers<number | null>();
    child.once("close", closed.resolve);
    const exitCode = await closed.promise;
    expect({ exitCode, stdout: stdout.slice(0, 200), answered }).toMatchObject({ exitCode: 0, answered: true });
  }

  const keyRow = (name: string) => ({
    service: "tinycloud.encryption", space: "encryption", skipPrefix: true, actions: ["decrypt"],
    path: `urn:tinycloud:encryption:${ownerDid}:default/secrets/${name.toLowerCase()}`,
  });
  const readManifest = (name: string) => ({
    app_id: "xyz.tinycloud.scoped-get-e2e", space: "secrets",
    permissions: [
      { service: "tinycloud.kv", path: `vault/secrets/${name}`, actions: ["tinycloud.kv/get"], skipPrefix: true },
      keyRow(name),
    ],
  });

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

    await mkdir(home, { recursive: true });
    // A local-key owner hosts the space and the default network; its wallet key signs the scoped sessions below.
    await ok(["--profile", "owner", "--host", host, "init", "--name", "owner", "--key-only"]);
    const profileFile = join(home, ".tinycloud", "profiles", "owner", "profile.json");
    const config = JSON.parse(await readFile(profileFile, "utf8"));
    await writeFile(profileFile, JSON.stringify({ ...config, tinycloudRegistryUrl: registry.url.origin }));
    await ok(["--profile", "owner", "--host", host, "auth", "login", "--method", "local"]);
    await ok(["--profile", "owner", "--host", host, "secrets", "network", "init"]);
    owner = new PrivateKeySigner((JSON.parse(await readFile(profileFile, "utf8")) as { privateKey: string }).privateKey);
    address = await owner.getAddress();
    ownerDid = `did:pkh:eip155:1:${address}`;
  });

  afterAll(async () => {
    node?.kill("SIGTERM");
    registry?.stop?.();
    await rm(root, { recursive: true, force: true });
  });

  test("a get with no prior put reads the value; another secret is refused, never asked for network-wide decrypt", async () => {
    const value = `scoped-${randomBytes(12).toString("hex")}`;
    // The owner writes both secrets on their own keys (writers default to the older format, so opt in).
    await ok(["--profile", "owner", "secrets", "put", "SCOPED_GET_ONE", "--stdin"], value, { TC_SECRETS_NAMED_KEY_WRITES: "1" });
    await ok(["--profile", "owner", "secrets", "put", "SCOPED_GET_TWO", "--stdin"], "other-value", { TC_SECRETS_NAMED_KEY_WRITES: "1" });
    const { data } = JSON.parse(await ok(["--profile", "owner", "kv", "get", "vault/secrets/SCOPED_GET_ONE", "--space", "secrets"]));
    const envelope = typeof data === "string" ? JSON.parse(data) : data;
    expect({ v: envelope.v, keyPath: envelope.keyPath }).toEqual({ v: 2, keyPath: "secrets/scoped_get_one" });

    await ok(["profile", "create", "scoped", "--host", host, "--registry-url", registry.url.origin]);
    await scopedLogin("scoped", readManifest("SCOPED_GET_ONE"));

    const read = await tc(["--profile", "scoped", "secrets", "get", "SCOPED_GET_ONE"]);
    expect({ exitCode: read.exitCode, stderr: read.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(read.stdout).value).toBe(value);

    const other = await tc(["--profile", "scoped", "secrets", "get", "SCOPED_GET_TWO"]);
    expect(other.exitCode).toBe(5);
    expect(JSON.parse(other.stderr).error.code).toBe("PERMISSION_DENIED");
  });
});
