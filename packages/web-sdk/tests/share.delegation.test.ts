import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, didKeyFromEd25519PublicKey, toBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { ReceivedShareImpl } from "../src/share/service";
import type { ShareDelegation, ShareReceiveOptions } from "../src/share/types";

const keyFor = (fill: number) => new Uint8Array(32).fill(fill);
const didFor = (key: Uint8Array) => didKeyFromEd25519PublicKey(ed25519.getPublicKey(key));
const vmFor = (did: string) => `${did}#${did.slice("did:key:".length)}`;

/** Sign a compact UCAN of any lifetime; the library signers stop at 60 seconds. */
function sign(key: Uint8Array, payload: Record<string, unknown>) {
  const encode = (value: unknown) => toBase64Url(new TextEncoder().encode(canonicalize(value)));
  const header = encode({ alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(ed25519.getPublicKey(key)) }, typ: "JWT", ucv: "0.10.0" });
  const body = encode(payload);
  return verifyCompactUcanAuthorization(`${header}.${body}.${toBase64Url(ed25519.sign(new TextEncoder().encode(`${header}.${body}`), key))}`);
}

function fixture() {
  const nodeKey = keyFor(71);
  const receiverKey = keyFor(72);
  const delegateKey = keyFor(73);
  const nodeDid = didFor(nodeKey);
  const receiverDid = didFor(receiverKey);
  const delegateDid = didFor(delegateKey);
  const enforcerDid = didFor(keyFor(74));
  const accountDid = didFor(keyFor(75));
  const now = Math.floor(Date.now() / 1000);
  const resource = "tinycloud://owner-space/kv/shares/tc-531/report.txt";
  const network = "urn:tinycloud:encryption:did:key:z6MkOwner:default";
  const envelope = {
    version: 3,
    actions: ["read"],
    resource: { kind: "exact", path: "shares/tc-531/report.txt" },
    target: { origin: "https://node.example", nodeAudience: enforcerDid },
    attestedEnforcerBinding: { enforcerDid, nodeAudience: nodeDid },
    policyCid: "bafy-policy-531",
    policy: {
      ownerDid: "did:key:z6MkOwner",
      policyId: "pol_tc531",
      capabilityCeiling: [
        { kind: "kv", resource, selector: "exact", actions: ["tinycloud.kv/get"] },
        { kind: "encryption", resource: network, action: "tinycloud.encryption/decrypt" },
      ],
    },
    policyRoot: { cid: "bafy-policy-root-531" },
    enforcementRoot: { cid: "bafy-enforcement-root-531" },
    contentSourceDigestHex: "1".repeat(64),
    expiry: new Date((now + 7200) * 1000).toISOString().replace(".000Z", "Z"),
  } as any;
  const attenuation = {
    [resource]: { "tinycloud.kv/get": [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource }] },
    [network]: { "tinycloud.encryption/decrypt": [{}] },
  };
  const facts = {
    profile: "policy-session-ucan/v1", ownerDid: "did:key:z6MkOwner", policyId: "pol_tc531",
    policyDigestHex: "0".repeat(64), policyCid: envelope.policyCid, policyDelegationCid: envelope.policyRoot.cid,
    enforcementDelegationCid: envelope.enforcementRoot.cid, contentSourceDigestHex: "1".repeat(64),
    capabilityCeilingHashHex: "2".repeat(64), nativeProjectionHashHex: "3".repeat(64), enforcerDid,
    nodeAudience: nodeDid, recipientDid: receiverDid, challengeId: "challenge-531", claimDigestHex: "4".repeat(64),
    claimJti: "claim-jti-531", vpDigestHex: "5".repeat(64), credentialEvidenceDigestHex: "6".repeat(64),
    decisionContextDigestHex: "7".repeat(64), issuanceAuditDigestHex: "8".repeat(64), remainingRedelegationDepth: 8,
  };
  const s0 = sign(nodeKey, {
    att: attenuation, aud: receiverDid, exp: now + 3600, fct: [facts], iss: vmFor(nodeDid),
    nbf: now - 20, nnc: "session-531", prf: [envelope.policyRoot.cid, envelope.enforcementRoot.cid],
  });
  const d1 = sign(receiverKey, {
    att: attenuation, aud: delegateDid, exp: now + 3599, fct: [{ ...facts, remainingRedelegationDepth: 7 }],
    iss: vmFor(receiverDid), nbf: now - 19, nnc: "delegate-531", prf: [s0.cid],
  });
  const delegation: ShareDelegation = {
    shareId: "share-531",
    delegateDid,
    expiresAt: new Date(d1.payload.exp * 1000).toISOString(),
    chain: [{ authorization: s0.authorization, cid: s0.cid }, { authorization: d1.authorization, cid: d1.cid }],
  };
  const imported: string[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://node.example");
    expect(url.pathname).toBe("/delegate");
    imported.push(new Headers(init?.headers).get("Authorization") ?? "");
    return new Response(JSON.stringify({ cid: "imported" }), { status: 200 });
  }) as typeof fetch;
  const receivedAs = (holderDid: string, key: Uint8Array, options: Partial<ShareReceiveOptions> = {}) => new ReceivedShareImpl(
    { kind: "receiver", holderDid, custody: "session", origin: "https://share.example" },
    { shareId: "share-531" } as never,
    envelope,
    { claims: { email: "reader@example.com" } } as never,
    {} as never,
    async (bytes) => ed25519.sign(bytes, key),
    { identity: "receiver", interaction: { kind: "inline", mountTarget: "#credentials" }, delegation, ...options },
    fetchFn,
    "https://credentials.org/.well-known/opencredentials",
  );
  return { s0, d1, delegation, delegateDid, delegateKey, receiverDid, receiverKey, accountDid, imported, receivedAs, attenuation };
}

