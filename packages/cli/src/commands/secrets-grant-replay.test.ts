import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

// An owner escalation approved through OpenKey must keep authorizing the
// canonical `secrets get`: in the same process (the retry right after the
// grant is stored) and in a fresh one. Nothing on the replay path is mocked:
// real profile files, the real operations runtime and node-sdk activation,
// and a loopback node that activates the CACAO grant and serves the secret.

const SECRET = "HERMETIC_DELEGATION_CANARY";
const CANARY = "tc-609-replayed-grant-canary";
const home = await mkdtemp(join(tmpdir(), "tc-grant-replay-"));
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
process.env.HOME = home;
process.env.TC_HOME = home;
delete process.env.TC_HOST;

interface HermeticNode {
  readonly host: string;
  readonly ownerPrivateKey: string;
  readonly ownerDid: string;
  provisionSecret(): void;
  stop(): void;
}
// The node-sdk loopback fixture lives outside this package's rootDir, so it is
// loaded by URL, as the operations fixtures do.
const hermeticModule = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: { secretPayloadValue: string }): Promise<HermeticNode> };
// Profile state paths resolve at module load, after TC_HOME points at the test home.
const { profileConfigPath, profilePath, sessionPath, tinycloudConfigPath, writeJsonAtomic, readAdditionalDelegations } =
  await import("@tinycloud/operations/state");
const { registerSecretsCommand } = await import("./secrets.js");

let hermetic: HermeticNode;
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const sessionKey = JSON.parse(manager.jwk("default")!);
const sessionDid = manager.getDID("default");

beforeAll(async () => {
  hermetic = await hermeticModule.createHermeticEncryptedNode({ secretPayloadValue: CANARY });
  hermetic.provisionSecret();
  const owner = new PrivateKeySigner(hermetic.ownerPrivateKey);
  const address = await owner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, "secrets");
  // The owner's own session holds no secret authority, so a read escalates.
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
    address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk: sessionKey,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: expiresAt,
  });
  const signature = await owner.signMessage(prepared.siwe);
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "owner", version: 1 });
  await writeJsonAtomic(profileConfigPath("owner"), {
    name: "owner", host: hermetic.host, chainId: 1, spaceName: "secrets", spaceId,
    did: hermetic.ownerDid, sessionDid, ownerDid: hermetic.ownerDid,
    authMethod: "openkey", posture: "owner-openkey", operatorType: "human",
    createdAt: "2026-10-04T00:00:00.000Z",
  });
  await writeJsonAtomic(join(profilePath("owner"), "key.json"), sessionKey);
  await writeJsonAtomic(sessionPath("owner"), {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    jwk: sessionKey, address, chainId: 1, spaceId, verificationMethod: sessionDid,
    siwe: prepared.siwe, signature, ownerDid: hermetic.ownerDid, expiresAt, tinycloudHosts: [hermetic.host],
  });
});

afterAll(async () => {
  hermetic?.stop();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

test("an approved escalation authorizes secrets get in the same process and in a fresh one", async () => {
  const openKey = openKeyDelegate({
    wasm,
    signer: new PrivateKeySigner(hermetic.ownerPrivateKey),
    sessionKey,
    sessionDid,
  });
  let acquisitions = 0;
  let stdout = "";
  const output = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const originalWrite = output.write;
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`secrets get exited with ${code}`);
  }) as typeof process.exit);
  // The owner is at a terminal, so the missing grant goes to OpenKey.
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  output.write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  try {
    const program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSecretsCommand(program, async (did, options) => {
      acquisitions += 1;
      return openKey.delegate(did, options);
    });
    await program.parseAsync(["node", "tc", "--profile", "owner", "secrets", "get", SECRET], { from: "node" });
  } finally {
    output.write = originalWrite;
    exit.mockRestore();
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  }

  // One approval, then the immediate canonical retry read the value.
  expect(acquisitions).toBe(1);
  expect(JSON.parse(stdout)).toEqual({ name: SECRET, value: CANARY });
  const stored = await readAdditionalDelegations<{ delegation: { sessionProof?: unknown } }>("owner");
  expect(stored).toHaveLength(1);
  expect(stored[0]!.delegation.sessionProof).toEqual({
    siwe: expect.any(String),
    signature: expect.any(String),
  });

  // A new process has only the stored grant; it must replay it, not ask again.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../../test-support/secrets-json-error.ts"),
    "--profile", "owner", "--json", "secrets", "get", SECRET,
  ], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [childStdout, childStderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, stderr: childStderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(childStdout)).toEqual({ name: SECRET, value: CANARY });
});
