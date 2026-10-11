import { afterAll, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry, type PortableDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import { bindCliGrant } from "@tinycloud/operations/delegation-binding";
import { cidBoundOwnerSpace } from "./revoke-delegation.js";

interface HermeticFixture {
  host: string;
  ownerPrivateKey: string;
  ownerDid: string;
  owner: TinyCloudNode;
  delegate: TinyCloudNode;
  ownerRestorableSession: { jwk: Record<string, unknown> };
  permissions: PermissionEntry[];
  mintDelegation(): Promise<PortableDelegation>;
  stop(): void;
}
// URL loading keeps this test fixture outside the CLI package's TypeScript rootDir.
const { createHermeticEncryptedNode } = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(): Promise<HermeticFixture> };
const fixture = await createHermeticEncryptedNode();
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
afterAll(() => fixture.stop());

async function compactRecord() {
  const delegation = await fixture.mintDelegation();
  return { delegation, permissions: fixture.permissions };
}

async function signedRecord(signedBy: PrivateKeySigner = signer) {
  const address = await signedBy.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, "secrets");
  const now = Date.now();
  const expiresAt = new Date(now + 3_600_000);
  const prepared = wasm.prepareSession({
    abilities: { kv: { "vault/secrets/KEY": ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId,
    jwk: fixture.ownerRestorableSession.jwk,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: expiresAt.toISOString(),
  });
  const signature = await signedBy.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const delegation = {
    ...await fixture.mintDelegation(),
    delegateDID: fixture.owner.sessionDid,
    expiry: expiresAt,
    ownerAddress: address,
    cid: session.delegationCid,
    delegationHeader: session.delegationHeader,
    spaceId,
    siweProof: { siwe: prepared.siwe, signature },
  } as PortableDelegation;
  return { delegation, permissions: [{
    service: "tinycloud.kv", space: spaceId, path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"],
  }] };
}

test("CID-bound fallback reads a valid compact signature, including Bearer headers", async () => {
  const record = await compactRecord();
  expect(await cidBoundOwnerSpace(record, fixture.ownerDid, fixture.delegate)).toBe(record.delegation.spaceId);
  const bearer = { ...record, delegation: {
    ...record.delegation,
    delegationHeader: { Authorization: `Bearer ${record.delegation.delegationHeader.Authorization}` },
  } };
  expect(await cidBoundOwnerSpace(bearer, fixture.ownerDid, fixture.delegate)).toBe(record.delegation.spaceId);
});

test("CID-bound fallback refuses corrupt signatures and foreign-owned signed spaces", async () => {
  const record = await compactRecord();
  const [header, payload, signature] = record.delegation.delegationHeader.Authorization.split(".");
  const corrupted = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
  const bad = { ...record, delegation: {
    ...record.delegation, cid: fixture.delegate.computeDelegationCid(corrupted),
    delegationHeader: { Authorization: corrupted },
  } };
  expect(await cidBoundOwnerSpace(bad, fixture.ownerDid, fixture.delegate)).toBeUndefined();
  const other = new PrivateKeySigner("59c6995e998f97a5a0044966f094538e604ee93c768619b6491497440a669246");
  const foreign = await signedRecord(other);
  const foreignBound = { ...foreign, authorityRequest: {
    requestId: `cli-grant:${foreign.delegation.cid}`, requested: foreign.permissions,
  } };
  expect(await cidBoundOwnerSpace(foreignBound, fixture.ownerDid, fixture.owner)).toBeUndefined();
  expect(await cidBoundOwnerSpace(record, `did:pkh:eip155:1:${await other.getAddress()}`, fixture.delegate)).toBeUndefined();
});

test("CID-bound CACAO fallback requires a validated owner signature and proof", async () => {
  const signed = await signedRecord();
  const bound = await bindCliGrant(fixture.owner, signed, fixture.host);
  expect(await cidBoundOwnerSpace(bound, fixture.ownerDid, fixture.owner)).toBe(signed.delegation.spaceId);
  const noProof = { ...bound, delegation: { ...bound.delegation, siweProof: undefined } };
  expect(await cidBoundOwnerSpace(noProof, fixture.ownerDid, fixture.owner)).toBeUndefined();
  expect(await cidBoundOwnerSpace(bound, "did:pkh:eip155:1:0x1111111111111111111111111111111111111111", fixture.owner)).toBeUndefined();
});
