import { afterEach, describe, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { encodeDagCbor, parseSignedSiweCacao } from "./cacao";
import { admitOwnerRenewalLease, type AdmitOwnerRenewalLeaseInput } from "./renewal";
import fixture from "../../test-fixtures/siwe-cacao/owner-share.json";

const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
const spaceId = fixture.delegation.resource.split("/")[0]!;
const did = (seed: number) => `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 1, ...ed25519.getPublicKey(new Uint8Array(32).fill(seed))]))}`;
const nodeIdentity = { nodeDid: did(8), renewerDid: did(9), renewerPublicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(9))).toString("base64url"), renewerEpoch: 0 };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function signed(options: { target: string; audience?: string; ability?: string; proofs?: unknown; rawRecap?: string; expires?: number; start?: number; signer?: typeof owner }) {
  const ability = options.ability ?? "tinycloud.delegation/renew";
  const [namespace, name] = ability.split("/");
  const recap = options.rawRecap ?? JSON.stringify({ att: { [options.target]: { [ability]: [{}] } }, prf: options.proofs ?? [] });
  const issuedAt = new Date(options.start ?? Date.now() - 60_000).toISOString();
  const expirationTime = new Date(options.expires ?? Date.now() + 3600_000).toISOString();
  const statement = `I further authorize the stated URI to perform the following actions on my behalf: (1) '${namespace}': '${name}' for '${options.target}'.`;
  const resources = [`urn:recap:${Buffer.from(recap).toString("base64url")}`];
  const audience = options.audience ?? nodeIdentity.renewerDid;
  const message = new SiweMessage({ domain: "app.tinycloud.xyz", address: owner.address, uri: audience, version: "1", chainId: 1, nonce: "tc2904nonce", issuedAt, expirationTime, statement, resources }).prepareMessage();
  const signer = options.signer ?? owner;
  const signingMessage = signer === owner ? message : message.replace(owner.address, signer.address);
  const signature = await signer.signMessage({ message: signingMessage });
  return Buffer.from(encodeDagCbor({ h: { t: "eip4361" }, p: { domain: "app.tinycloud.xyz", iss: `did:pkh:eip155:1:${signer.address}`, aud: audience, version: 1, nonce: "tc2904nonce", iat: issuedAt, exp: expirationTime, statement, resources }, s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) } })).toString("base64url");
}

async function input(leaseOptions: Partial<Parameters<typeof signed>[0]> = {}): Promise<AdmitOwnerRenewalLeaseInput> {
  const originalAuthorization = await signed({ target: `${spaceId}/kv/test`, audience: fixture.delegation.audience, ability: "tinycloud.kv/get" });
  const original = await parseSignedSiweCacao(originalAuthorization);
  const leaseAuthorization = await signed({ target: `urn:cid:${original.cid}`, ...leaseOptions });
  const lease = await parseSignedSiweCacao(leaseAuthorization);
  return { host: "https://node.example", originalAuthorization, originalCid: original.cid, ownerDid: fixture.ownerDid, agentDid: fixture.delegation.audience, spaceId, nodeIdentity, leaseAuthorization, leaseCid: lease.cid, leaseExpiresAt: lease.expiresAt! };
}

function nodeFetch(status = 200) {
  const posted: string[] = [];
  globalThis.fetch = (async (url, options) => {
    if (String(url).endsWith("/node-keys")) return Response.json(nodeIdentity);
    posted.push((options?.headers as { Authorization: string }).Authorization);
    return Response.json({}, { status });
  }) as typeof fetch;
  return posted;
}

