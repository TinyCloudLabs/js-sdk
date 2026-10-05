import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

// Stored grants that cannot be used are reported as fixed codes inside the
// CLI's JSON error, under both Bun (source) and Node (the built CLI). The
// grants are real owner-signed CACAOs: one stored without its proof or a
// request binding (as earlier releases did), one with its proof but no
// binding, one whose stored host carries URL userinfo, one the node refuses
// with a response body, and one whose stored CID is free text. Neither the
// body, the host nor the free-text CID may reach the output.

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
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response(`refused: ${RESPONSE_CANARY}`, { status: 403 });
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
  const freeTextCid = await grant(node.url.origin);
  await writeJsonAtomic(additionalDelegationsPath("owner"), [
    await grant(node.url.origin, "legacy"),
    await grant(node.url.origin, "unbound"),
    await grant(`https://agent:${USERINFO_CANARY}@evil.example`),
    await grant(node.url.origin),
    { ...freeTextCid, delegation: { ...freeTextCid.delegation, cid: CID_CANARY } },
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

test.each(runtimes)("under %s, --json stderr is one parseable error carrying the skipped grants", async (_runtime, command) => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  requests.length = 0;
  const child = Bun.spawn([...command, "--quiet", "--json", "--profile", "owner", "secrets", "get", "KEY"], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ exitCode, stdout }).toEqual({ exitCode: 5, stdout: "" });
  const parsed = JSON.parse(stderr) as { error: Record<string, unknown> };
  expect(parsed.error).toMatchObject({
    code: "PERMISSION_DENIED",
    warnings: [
      { code: "STORED_GRANT_SKIPPED", reason: "proof_missing", grantCid: grantCids[1] },
      { code: "STORED_GRANT_SKIPPED", reason: "unbound", grantCid: grantCids[2] },
      { code: "STORED_GRANT_SKIPPED", reason: "host_mismatch", grantCid: grantCids[3] },
      { code: "STORED_GRANT_SKIPPED", reason: "activation_rejected", grantCid: grantCids[4] },
      { code: "STORED_GRANT_SKIPPED", reason: "cid_mismatch" },
    ],
  });
  expect(stderr).not.toContain(RESPONSE_CANARY);
  expect(stderr).not.toContain(USERINFO_CANARY);
  expect(stderr).not.toContain("evil.example");
  expect(stderr).not.toContain(CID_CANARY);
  // Only the grant that passed verification was offered to the node.
  expect(requests).toEqual(["POST /delegate"]);
});
