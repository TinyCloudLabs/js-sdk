// TC-3150: `auth import` keeps a grant file's `revokeControl` only when it names the imported delegation and its recipient.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const home = await mkdtemp(join(tmpdir(), "tc-import-revoke-control-"));
const previousHome = process.env.TC_HOME;
process.env.TC_HOME = home;
// State reads TC_HOME at module load; the isolated home must be installed first.
const { profileConfigPath, profilePath, readAdditionalDelegations, sessionPath, tinycloudConfigPath, writeJsonAtomic } =
  await import("@tinycloud/operations/state");
const { loadRevokeControls } = await import("../lib/revoke-controls.js");
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
let expiresAt = "";
const command = [process.execPath, join(import.meta.dir, "../index.ts")];
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
  expiresAt = new Date(Date.now() + 3600_000).toISOString();
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
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "importer-a", version: 1 });
  for (const profile of ["importer-a", "importer-b", "importer-c"]) {
    await writeJsonAtomic(profileConfigPath(profile), {
      name: profile, host: hermetic.host, tinycloudRegistryUrl: hermetic.host, chainId: 1, spaceName: "secrets", spaceId,
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


const control = (overrides: Record<string, unknown> = {}) => ({
  cid: "bafy-revoke-control", targetCid: grant.cid, delegateDID: grant.delegateDID,
  authorization: "header.payload.signature", expiry: expiresAt, ...overrides,
});

test("importing a grant file that carries a revokeControl stores it beside the grant", async () => {
  const imported = await runCli(command, "importer-a", ["auth", "import"], { name: "with-control", value: { ...grant, revokeControl: control() } });
  expect({ code: imported.code, stderr: imported.stderr }).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(imported.stdout)).toMatchObject({ imported: true, delegationCid: grant.cid, revokeControlCid: "bafy-revoke-control" });
  expect(await loadRevokeControls("importer-a")).toMatchObject([{ cid: "bafy-revoke-control", targetCid: grant.cid }]);
}, 30_000);

test("a revokeControl for another delegation or another recipient is not stored", async () => {
  const other = await runCli(command, "importer-b", ["auth", "import"], { name: "other-target", value: { ...grant, revokeControl: control({ targetCid: "bafy-other" }) } });
  expect(other.code).toBe(0);
  expect(JSON.parse(other.stdout).revokeControlCid).toBeUndefined();
  expect(await loadRevokeControls("importer-b")).toEqual([]);

  const stranger = await runCli(command, "importer-c", ["auth", "import"], { name: "other-recipient", value: { ...grant, revokeControl: control({ delegateDID: "did:key:z6MkSomeoneElse" }) } });
  expect(stranger.code).toBe(0);
  expect(JSON.parse(stranger.stdout).revokeControlCid).toBeUndefined();
  expect(await loadRevokeControls("importer-c")).toEqual([]);
}, 30_000);