describe("owner-direct renewal consumer API", () => {
  test("exposes verified proof absence and admits/replays identical bytes with the same receipt, without keys", async () => {
    const data = await input();
    const parsed = await parseSignedSiweCacao(data.leaseAuthorization, data.leaseCid);
    expect(parsed.proofs).toEqual([]);
    const posted = nodeFetch();
    const receipt = await admitOwnerRenewalLease(data);
    expect(await admitOwnerRenewalLease(data)).toEqual(receipt);
    expect(receipt).toEqual({ originalCid: data.originalCid, leaseCid: data.leaseCid, leaseAuthorization: `Bearer ${data.leaseAuthorization}`, leaseExpiresAt: data.leaseExpiresAt, leaseGeneration: 1, nodeIdentity });
    expect(posted).toEqual([receipt.leaseAuthorization, receipt.leaseAuthorization]);
  });

  test("exposes a signed proof chain and refuses owner-direct admission", async () => {
    const data = await input({ proofs: [fixture.delegation.cid] });
    expect((await parseSignedSiweCacao(data.leaseAuthorization)).proofs).toEqual([fixture.delegation.cid]);
    const posted = nodeFetch();
    await expect(admitOwnerRenewalLease(data)).rejects.toThrow("binding");
    expect(posted).toEqual([]);
  });

  for (const [label, change] of Object.entries({
    "wrong original CID": { originalCid: fixture.delegation.cid },
    "wrong lease CID": { leaseCid: fixture.delegation.cid },
    "wrong owner": { ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" },
    "wrong agent": { agentDid: did(3) },
    "wrong space": { spaceId: `${spaceId}-other` },
    "wrong approved end": { leaseExpiresAt: "2027-01-01T00:00:00Z" },
  })) test(`refuses ${label} before admission`, async () => {
    const data = await input();
    const posted = nodeFetch();
    await expect(admitOwnerRenewalLease({ ...data, ...change })).rejects.toThrow();
    expect(posted).toEqual([]);
  });

  for (const [label, options] of Object.entries({
    "wrong renewer audience": { audience: did(3) },
    "wrong target": { target: `urn:cid:${fixture.delegation.cid}` },
    "expired lease": { expires: Date.now() - 1000 },
    "future lease": { start: Date.now() + 60_000 },
    "lease longer than one year": { expires: Date.now() + 366 * 86400_000 },
  })) test(`refuses ${label}`, async () => {
    const data = await input(options);
    const posted = nodeFetch();
    await expect(admitOwnerRenewalLease(data)).rejects.toThrow();
    expect(posted).toEqual([]);
  });

  test("accepts persisted Bearer headers without changing the signed bytes", async () => {
    const data = await input();
    nodeFetch();
    const receipt = await admitOwnerRenewalLease({ ...data, originalAuthorization: `Bearer ${data.originalAuthorization}`, leaseAuthorization: `Bearer ${data.leaseAuthorization}` });
    expect(receipt.leaseAuthorization).toBe(`Bearer ${data.leaseAuthorization}`);
  });

  test("refuses a valid lease signed by another owner", async () => {
    const data = await input({ signer: privateKeyToAccount(`0x${"02".repeat(32)}`) });
    const posted = nodeFetch();
    await expect(admitOwnerRenewalLease(data)).rejects.toThrow("binding");
    expect(posted).toEqual([]);
  });

  test("refuses expired originals", async () => {
    const data = await input();
    const originalAuthorization = await signed({ target: `${spaceId}/kv/test`, audience: data.agentDid, ability: "tinycloud.kv/get", expires: Date.now() - 1000 });
    const original = await parseSignedSiweCacao(originalAuthorization);
    const leaseAuthorization = await signed({ target: `urn:cid:${original.cid}` });
    const lease = await parseSignedSiweCacao(leaseAuthorization);
    await expect(admitOwnerRenewalLease({ ...data, originalAuthorization, originalCid: original.cid, leaseAuthorization, leaseCid: lease.cid, leaseExpiresAt: lease.expiresAt! })).rejects.toThrow("expired");
  });

  test("refuses changed node identity and failed node admission", async () => {
    const data = await input();
    globalThis.fetch = (async () => Response.json({ ...nodeIdentity, renewerEpoch: 1 })) as typeof fetch;
    await expect(admitOwnerRenewalLease(data)).rejects.toThrow("identity changed");
    nodeFetch(403);
    await expect(admitOwnerRenewalLease(data)).rejects.toThrow("403");
  });

  for (const rawRecap of [
    '{"att":{},"prf":null}', '{"att":{},"prf":[7]}',
    '{"att":{},"prf":["not-a-cid"]}', '{"att":{},"prf":[],"prf":[]}',
    '{"att":{},"prf":[],"pr\\u0066":[]}',
  ]) test(`refuses ambiguous or malformed signed proof data ${rawRecap}`, async () => {
    const authorization = await signed({ target: "unused", rawRecap });
    await expect(parseSignedSiweCacao(authorization)).rejects.toThrow();
  });
});
