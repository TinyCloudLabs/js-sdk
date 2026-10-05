import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

// A grant of only raw decrypt on the owner's encryption network names no
// space. Every producer must store it so a fresh process installs it again:
// `auth request --grant` and a secret read's escalation on a local-key owner
// (a raw-only CACAO), and an OpenKey escalation (anchored in the secrets
// space). Each profile's session already reads the secret's KV entry, so the
// grant is the only source of decrypt. Real profile files, the real CLI under
// Bun and Node, and a loopback node that activates grants and serves the secret.

const SECRET = "HERMETIC_DELEGATION_CANARY";
const CANARY = "tc-raw-decrypt-grant-canary";
const home = await mkdtemp(join(tmpdir(), "tc-raw-decrypt-grant-"));
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
process.env.HOME = home;
process.env.TC_HOME = home;
delete process.env.TC_HOST;

interface HermeticNode {
  readonly host: string;
  readonly ownerPrivateKey: string;
  readonly ownerDid: string;
  nativeBearerStats(): Readonly<{ delegations: number }>;
  provisionSecret(): void;
  stop(): void;
}
// Loaded by URL: the node-sdk fixture lives outside this package's rootDir.
const hermeticModule = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: { secretPayloadValue: string }): Promise<HermeticNode> };
// Profile state paths resolve at module load, after TC_HOME points at the test home.
const { profileConfigPath, profilePath, readAdditionalDelegations, sessionPath, writeJsonAtomic } =
  await import("@tinycloud/operations/state");
const { registerSecretsCommand } = await import("./secrets.js");

const wasm = new NodeWasmBindings();
let hermetic: HermeticNode;
let owner: PrivateKeySigner;
let spaceId: string;
let rawOnlyRequest: string;

// Each test starts real CLI processes; Node startup alone takes most of a second.
const CLI_TIMEOUT_MS = 30_000;

const cliRuntimes: Array<[string, string[]]> = [
  ["bun", [process.execPath, join(import.meta.dir, "../index.ts")]],
  ["node", [process.env.NODE_BINARY ?? "node", join(import.meta.dir, "../../bin/tc")]],
];

