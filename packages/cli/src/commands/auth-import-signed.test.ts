import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const home = await mkdtemp(join(tmpdir(), "tc-import-signed-"));
const previousHome = process.env.TC_HOME;
process.env.TC_HOME = home;
// State reads TC_HOME at module load; the isolated home must be installed first.
const { profileConfigPath, profilePath, readAdditionalDelegations, sessionPath, tinycloudConfigPath, writeJsonAtomic } =
  await import("@tinycloud/operations/state");
const { readGrantHistory } = await import("../lib/permissions.js");
// The fixture is outside this package's rootDir; load its runtime module by
// URL and describe only the methods this test exercises.
interface HermeticNode {
  readonly host: string;
  readonly ownerPrivateKey: string;
  readonly ownerDid: string;
  provisionSecret(): void;
  nativeBearerStats(): { readonly delegationAttempts: number };
  stop(): void;
}
const { createHermeticEncryptedNode } = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: object): Promise<HermeticNode> };

let hermetic: HermeticNode;
let grant: Record<string, unknown>;
const runtimes: Array<[string, string[]]> = [
  ["src", [process.execPath, join(import.meta.dir, "../index.ts")]],
  ["built", [process.env.NODE_BINARY ?? "node", join(import.meta.dir, "../../bin/tc")]],
];
const secretPath = "vault/secrets/HERMETIC_DELEGATION_CANARY";
const wasm = new NodeWasmBindings();

beforeAll(async () => {
  hermetic = await createHermeticEncryptedNode({});
  hermetic.provisionSecret();
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const sessionDid = manager.getDID("default");
  const signer = new PrivateKeySigner(hermetic.ownerPrivateKey);
  const address = await signer.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, "secrets");
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const sign = async (abilities: Record<string, Record<string, string[]>>) => {
    const prepared = wasm.prepareSession({
      abilities, address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk,
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
    });
    const signature = await signer.signMessage(prepared.siwe);
    return { ...wasm.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const session = await sign({ capabilities: { "": ["tinycloud.capabilities/read"] } });
  const signed = await sign({ kv: { [secretPath]: ["tinycloud.kv/get"] } });
  grant = {
    cid: signed.delegationCid, delegationHeader: signed.delegationHeader,
    spaceId, path: secretPath, actions: ["tinycloud.kv/get"],
    resources: [{ service: "kv", space: spaceId, path: secretPath, actions: ["tinycloud.kv/get"] }],
    expiry: expiresAt, delegateDID: sessionDid, ownerAddress: address,
    chainId: 1, host: hermetic.host,
    siweProof: { siwe: signed.siwe, signature: signed.signature },
  };
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "importer-src", version: 1 });
  for (const [runtime] of runtimes) {
    const profile = `importer-${runtime}`;
    await writeJsonAtomic(profileConfigPath(profile), {
      name: profile, host: hermetic.host, chainId: 1, spaceName: "secrets", spaceId,
      did: hermetic.ownerDid, sessionDid, ownerDid: hermetic.ownerDid,
      authMethod: "openkey", posture: "owner-openkey", operatorType: "human",
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    await writeJsonAtomic(join(profilePath(profile), "key.json"), jwk);
    await writeJsonAtomic(sessionPath(profile), {
      delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
      jwk, address, chainId: 1, spaceId, verificationMethod: sessionDid,
      siwe: session.siwe, signature: session.signature, ownerDid: hermetic.ownerDid,
      expiresAt, tinycloudHosts: [hermetic.host],
    });
  }
});

afterAll(async () => {
  hermetic?.stop();
  if (previousHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

async function runCli(
  command: string[],
  profile: string,
  args: string[],
  artifact?: { name: string; value: unknown },
): Promise<{ stdout: string; stderr: string; code: number }> {
  let source: string | undefined;
  if (artifact) {
    source = join(home, `${profile}-${artifact.name}.json`);
    await writeFile(source, JSON.stringify(artifact.value), "utf8");
  }
  const env: Record<string, string | undefined> = { ...process.env, TC_HOME: home, HOME: home };
  delete env.TC_PRIVATE_KEY;
  const child = Bun.spawn([...command, "--quiet", "--json", "--profile", profile, ...args, ...(source ? [source] : [])], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test.each(runtimes)("under %s, proofless or invalid signed-login imports make no node request or store write", async (runtime, command) => {
  const profile = `importer-${runtime}`;
  const { siweProof: _proof, ...proofless } = grant;
  const attempts = hermetic.nativeBearerStats().delegationAttempts;
  const beforeRecords = await readAdditionalDelegations(profile);
  const beforeHistory = await readGrantHistory(profile);
  const absent = await runCli(command, profile, ["auth", "import"], { name: "proofless", value: proofless });
  expect({ code: absent.code, stderr: absent.stderr }).toMatchObject({ code: 2 });
  expect(JSON.parse(absent.stderr).error.code).toBe("INVALID_AUTH_IMPORT");
  expect(hermetic.nativeBearerStats().delegationAttempts).toBe(attempts);
  expect(await readAdditionalDelegations(profile)).toEqual(beforeRecords);
  expect(await readGrantHistory(profile)).toEqual(beforeHistory);

  const proof = grant.siweProof as { siwe: string; signature: string };
  const corrupt = { ...grant, siweProof: {
    ...proof, signature: proof.signature.slice(0, -1) + (proof.signature.endsWith("0") ? "1" : "0"),
  } };
  const invalid = await runCli(command, profile, ["auth", "import"], { name: "invalid", value: corrupt });
  expect({ code: invalid.code, stderr: invalid.stderr }).toMatchObject({ code: 1 });
  expect(JSON.parse(invalid.stderr).error).toMatchObject({
    code: "DELEGATION_REJECTED", message: expect.stringContaining("proof_invalid"),
  });
  expect(hermetic.nativeBearerStats().delegationAttempts).toBe(attempts);
  expect(await readAdditionalDelegations(profile)).toEqual(beforeRecords);
  expect(await readGrantHistory(profile)).toEqual(beforeHistory);
}, 30_000);

test.each(runtimes)("under %s, signed-login import activates, binds, and replays without warnings", async (runtime, command) => {
  const profile = `importer-${runtime}`;
  const attempts = hermetic.nativeBearerStats().delegationAttempts;
  const accepted = await runCli(command, profile, ["auth", "import"], { name: "signed", value: grant });
  expect({ code: accepted.code, stderr: accepted.stderr }).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(accepted.stdout)).toMatchObject({ imported: true, activated: true, delegationCid: grant.cid });
  expect(hermetic.nativeBearerStats().delegationAttempts - attempts).toBe(1);
  expect(await readAdditionalDelegations<{ authorityRequest?: { requestId: string } }>(profile))
    .toMatchObject([{ authorityRequest: { requestId: `unbound-import:${grant.cid}` } }]);
  expect(await readGrantHistory(profile)).toHaveLength(1);

  const later = await runCli(command, profile, ["kv", "get", secretPath]);
  expect({ code: later.code, stderr: later.stderr }).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(later.stdout)).toMatchObject({ key: secretPath });
}, 30_000);