test("a delegate opens through the chain without proving a credential and can delegate onward", async () => {
  const { s0, d1, delegateDid, delegateKey, accountDid, imported, receivedAs, attenuation } = fixture();
  const received = receivedAs(delegateDid, delegateKey);
  const onward = await received.delegate({ to: accountDid });

  // The new link is signed by the delegate, proves exactly D1, keeps its facts
  // with one less redelegation, and by default lasts as long as D1 allows.
  expect(imported).toHaveLength(1);
  const d2 = verifyCompactUcanAuthorization(imported[0]!);
  expect(d2.payload.iss.split("#", 1)[0]).toBe(delegateDid);
  expect(d2.payload.aud).toBe(accountDid);
  expect(d2.payload.prf).toEqual([d1.cid]);
  expect(d2.payload.exp).toBe(d1.payload.exp - 1);
  expect(d2.payload.fct[0].remainingRedelegationDepth).toBe(6);
  expect(canonicalize(d2.payload.att)).toBe(canonicalize(attenuation));
  expect(onward.delegateDid).toBe(accountDid);
  expect(onward.chain.map((link) => link.cid)).toEqual([s0.cid, d1.cid, d2.cid]);
  expect(onward.expiresAt).toBe(new Date(d2.payload.exp * 1000).toISOString());

  // A shorter grant is honoured.
  const shortly = new Date((d1.payload.exp - 600) * 1000);
  const short = await received.delegate({ to: accountDid, expiresAt: shortly });
  expect(verifyCompactUcanAuthorization(short.chain[2]!.authorization).payload.exp).toBe(d1.payload.exp - 600);
});

test("a delegation only opens for the key and share it names", async () => {
  const { delegation, delegateDid, delegateKey, receiverDid, receiverKey, accountDid, imported, receivedAs } = fixture();
  await expect(receivedAs(receiverDid, receiverKey).delegate({ to: accountDid })).rejects.toThrow("different share or key");
  await expect(receivedAs(delegateDid, delegateKey, { delegation: { ...delegation, shareId: "another-share" } }).delegate({ to: accountDid })).rejects.toThrow("different share or key");
  // A delegation carries at least one re-delegation after the session.
  await expect(receivedAs(delegateDid, delegateKey, { delegation: { ...delegation, chain: [delegation.chain[0]!] } }).delegate({ to: accountDid })).rejects.toThrow("different share or key");
  // Compact policy invocations need an Ed25519 did:key on the receiving end.
  await expect(receivedAs(delegateDid, delegateKey).delegate({ to: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" })).rejects.toThrow("Ed25519 did:key");
  expect(imported).toHaveLength(0);
});
