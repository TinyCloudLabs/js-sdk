import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { profilePath, withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { planLogoutRevocations } from "./logout-revocation.js";
import { createUcanIssuer, signUcan } from "../test-support/signed-ucan.js";
import cacaoFixture from "../../../sdk-core/test-fixtures/siwe-cacao/owner-share.json";

const PROFILE = "owner";
const owner = createUcanIssuer();
const OWNER_DID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const home = await mkdtemp(join(tmpdir(), "tc858-revoke-inventory-"));
function inHome<T>(action: () => Promise<T>): Promise<T> {
  return withTinyCloudStateRoot(home, action);
}

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await inHome(async () => { await mkdir(profilePath(PROFILE), { recursive: true }); });
});
afterEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

function signedGrant() {
  const authorization = signUcan(owner, {
    aud: "did:key:z6MkRecipient", exp: Math.floor(Date.now() / 1000) + 3600,
    att: { [`${SPACE}/kv/notes/`]: { "tinycloud.kv/get": [{}] } }, prf: ["bafyparent"],
  }, {
    alg: "EdDSA", typ: "JWT", ucv: "0.10.0",
    jwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(owner.publicBytes).toString("base64url") },
  });
  return { authorization, cid: parseSignedCompactUcanAttenuation(authorization).cid };
}

function queryNode(records: object[], available = true): TinyCloudNode {
  return { delegationManager: { async query() {
    return available
      ? { ok: true, data: { schemaVersion: 2, items: records } }
      : { ok: false, error: { code: "NETWORK_ERROR", message: "node unavailable" } };
  } } } as unknown as TinyCloudNode;
}

function record(cid: string, direction: "granted" | "received") {
  return {
    cid, direction, delegatorDid: direction === "granted" ? OWNER_DID : "did:pkh:eip155:1:0x0000000000000000000000000000000000000002",
    delegateDid: "did:key:z6MkRecipient", resources: [{ resource: `${SPACE}/kv/notes/`, actions: ["tinycloud.kv/get"], caveats: [{}] }],
    parents: [], issuedAt: null, notBefore: null, expiresAt: null, status: "active", revokedAt: null,
  };
}

async function inventory(node: TinyCloudNode, ownerDid = OWNER_DID) {
  return planLogoutRevocations({
    profileName: PROFILE, profile: { did: ownerDid, ownerDid, sessionDid: "did:key:z6MkSession" },
    session: { ownerDid, delegationCid: "bafy-session" }, host: "https://node.example.test", node,
  });
}

test("verified issued grant precedes the session CID even when history duplicates both", () => inHome(async () => {
  const grant = signedGrant();
  await writeFile(join(profilePath(PROFILE), "auth-grant-artifacts.json"), JSON.stringify([
    { delegationCid: grant.cid, delegation: { cid: grant.cid, delegationHeader: { Authorization: grant.authorization } } },
  ]));
  await writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"), [
    { source: "cli", delegationCid: "bafy-session" },
    { source: "cli", delegationCid: grant.cid },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = await inventory(queryNode([]));
  expect(result.cids).toEqual([grant.cid, "bafy-session"]);
}));

test("wallet-signed CACAO issued grant is included before the active session", () => inHome(async () => {
  const grant = cacaoFixture.delegation;
  await writeFile(join(profilePath(PROFILE), "auth-grant-artifacts.json"), JSON.stringify([
    { delegationCid: grant.cid, delegation: { cid: grant.cid, delegationHeader: { Authorization: grant.authorization } } },
  ]));
  const result = await inventory(queryNode([]), cacaoFixture.ownerDid);
  expect(result.cids).toEqual([grant.cid, "bafy-session"]);
}));

test("a verified grant on another account's space is excluded without blocking or a node lookup", () => inHome(async () => {
  // Another account (e.g. an earlier sign-in on this profile) issued it; this owner may not revoke it.
  const grant = cacaoFixture.delegation;
  await writeFile(join(profilePath(PROFILE), "auth-grant-artifacts.json"), JSON.stringify([
    { delegationCid: grant.cid, delegation: { cid: grant.cid, delegationHeader: { Authorization: grant.authorization } } },
  ]));
  await writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"),
    `${JSON.stringify({ source: "cli", delegationCid: grant.cid })}\n`);
  const result = await inventory(queryNode([]));
  expect(result.cids).toEqual(["bafy-session"]);
  expect(result.excluded).toEqual([{ cid: grant.cid, reason: "non_owner" }]);
}));

test("history source cli is not ownership proof: granted target revokes, imported target is explicitly excluded", () => inHome(async () => {
  await writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"), [
    { source: "cli", delegationCid: "bafy-issued" },
    { source: "cli", delegationCid: "bafy-imported" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = await inventory(queryNode([record("bafy-issued", "granted"), record("bafy-imported", "received")]));
  expect(result.cids).toEqual(["bafy-issued", "bafy-session"]);
  expect(result.excluded).toEqual([expect.objectContaining({ cid: "bafy-imported", reason: "inbound" })]);
}));

test("history-only ambiguity or unavailable node lookup refuses to shrink the revoke set", () => inHome(async () => {
  await writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"), JSON.stringify({ source: "cli", delegationCid: "bafy-unknown" }) + "\n");
  await expect(inventory(queryNode([]))).rejects.toMatchObject({ code: "REVOKE_INVENTORY_UNVERIFIED" });
  await expect(inventory(queryNode([], false))).rejects.toMatchObject({ code: "REVOKE_INVENTORY_UNVERIFIED" });
}));

test("a granted history CID without an owner-space target is not silently revoked", () => inHome(async () => {
  await writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"),
    JSON.stringify({ source: "cli", delegationCid: "bafy-other-space" }) + "\n");
  const other = {
    ...record("bafy-other-space", "granted"),
    resources: [{ resource: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:default/kv/notes/",
      actions: ["tinycloud.kv/get"], caveats: [] }],
  };
  const result = await inventory(queryNode([other]));
  expect(result.cids).toEqual(["bafy-session"]);
  expect(result.excluded).toEqual([{ cid: "bafy-other-space", reason: "non_owner" }]);
}));

test("a granted history CID with no verifiable target fails closed", () => inHome(async () => {
  await writeFile(join(profilePath(PROFILE), "auth-grants.jsonl"),
    JSON.stringify({ source: "cli", delegationCid: "bafy-no-target" }) + "\n");
  await expect(inventory(queryNode([{ ...record("bafy-no-target", "granted"), resources: [] }])))
    .rejects.toMatchObject({ code: "REVOKE_INVENTORY_UNVERIFIED" });
}));

test("malformed purported owner artifact refuses revocation before a partial local logout", () => inHome(async () => {
  await writeFile(join(profilePath(PROFILE), "auth-grant-artifacts.json"), JSON.stringify([
    { delegationCid: "bafy-bad", delegation: { cid: "bafy-bad", delegationHeader: { Authorization: "forged" } } },
  ]));
  await expect(inventory(queryNode([]))).rejects.toMatchObject({ code: "REVOKE_INVENTORY_UNVERIFIED" });
}));
