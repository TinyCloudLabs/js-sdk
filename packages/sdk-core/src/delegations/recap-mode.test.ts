import { expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { decodeOwnerRootCacao } from "../../../share-sdk/src/owner-root-cacao";
import { validateSignedOwnerDelegation } from "../../../share-sdk/src/share-root";
import fixture from "../../test-fixtures/siwe-cacao/owner-share.json";
import { encodeDagCbor, parseSignedSiweCacao } from "./cacao";
import { DELEGATION_MODE_KEY } from "./recap-mode";
import { admitOwnerRenewalLease } from "./renewal";

const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
const { ownerDid, delegation } = fixture;
const spaceId = delegation.resource.split("/")[0]!;
const action = "tinycloud.kv/get";

async function signedCacao(target: string, ability: string, audience: string, extra: string = "") {
  const [namespace, name] = ability.split("/");
  const att = JSON.stringify({ [target]: { [ability]: [{}] } });
  const recap = `{"att":${att},"prf":[]${extra}}`;
  const resources = [`urn:recap:${Buffer.from(recap).toString("base64url")}`];
  const statement = `I further authorize the stated URI to perform the following actions on my behalf: (1) '${namespace}': '${name}' for '${target}'.`;
  const domain = "app.example";
  const nonce = "tc3810reader";
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expirationTime = new Date(Date.now() + 3_600_000).toISOString();
  const siwe = new SiweMessage({
    domain, address: owner.address, uri: audience, version: "1",
    chainId: 1, nonce, issuedAt, expirationTime, statement, resources,
  }).prepareMessage();
  const signature = await owner.signMessage({ message: siwe });
  const bytes = encodeDagCbor({
    h: { t: "eip4361" },
    p: { domain, iss: ownerDid, aud: audience, version: 1, nonce, iat: issuedAt, exp: expirationTime, statement, resources },
    s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) },
  });
  return { bytes, authorization: Buffer.from(bytes).toString("base64url") };
}

test("the existing owner delegation and revocation fixtures keep their legacy parsed shape", async () => {
  for (const legacy of [fixture.delegation, fixture.revocation]) {
    const bytes = Buffer.from(legacy.authorization, "base64url");
    const decoded = decodeOwnerRootCacao(bytes);
    const parsed = await parseSignedSiweCacao(legacy.authorization);
    expect(parsed).toEqual({
      cid: decoded.cid,
      issuer: ownerDid,
      audience: legacy.audience,
      attenuation: legacy === delegation ? { [delegation.resource]: { [action]: [{}] } } : {},
      proofs: [],
      issuedAt: decoded.issuedAt,
      ...(decoded.notBefore === undefined ? {} : { notBefore: decoded.notBefore }),
      ...(decoded.expiresAt === undefined ? {} : { expiresAt: decoded.expiresAt }),
    });
    expect(Object.hasOwn(parsed, "delegationMode")).toBe(false);
    expect(Object.hasOwn(decoded, "delegationMode")).toBe(false);
  }
});

test.each(["attenuable", "terminal"] as const)("both CACAO readers expose signed %s mode", async (mode) => {
  const { bytes, authorization } = await signedCacao(delegation.resource, action, delegation.audience, `,"${DELEGATION_MODE_KEY}":"${mode}"`);
  const decoded = decodeOwnerRootCacao(bytes);
  const parsed = await parseSignedSiweCacao(authorization, decoded.cid);
  expect(parsed.delegationMode).toBe(mode);
  expect(decoded.delegationMode).toBe(mode);
  expect(parsed.attenuation).toEqual({ [delegation.resource]: { [action]: [{}] } });
});

