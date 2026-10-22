import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalDigest, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import {
  acquireEmailProof,
  completeEmailProof,
  createEd25519HolderSigner,
  createMemoryEmailProofPendingStore,
  EmailProofError,
  requestEmailProofCode,
  type EmailProofProfileId,
} from "../src/credentials/email-proof";

const DISCOVERY_URL = "https://witness.credentials.org/.well-known/opencredentials";
const ADDRESS = "reader@example.com";
const REQUEST = "R".repeat(32);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;

/** did:key for an Ed25519 public key: multicodec 0xed01 followed by the key, base58btc. */
function didKeyFor(publicKey: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from([0xed, 0x01, ...publicKey]).toString("hex")}`);
  let encoded = "";
  while (n > 0n) { encoded = BASE58[Number(n % 58n)] + encoded; n /= 58n; }
  return `did:key:z${encoded}`;
}

function holderFromSeed(seed: Uint8Array) {
  return createEd25519HolderSigner(didKeyFor(ed25519.getPublicKey(seed)), async (bytes) => ed25519.sign(bytes, seed));
}

const HOLDER = holderFromSeed(ed25519.utils.randomPrivateKey());

async function catalogFor(descriptor: CredentialFlowDescriptor): Promise<Response> {
  return Response.json({
    type: "tinycloud.credentials/catalog/v1",
    protocol: "tinycloud.credentials/acquisition/v1",
    catalogVersion: 1,
    profiles: [{ supported: true, enabled: true, readiness: "ready", descriptor, descriptorDigest: await canonicalDigest(descriptor) }],
  });
}

/** Witness that accepts the request, reports challenge_required, and issues a mailbox_otp challenge. */
function happyWitness(descriptor: CredentialFlowDescriptor) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (href === DISCOVERY_URL) return catalogFor(descriptor);
    if (href.endsWith("/challenge")) return Response.json({ type: "tinycloud.credentials/challenge/v1", step: "mailbox_otp", stepVersion: 1, challengeNonce: "N".repeat(32) });
    if (init?.method === "POST") return Response.json({ type: "tinycloud.credentials/acquisition-request/v1", protocol: descriptor.protocol, next: "challenge", endpoint: "challenge", requestId: REQUEST, expiresAt: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
    return Response.json({ type: "tinycloud.credentials/acquisition-state/v1", requestId: REQUEST, profile: descriptor.profile, profileVersion: 1, state: "challenge_required", resultPreviouslyRead: false });
  };
}

test("step 1 stores a pending request whose verifier is persisted but hidden from inspection", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  expect(pending.requestId).toBe(REQUEST);
  expect(JSON.parse(JSON.stringify(pending)).verifier).toBe(pending.verifier);
  expect(inspect(pending)).not.toContain(pending.verifier);
});

test("step 1 surfaces witness RATE_LIMITED as a stable code with the retry hint", async () => {
  const fetch = async (url: string | URL | Request) => (String(url) === DISCOVERY_URL
    ? catalogFor(email)
    : new Response(JSON.stringify({ type: "tinycloud.credentials/error/v1", code: "RATE_LIMITED", recoverable: false, state: "rate_limited", correlationId: "C".repeat(16) }), { status: 429, headers: { "content-type": "application/json", "retry-after": "150" } }));
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ name: "EmailProofError", step: "request", code: "RATE_LIMITED", retryAfterMs: 150_000, recoverable: false });
});

test("step 1 refuses a catalog descriptor whose issuer is not the pinned email issuer and never creates a request", async () => {
  const calls: string[] = [];
  const evil = { ...email, issuer: { ...email.issuer, did: "did:web:evil.example" } } as CredentialFlowDescriptor;
  const fetch = async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    return href === DISCOVERY_URL ? catalogFor(evil) : Response.json({ requestId: REQUEST }, { status: 201 });
  };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ name: "EmailProofError", step: "request", code: "PROFILE_UNAVAILABLE" });
  expect(calls.every((href) => href === DISCOVERY_URL)).toBe(true);
});

test("step 1 rejects an unknown profile before any network call", async () => {
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, profile: "tinycloud.email-proof/v2" as EmailProofProfileId, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "PROFILE_UNAVAILABLE" });
  expect(calls).toEqual([]);
});

test("only Ed25519 did:key holders are accepted, and the kid must match the did", async () => {
  expect(() => createEd25519HolderSigner("did:pkh:eip155:1:0x0000000000000000000000000000000000000001", async () => new Uint8Array(64)))
    .toThrow(EmailProofError);
  const eip191 = { ...HOLDER, alg: "EIP191" as const };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: eip191, fetch: happyWitness(email) as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "HOLDER_INVALID" });
  const wrongKid = { ...HOLDER, kid: "did:key:z6MkOther#z6MkOther" };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: wrongKid, fetch: happyWitness(email) as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "HOLDER_INVALID" });
});

test("step 2 refuses a holder other than the one that opened the request, before any network call", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  const other = holderFromSeed(ed25519.utils.randomPrivateKey());
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  await expect(completeEmailProof({ pending, code: "12345678", holder: other, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "session", code: "SESSION_INVALID" });
  expect(calls).toEqual([]);
});

test("acquire without a code stores the request, and the next call resumes it instead of requesting another", async () => {
  const creations: string[] = [];
  const witness = happyWitness(email);
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST" && !String(url).endsWith("/challenge")) creations.push(String(url));
    return witness(url, init);
  };
  const store = createMemoryEmailProofPendingStore();
  const first = await acquireEmailProof({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch, pendingStore: store });
  const second = await acquireEmailProof({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch, pendingStore: store });
  expect(first).toMatchObject({ status: "code-requested", pending: { requestId: REQUEST } });
  expect(second).toMatchObject({ status: "code-requested", pending: { requestId: REQUEST } });
  expect(creations).toHaveLength(1);
});

test("a non-recoverable failure deletes the pending record", async () => {
  const store = createMemoryEmailProofPendingStore();
  await acquireEmailProof({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch, pendingStore: store });
  const other = holderFromSeed(ed25519.utils.randomPrivateKey());
  await expect(acquireEmailProof({ address: ADDRESS, holder: other, getCode: async () => "12345678", fetch: happyWitness(email) as typeof globalThis.fetch, pendingStore: store }))
    .rejects.toMatchObject({ code: "SESSION_INVALID" });
  expect(await store.load(ADDRESS, new Date())).toBeUndefined();
});

test("a recoverable failure keeps the pending record for a retry", async () => {
  const store = createMemoryEmailProofPendingStore();
  await acquireEmailProof({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch, pendingStore: store });
  const offline = async (url: string | URL | Request) => {
    if (String(url) === DISCOVERY_URL) return catalogFor(email);
    throw new TypeError("fetch failed");
  };
  const error = await acquireEmailProof({ address: ADDRESS, holder: HOLDER, getCode: async () => "12345678", fetch: offline as typeof globalThis.fetch, pendingStore: store })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmailProofError);
  expect(error).toMatchObject({ code: "NETWORK", recoverable: true });
  expect(await store.load(ADDRESS, new Date())).toMatchObject({ requestId: REQUEST });
});
