import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

// The same untrusted store must produce the same fixed-code warnings through
// canonical secrets get and the CLI's secrets list/KV read replay. All records
// are real owner-signed CACAOs; only one valid proof reaches the refusing node.

const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const RESPONSE_CANARY = "tc-node-response-body-canary";
const USERINFO_CANARY = "tc-stored-host-userinfo-canary";
const CID_CANARY = "TCGRANTCIDSECRETCANARY";
const home = await mkdtemp(join(tmpdir(), "tc-stored-grant-warnings-"));
const originalTcHome = process.env.TC_HOME;
process.env.TC_HOME = home;
const { additionalDelegationsPath, profileConfigPath, profilePath, sessionPath, writeJsonAtomic } =
  await import("@tinycloud/operations/state");

const requests: string[] = [];
let node: Server<undefined>;
const grantCids: string[] = [];

beforeAll(async () => {
  node = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      return new Response(pathname === "/delegate" ? `refused: ${RESPONSE_CANARY}` : "read denied", { status: 403 });
    },
  });
  const wasm = new NodeWasmBindings();
  const owner = new PrivateKeySigner(OWNER_KEY);
  const address = await owner.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const spaceId = wasm.makeSpaceId(address, 1, "secrets");
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const sessionDid = manager.getDID("default");
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const signed = async (abilities: Record<string, Record<string, string[]>>) => {
    const prepared = wasm.prepareSession({
      abilities, address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expirationTime: expiresAt,
    });
    const signature = await owner.signMessage(prepared.siwe);
    return { ...wasm.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const session = await signed({ capabilities: { "": ["tinycloud.capabilities/read"] } });
  const permissions = [{ service: "tinycloud.kv", space: spaceId, path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] }];
  // Stored as the CLI stores its grants: with the signed proof and a request binding.
  const grant = async (host: string, stored: "current" | "unbound" | "legacy" = "current") => {
    const proof = await signed({ kv: { "vault/secrets/KEY": ["tinycloud.kv/get"] } });
    grantCids.push(proof.delegationCid);
    return {
      delegation: {
        cid: proof.delegationCid,
        delegationHeader: proof.delegationHeader,
        spaceId,
        path: "vault/secrets/KEY",
        actions: ["tinycloud.kv/get"],
        resources: [{ service: "kv", space: spaceId, path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] }],
        expiry: expiresAt,
        delegateDID: sessionDid,
        ownerAddress: address,
        chainId: 1,
        host,
        ...(stored === "legacy" ? {} : { siweProof: { siwe: proof.siwe, signature: proof.signature } }),
      },
      permissions,
      ...(stored === "current"
        ? { authorityRequest: { requestId: `cli-grant:${proof.delegationCid}`, requested: permissions } }
        : {}),
    };
  };

  await writeJsonAtomic(profileConfigPath("owner"), {
    name: "owner", host: node.url.origin, chainId: 1, spaceName: "secrets", spaceId,
    did: ownerDid, sessionDid, ownerDid, authMethod: "openkey", posture: "owner-openkey",
    operatorType: "human", createdAt: "2026-10-04T00:00:00.000Z",
  });
  await writeJsonAtomic(join(profilePath("owner"), "key.json"), jwk);
  await writeJsonAtomic(sessionPath("owner"), {
    delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
    jwk, address, chainId: 1, spaceId, verificationMethod: sessionDid,
    siwe: session.siwe, signature: session.signature, ownerDid, expiresAt, tinycloudHosts: [node.url.origin],
  });
  const legacy = await grant(node.url.origin, "legacy");
  const donor = await signed({ kv: { "vault/secrets/OTHER": ["tinycloud.kv/get"] } });
  const swapped = await grant(node.url.origin);
  swapped.delegation.siweProof = { siwe: donor.siwe, signature: donor.signature };
  const flipped = await grant(node.url.origin);
  const original = flipped.delegation.siweProof!.signature;
  flipped.delegation.siweProof!.signature =
    original.slice(0, -1) + (original.endsWith("0") ? "1" : "0");
  const unbound = await grant(node.url.origin, "unbound");
  const outside = await grant(node.url.origin);
  outside.authorityRequest!.requested = [{
    service: "tinycloud.kv", space: spaceId, path: "vault/secrets/OTHER", actions: ["tinycloud.kv/get"],
  }];
  const hostMismatch = await grant(`https://agent:${USERINFO_CANARY}@evil.example`);
  const refused = await grant(node.url.origin);
  const freeOne = await grant(node.url.origin);
  const freeTwo = await grant(node.url.origin);
  await writeJsonAtomic(additionalDelegationsPath("owner"), [
    legacy, swapped, flipped, unbound, outside, hostMismatch, refused,
    { ...freeOne, delegation: { ...freeOne.delegation, cid: CID_CANARY } },
    { ...freeTwo, delegation: { ...freeTwo.delegation, cid: `${CID_CANARY}2` } },
  ]);
});

afterAll(async () => {
  node.stop(true);
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

const runtimes: Array<[string, string[]]> = [
  ["bun", [process.execPath, join(import.meta.dir, "../index.ts")]],
  ["node", [process.env.NODE_BINARY ?? "node", join(import.meta.dir, "../../bin/tc")]],
];

const expectedWarnings = () => [
  { code: "STORED_GRANT_SKIPPED", reason: "proof_missing", grantCid: grantCids[0] },
  { code: "STORED_GRANT_SKIPPED", reason: "proof_invalid", grantCid: grantCids[1] },
  { code: "STORED_GRANT_SKIPPED", reason: "proof_invalid", grantCid: grantCids[2] },
  { code: "STORED_GRANT_SKIPPED", reason: "unbound", grantCid: grantCids[3] },
  { code: "STORED_GRANT_SKIPPED", reason: "outside_request", grantCid: grantCids[4] },
  { code: "STORED_GRANT_SKIPPED", reason: "host_mismatch", grantCid: grantCids[5] },
  { code: "STORED_GRANT_SKIPPED", reason: "activation_rejected", grantCid: grantCids[6] },
  { code: "STORED_GRANT_SKIPPED", reason: "cid_mismatch" },
  { code: "STORED_GRANT_SKIPPED", reason: "cid_mismatch" },
];

const commands = [
  ["secrets", "get", "KEY"],
  ["secrets", "list"],
  ["kv", "get", "vault/secrets/KEY"],
];

test.each(runtimes)("under %s, all three public commands emit identical fixed warnings", async (_runtime, command) => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  for (const args of commands) {
    requests.length = 0;
    const child = Bun.spawn([...command, "--quiet", "--json", "--profile", "owner", ...args], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ command: args, exitCode, stdout, stderr }).toMatchObject({
      command: args, exitCode: expect.any(Number), stdout: "",
    });
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stderr) as { error: { warnings: unknown[] } };
    expect(parsed.error.warnings).toEqual(expectedWarnings());
    expect(stderr).not.toContain(RESPONSE_CANARY);
    expect(stderr).not.toContain(USERINFO_CANARY);
    expect(stderr).not.toContain("evil.example");
    expect(stderr).not.toContain(CID_CANARY);
    expect(requests.filter((request) => request === "POST /delegate")).toEqual(["POST /delegate"]);
  }
}, 30_000);
