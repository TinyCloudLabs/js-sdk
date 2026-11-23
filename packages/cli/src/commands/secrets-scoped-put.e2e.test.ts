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

// TC-3802 on a real node with per-secret keys on (node 1.26.21): a profile whose scoped OpenKey login holds ONLY
// `key.create` on one secret's own key (plus kv on its vault path) saves that secret with the switch on, creating the key
// and then overwriting through the same key. Its describe signs `key.create` on the exact key, never decrypt. The OpenKey
// stand-in signs what OpenKey #696 signs and activates the delegation at the node first, as OpenKey does.
// Skipped without TC_NAMED_KEYS_E2E_NODE_BIN.
const NODE_BIN = process.env.TC_NAMED_KEYS_E2E_NODE_BIN;
setDefaultTimeout(120_000);

const root = await mkdtemp(join(tmpdir(), "tc-scoped-put-"));
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

// The CLI falls back to openkey.so, its device API and the links API when these are unset. Every child run points them at a
// dead loopback origin, so a stray OpenKey or links call fails at once instead of reaching production. The node host is
// always the loopback node (`--host` or the profile) and TC_HOST is not inherited.
const DEAD_ORIGIN = "http://127.0.0.1:9";
const NO_PROD_ORIGINS = {
  TC_OPENKEY_HOST: DEAD_ORIGIN,
  TC_OPENKEY_API_HOST: DEAD_ORIGIN,
  TC_LINKS_API_ORIGIN: DEAD_ORIGIN,
} as const;

describe.skipIf(!NODE_BIN)("a create-only scoped OpenKey session saves a secret on its own key", () => {
  const wasm = new NodeWasmBindings();
  let node: ChildProcess | undefined;
  let registry: UnregisteredLocationRegistry;
  let host: string;
  let owner: PrivateKeySigner;
  let address: string;
  let ownerDid: string;

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: process.env.PATH ?? "", HOME: home, TC_HOME: home, ...NO_PROD_ORIGINS, ...extra };
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

  const keyRow = (keyPath: string) => ({
    service: "tinycloud.encryption", space: "encryption", skipPrefix: true, actions: ["key.create"],
    path: `urn:tinycloud:encryption:${ownerDid}:default/${keyPath}`,
  });
  const writeManifest = (vaultName: string, keyPath: string) => ({
    app_id: "xyz.tinycloud.scoped-put-e2e", space: "secrets",
    permissions: [
      { service: "tinycloud.kv", path: `vault/secrets/${vaultName}`, actions: ["tinycloud.kv/get", "tinycloud.kv/put"], skipPrefix: true },
      keyRow(keyPath),
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

  test("a create-only session creates then overwrites a secret on its own key, plain and scoped", async () => {
    expect(env()).toMatchObject({ TC_OPENKEY_HOST: DEAD_ORIGIN, TC_OPENKEY_API_HOST: DEAD_ORIGIN, TC_LINKS_API_ORIGIN: DEAD_ORIGIN });
    expect(env().TC_HOST).toBeUndefined();
    const cases = [
      { profile: "writer-plain", args: ["PUT_PLAIN"], vault: "PUT_PLAIN", keyPath: "secrets/put_plain" },
      { profile: "writer-scoped", args: ["PUT_SCOPED", "--scope", "software-factory"], vault: "scoped/software-factory/PUT_SCOPED", keyPath: "secrets/scoped/software-factory/put_scoped" },
    ];
    for (const { profile, args, vault, keyPath } of cases) {
      await ok(["profile", "create", profile, "--host", host, "--registry-url", registry.url.origin]);
      await scopedLogin(profile, writeManifest(vault, keyPath));
      const held = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", profile, "session.json"), "utf8")) as { permissions: Array<{ service: string; actions: string[] }> };
      expect(held.permissions.filter((row) => row.service === "tinycloud.encryption").flatMap((row) => row.actions)).toEqual(["tinycloud.encryption/key.create"]);

      for (const phase of ["create", "overwrite"]) {
        const value = `${phase}-${randomBytes(12).toString("hex")}`;
        const put = await tc(["--profile", profile, "secrets", "put", ...args, "--stdin"], value, { TC_SECRETS_NAMED_KEY_WRITES: "1" });
        expect({ phase, exitCode: put.exitCode, stderr: put.stderr }).toEqual({ phase, exitCode: 0, stderr: "" });
        expect(put.stdout).not.toContain(value);
        const { data } = JSON.parse(await ok(["--profile", "owner", "kv", "get", `vault/secrets/${vault}`, "--space", "secrets"]));
        const envelope = typeof data === "string" ? JSON.parse(data) : data;
        expect({ v: envelope.v, keyPath: envelope.keyPath }).toEqual({ v: 2, keyPath });
        // The owner reads it back, so the stored copy decrypts to what the writer saved.
        const read = JSON.parse(await ok(["--profile", "owner", "secrets", "get", ...args]));
        expect(read.value).toBe(value);
      }
    }
  });
});