test("share roots still refuse a terminal grant", async () => {
  const { bytes } = await signedCacao(delegation.resource, action, delegation.audience, `,"${DELEGATION_MODE_KEY}":"terminal"`);
  const decoded = decodeOwnerRootCacao(bytes);
  expect(() => validateSignedOwnerDelegation(decoded, {
    label: "share root",
    owner: { address: owner.address, chainId: "1" },
    keyDid: delegation.audience,
    wanted: { [delegation.resource]: [action] },
    maxLifetimeMs: 7 * 86_400_000,
    now: Date.now(),
  })).toThrow("share root must allow delegation");
});

test.each([
  ["unknown ReCap member", ',"extra":1', /ReCap (?:fields are invalid|has an unknown field)/],
  ["unknown member alongside valid mode", `,"${DELEGATION_MODE_KEY}":"terminal","extra":1`, /ReCap (?:fields are invalid|has an unknown field)/],
  ["unknown mode", `,"${DELEGATION_MODE_KEY}":"other"`, /must be "terminal" or "attenuable"/],
  ["explicit null", `,"${DELEGATION_MODE_KEY}":null`, /must be "terminal" or "attenuable"/],
  ["non-string mode", `,"${DELEGATION_MODE_KEY}":37`, /must be "terminal" or "attenuable"/],
  ["duplicate mode", `,"${DELEGATION_MODE_KEY}":"terminal","${DELEGATION_MODE_KEY}":"terminal"`, /duplicate member/],
  ["escaped equivalent mode", `,"${DELEGATION_MODE_KEY}":"terminal","\\u0078yz.tinycloud.policy/delegationMode":"attenuable"`, /duplicate member/],
])("both CACAO readers reject %s", async (_label, extra, message) => {
  const { bytes, authorization } = await signedCacao(delegation.resource, action, delegation.audience, extra);
  await expect(parseSignedSiweCacao(authorization)).rejects.toThrow(message);
  expect(() => decodeOwnerRootCacao(bytes)).toThrow(message);
});

const key = (seed: number) => ed25519.getPublicKey(new Uint8Array(32).fill(seed));
const did = (seed: number) => `did:key:${base58btc.encode(new Uint8Array([0xed, 1, ...key(seed)]))}`;

test.each([["legacy", undefined], ["attenuable", "attenuable"]] as const)("owner renewal admission reads a %s original and an unstamped lease", async (_label, mode) => {
  const nodeIdentity = {
    nodeDid: did(8),
    renewerDid: did(9),
    renewerPublicKey: Buffer.from(key(9)).toString("base64url"),
    renewerEpoch: 0,
  };
  const extra = mode === undefined ? "" : `,"${DELEGATION_MODE_KEY}":"${mode}"`;
  const original = await signedCacao(delegation.resource, action, delegation.audience, extra);
  const { cid: originalCid } = await parseSignedSiweCacao(original.authorization);
  const lease = await signedCacao(`urn:cid:${originalCid}`, "tinycloud.delegation/renew", nodeIdentity.renewerDid);
  const parsedLease = await parseSignedSiweCacao(lease.authorization);
  expect(Object.hasOwn(parsedLease, "delegationMode")).toBe(false);

  const posted: Array<string | null> = [];
  const node = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/.well-known/tinycloud/node-keys") return Response.json(nodeIdentity);
      if (pathname !== "/delegate" || request.method !== "POST") return new Response(null, { status: 404 });
      posted.push(request.headers.get("authorization"));
      return new Response(null, { status: 200 });
    },
  });
  try {
    const receipt = await admitOwnerRenewalLease({
      host: node.url.origin, originalCid, originalAuthorization: original.authorization,
      ownerDid, agentDid: delegation.audience, spaceId, nodeIdentity,
      leaseAuthorization: lease.authorization, leaseCid: parsedLease.cid, leaseExpiresAt: parsedLease.expiresAt!,
    });
    expect(receipt).toMatchObject({
      originalCid, leaseCid: parsedLease.cid, leaseAuthorization: lease.authorization, leaseGeneration: 1,
    });
    expect(posted).toEqual([lease.authorization]);
  } finally {
    node.stop(true);
  }
});