beforeAll(async () => {
  hermetic = await hermeticModule.createHermeticEncryptedNode({ secretPayloadValue: CANARY });
  hermetic.provisionSecret();
  owner = new PrivateKeySigner(hermetic.ownerPrivateKey);
  spaceId = wasm.makeSpaceId(await owner.getAddress(), 1, "secrets");
  rawOnlyRequest = join(home, "raw-only.json");
  await writeFile(rawOnlyRequest, JSON.stringify({
    permissions: [{
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${hermetic.ownerDid}:default`,
      actions: ["tinycloud.encryption/decrypt"],
    }],
  }));
});

afterAll(async () => {
  hermetic?.stop();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

/** An owner profile whose signed session reads the secret's KV entry but cannot decrypt it. */
async function ownerProfile(name: string, kind: "local" | "openkey"): Promise<{ sessionKey: object; sessionDid: string }> {
  const manager = wasm.createSessionManager();
  const sessionKey = JSON.parse(manager.jwk("default")!);
  const sessionDid = manager.getDID("default");
  const address = await owner.getAddress();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: {
      capabilities: { "": ["tinycloud.capabilities/read"] },
      kv: { [`vault/secrets/${SECRET}`]: ["tinycloud.kv/get"] },
    },
    address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk: sessionKey,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: expiresAt,
  });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  // Signing in activates the session on the node; its KV read proves through it.
  const activated = await fetch(`${hermetic.host}/delegate`, {
    method: "POST",
    headers: { Authorization: session.delegationHeader.Authorization },
  });
  expect(activated.status).toBe(200);
  await writeJsonAtomic(profileConfigPath(name), {
    name, host: hermetic.host, chainId: 1, spaceName: "secrets", spaceId,
    did: hermetic.ownerDid, sessionDid, ownerDid: hermetic.ownerDid, operatorType: "human",
    createdAt: "2026-10-04T00:00:00.000Z",
    ...(kind === "local"
      ? { authMethod: "local", posture: "local-owner-key", privateKey: hermetic.ownerPrivateKey }
      : { authMethod: "openkey", posture: "owner-openkey" }),
  });
  await writeJsonAtomic(join(profilePath(name), "key.json"), sessionKey);
  await writeJsonAtomic(sessionPath(name), {
    ...session,
    jwk: sessionKey, address, chainId: 1, spaceId, verificationMethod: sessionDid,
    siwe: prepared.siwe, signature, ownerDid: hermetic.ownerDid, expiresAt, tinycloudHosts: [hermetic.host],
  });
  return { sessionKey, sessionDid };
}

async function runCli(command: string[], args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  const child = Bun.spawn([...command, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** The one stored grant, with its proof and its `cli-grant` binding. */
async function storedGrant(profile: string): Promise<string> {
  const stored = await readAdditionalDelegations<{
    delegation: { cid: string; siweProof?: unknown };
    authorityRequest?: { requestId?: unknown; requested?: Array<{ service: string; space?: string }> };
  }>(profile);
  expect(stored).toHaveLength(1);
  const [record] = stored;
  expect(record!.delegation.siweProof).toEqual({ siwe: expect.any(String), signature: expect.any(String) });
  expect(record!.authorityRequest?.requestId).toBe(`cli-grant:${record!.delegation.cid}`);
  return record!.delegation.cid;
}

/**
 * A fresh process reads the secret with the stored grant. Had replay refused
 * it, the read would fail or (on a local owner, which escalates without a
 * prompt) store a second grant.
 */
async function expectFreshReadUsesStoredGrant(command: string[], profile: string, cid: string): Promise<void> {
  const read = await runCli(command, ["--json", "--profile", profile, "secrets", "get", SECRET]);
  expect({ exitCode: read.exitCode, stderr: read.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(read.stdout)).toEqual({ name: SECRET, value: CANARY });
  expect(await storedGrant(profile)).toBe(cid);
}

test.each(cliRuntimes)("under %s, auth request --grant stores a local raw-decrypt-only grant a fresh process installs", async (runtime, command) => {
  const profile = `local-request-${runtime}`;
  await ownerProfile(profile, "local");
  const activations = hermetic.nativeBearerStats().delegations;

  const granted = await runCli(command, [
    "--json", "--profile", profile, "auth", "request", "--grant", "--yes", "--permission", rawOnlyRequest,
  ]);

  expect({ exitCode: granted.exitCode, stderr: granted.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(granted.stdout)).toMatchObject({ changed: true });
  expect(hermetic.nativeBearerStats().delegations).toBe(activations + 1);
  await expectFreshReadUsesStoredGrant(command, profile, await storedGrant(profile));
}, CLI_TIMEOUT_MS);

test.each(cliRuntimes)("under %s, a local owner's secret read escalates to a stored raw-decrypt-only grant", async (runtime, command) => {
  const profile = `local-escalation-${runtime}`;
  await ownerProfile(profile, "local");

  const first = await runCli(command, ["--json", "--profile", profile, "secrets", "get", SECRET]);

  expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(first.stdout)).toEqual({ name: SECRET, value: CANARY });
  await expectFreshReadUsesStoredGrant(command, profile, await storedGrant(profile));
}, CLI_TIMEOUT_MS);

test("an OpenKey owner's decrypt-only escalation is stored and installed in a fresh process", async () => {
  const profile = "openkey-escalation";
  const { sessionKey, sessionDid } = await ownerProfile(profile, "openkey");
  const openKey = openKeyDelegate({ wasm, signer: owner, sessionKey, sessionDid });
  let stdout = "";
  const output = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const originalWrite = output.write;
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`secrets get exited with ${code}`);
  }) as typeof process.exit);
  // The owner is at a terminal, so the missing decrypt goes to OpenKey.
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  output.write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  try {
    const program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSecretsCommand(program, (did, options) => openKey.delegate(did, options));
    await program.parseAsync(["node", "tc", "--profile", profile, "secrets", "get", SECRET], { from: "node" });
  } finally {
    output.write = originalWrite;
    exit.mockRestore();
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  }

  expect(JSON.parse(stdout)).toEqual({ name: SECRET, value: CANARY });
  // The request was decrypt only, so OpenKey signed it anchored in the secrets space.
  expect(openKey.requests).toHaveLength(1);
  await expectFreshReadUsesStoredGrant(cliRuntimes[0]![1], profile, await storedGrant(profile));
}, CLI_TIMEOUT_MS);
