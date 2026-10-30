import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { createFileEmailProofPendingStore } from "../credential-pending-store";
import { ed25519 } from "@noble/curves/ed25519";
import { CredentialError, canonicalDigest, holderBindingSigningBytes, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import {
  acquireEmailProof,
  acquireEmailProofWithIssuerKeys,
  completeEmailProof,
  completeEmailProofWithIssuerKeys,
  createEd25519HolderSigner,
  createMemoryEmailProofPendingStore,
  EMAIL_PROOF_ISSUER_KEYS,
  EMAIL_PROOF_PENDING_MAX_MS,
  EMAIL_PROOF_PINS,
  EmailProofError,
  type EmailProofPending,
  type EmailProofProfileId,
  type HolderSigner,
  requestEmailProofCode,
  restoreEmailProofPending,
} from "./email-proof";
import { OpenCredentialsHttpTransport } from "./transport";
import { makeWitness } from "./test-support/witness-stub.mjs";

const DISCOVERY_URL = "https://witness.credentials.org/.well-known/opencredentials";
const ADDRESS = "reader@example.com";
const REQUEST = "R".repeat(32);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;

/** Types a fetch implementation as `typeof globalThis.fetch` without a cast: Bun's fetch type includes `preconnect`. */
function asFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: (_url?: string | URL) => {} });
}

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

test("step 1 keeps the verifier for completion but hides it from JSON and inspection", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  expect(pending.requestId).toBe(REQUEST);
  expect(pending.verifier.length).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify(pending)).verifier).toBeUndefined();
  expect(inspect(pending)).not.toContain(pending.verifier);
});

test("step 1 surfaces witness RATE_LIMITED as a stable code with the retry hint", async () => {
  const fetch = async (url: string | URL | Request) => (String(url) === DISCOVERY_URL
    ? catalogFor(email)
    : new Response(JSON.stringify({ type: "tinycloud.credentials/error/v1", code: "RATE_LIMITED", recoverable: false, state: "rate_limited", correlationId: "C".repeat(16) }), { status: 429, headers: { "content-type": "application/json", "retry-after": "150" } }));
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ name: "EmailProofError", step: "request", code: "RATE_LIMITED", retryAfterMs: 150_000, recoverable: false });
});

function rateLimitedWith(headers: Record<string, string>, recoverable = false): typeof globalThis.fetch {
  return async (url) => (String(url) === DISCOVERY_URL
    ? catalogFor(email)
    : Response.json({ type: "tinycloud.credentials/error/v1", code: "RATE_LIMITED", recoverable, state: "rate_limited", correlationId: "C".repeat(16) }, { status: 429, headers }));
}

test("RATE_LIMITED keeps the witness recoverable flag when the witness sets it", async () => {
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: rateLimitedWith({ "retry-after": "60" }, true) }))
    .rejects.toMatchObject({ code: "RATE_LIMITED", recoverable: true });
});

test("RATE_LIMITED message says one minute for a 60 second wait", async () => {
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: rateLimitedWith({ "retry-after": "60" }) }))
    .rejects.toMatchObject({ message: "Too many codes were requested for this address. Try again in 1 minute." });
});

test("RATE_LIMITED message rounds a 61 second wait up to two minutes", async () => {
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: rateLimitedWith({ "retry-after": "61" }) }))
    .rejects.toMatchObject({ message: "Too many codes were requested for this address. Try again in 2 minutes." });
});

test("RATE_LIMITED message falls back to about an hour without retry-after", async () => {
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: rateLimitedWith({}) }))
    .rejects.toMatchObject({ message: "Too many codes were requested for this address. Try again in about an hour." });
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
  expect(await store.findLive(ADDRESS, new Date())).toBeUndefined();
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
  expect(await store.findLive(ADDRESS, new Date())).toMatchObject({ requestId: REQUEST });
});

function unknownCode(recoverable: boolean): Response {
  return Response.json({ type: "tinycloud.credentials/error/v1", code: "SOMETHING_NEW", recoverable, state: "proof_required", correlationId: "C".repeat(16) }, { status: 400 });
}

/** Creates a pending request, then submits a code whose proof response is produced by `refusal`. */
async function acquireWithProofRefusal(refusal: () => Response) {
  const store = createMemoryEmailProofPendingStore();
  const witness = makeWitness({ code: CODE });
  const seeded = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: asFetch(witness.fetch) });
  await store.put(seeded);
  const refused = asFetch(async (url, init) => (String(url).endsWith("/proof") ? refusal() : witness.fetch(url, init)));
  const error: unknown = await acquireEmailProofWithIssuerKeys({ address: ADDRESS, holder: HOLDER, getCode: async () => CODE, fetch: refused, pendingStore: store }, witness.issuerKeys)
    .catch((caught: unknown) => caught);
  return { error, pending: await store.findLive(ADDRESS, new Date()), requestId: seeded.requestId };
}

test.each([
  ["a bare 403", () => new Response(null, { status: 403 })],
  ["a bare 500", () => new Response(null, { status: 500 })],
  ["an HTML 502", () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
  ["a bare 429", () => new Response(null, { status: 429 })],
  ["an unrecognised code with recoverable:false", () => unknownCode(false)],
  ["an unrecognised code with recoverable:true", () => unknownCode(true)],
])("a proof refused as %s is not recoverable and deletes the pending record", async (_label, refusal) => {
  const { error, pending } = await acquireWithProofRefusal(refusal);
  expect(error).toBeInstanceOf(EmailProofError);
  expect(error).toMatchObject({ step: "code", code: "CODE_REJECTED", recoverable: false });
  expect(pending).toBeUndefined();
});

test("a server PROOF_REJECTED with recoverable:true keeps the pending record", async () => {
  const { error, pending, requestId } = await acquireWithProofRefusal(() => Response.json({ type: "tinycloud.credentials/error/v1", code: "PROOF_REJECTED", recoverable: true, state: "proof_required", correlationId: "C".repeat(16) }, { status: 400 }));
  expect(error).toMatchObject({ step: "code", code: "CODE_REJECTED", recoverable: true });
  expect(pending).toMatchObject({ requestId });
});

test("a bare 503 at the proof step is a recoverable outage and keeps the pending record", async () => {
  const { error, pending, requestId } = await acquireWithProofRefusal(() => new Response(null, { status: 503 }));
  expect(error).toMatchObject({ code: "ISSUER_UNAVAILABLE", recoverable: true });
  expect(pending).toMatchObject({ requestId });
});

test("the holder signature posts alg EdDSA and a kid equal to the did's own key fragment", async () => {
  const witness = makeWitness({ code: CODE });
  const bodies: string[] = [];
  const recording = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/holder-signature")) bodies.push(String(init?.body));
    return witness.fetch(url, init);
  };
  await acquireEmailProofWithIssuerKeys({ address: ADDRESS, holder: HOLDER, getCode: async () => CODE, fetch: asFetch(recording) }, witness.issuerKeys);
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0] ?? "")).toEqual({ alg: "EdDSA", kid: `${HOLDER.did}#${HOLDER.did.slice("did:key:".length)}`, signature: expect.any(String) });
});

test("a holder fragment that is not the did's own key is refused as HOLDER_INVALID", () => {
  let thrown: unknown;
  try {
    createEd25519HolderSigner(`${FRAGMENT_BARE}#z6MkWrongKeyFragment`, async () => new Uint8Array(64));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ name: "EmailProofError", step: "request", code: "HOLDER_INVALID" });
});

test("the memory store drops a pending request at the 15-minute cap, from both findLive and get", async () => {
  const t0 = new Date();
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: asFetch(witnessExpiringIn(email, 3_600_000)), now: () => t0 });
  const before = new Date(t0.getTime() + 14 * 60_000);
  const after = new Date(t0.getTime() + 16 * 60_000);
  const byAddress = createMemoryEmailProofPendingStore();
  await byAddress.put(pending);
  expect(await byAddress.findLive(ADDRESS, before)).toMatchObject({ requestId: pending.requestId });
  expect(await byAddress.findLive(ADDRESS, after)).toBeUndefined();
  const byId = createMemoryEmailProofPendingStore();
  await byId.put(pending);
  expect(await byId.get(pending.requestId, before)).toMatchObject({ requestId: pending.requestId });
  expect(await byId.get(pending.requestId, after)).toBeUndefined();
});

test("each request draws a fresh verifier", async () => {
  const fetch = asFetch(happyWitness(email));
  const first = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  const second = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  expect(first.verifier).not.toBe(second.verifier);
});

test("a padded address is trimmed and stored under the trimmed address", async () => {
  const store = createMemoryEmailProofPendingStore();
  await acquireEmailProof({ address: `  ${ADDRESS}  `, holder: HOLDER, fetch: asFetch(happyWitness(email)), pendingStore: store });
  expect(await store.findLive(ADDRESS, new Date())).toMatchObject({ address: ADDRESS });
});

test("the code-requested acquisition hides the verifier from its JSON, inspection, and enumerable pending keys", async () => {
  const store = createMemoryEmailProofPendingStore();
  const acquisition = await acquireEmailProof({ address: ADDRESS, holder: HOLDER, fetch: asFetch(happyWitness(email)), pendingStore: store });
  const verifier = (await store.findLive(ADDRESS, new Date()))?.verifier;
  expect(verifier).toEqual(expect.any(String));
  expect(JSON.stringify(acquisition)).not.toContain(String(verifier));
  expect(inspect(acquisition)).not.toContain(String(verifier));
  expect(acquisition.status).toBe("code-requested");
  if (acquisition.status !== "code-requested") throw new Error("expected code-requested");
  expect(Object.keys(acquisition.pending)).not.toContain("verifier");
});

const CODE = "12345678";
const FRAGMENT_SEED = ed25519.utils.randomPrivateKey();
const FRAGMENT_BARE = didKeyFor(ed25519.getPublicKey(FRAGMENT_SEED));
const SESSION_HOLDER = createEd25519HolderSigner(`${FRAGMENT_BARE}#${FRAGMENT_BARE.slice("did:key:".length)}`, async (bytes) => ed25519.sign(bytes, FRAGMENT_SEED));

test("a session-manager did#fragment holder is normalised to the bare did and keeps its kid", () => {
  expect(SESSION_HOLDER.did).toBe(FRAGMENT_BARE);
  expect(SESSION_HOLDER.kid).toBe(`${FRAGMENT_BARE}#${FRAGMENT_BARE.slice("did:key:".length)}`);
});

test("acquire with a fake witness issues a credential bound to the holder and deletes the pending record", async () => {
  const witness = makeWitness({ code: CODE });
  const store = createMemoryEmailProofPendingStore();
  const acquisition = await acquireEmailProofWithIssuerKeys(
    { address: ADDRESS, holder: SESSION_HOLDER, fetch: witness.fetch as typeof globalThis.fetch, pendingStore: store, getCode: async () => CODE },
    witness.issuerKeys,
  );
  expect(acquisition.status).toBe("issued");
  if (acquisition.status !== "issued") return;
  expect(acquisition.warnings).toEqual([]);
  expect(acquisition.result.verified.issuerDid).toBe("did:web:issuer.credentials.org");
  expect(acquisition.result.verified.holderDid).toBe(FRAGMENT_BARE);
  expect(acquisition.result.verified.claims.email).toBe(ADDRESS);
  expect(await store.findLive(ADDRESS, new Date())).toBeUndefined();
});

test("a store that cannot delete after success still returns the issued credential, with a warning", async () => {
  const witness = makeWitness({ code: CODE });
  const memory = createMemoryEmailProofPendingStore();
  const store = { findLive: memory.findLive.bind(memory), put: memory.put.bind(memory), delete: async () => { throw new Error("disk gone"); } };
  const acquisition = await acquireEmailProofWithIssuerKeys(
    { address: ADDRESS, holder: HOLDER, fetch: witness.fetch as typeof globalThis.fetch, pendingStore: store as unknown as typeof memory, getCode: async () => CODE },
    witness.issuerKeys,
  );
  expect(acquisition.status).toBe("issued");
  if (acquisition.status !== "issued") return;
  expect(acquisition.warnings).toHaveLength(1);
  expect(acquisition.result.verified.claims.email).toBe(ADDRESS);
});

test("production issuer keys reject a credential signed by a different issuer key", async () => {
  const witness = makeWitness({ code: CODE });
  const fetch = witness.fetch as typeof globalThis.fetch;
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  await expect(completeEmailProof({ pending, code: CODE, holder: HOLDER, fetch }))
    .rejects.toMatchObject({ name: "EmailProofError", step: "credential" });
});

test("a foreign issuer key passed to completeEmailProof is ignored; only the pinned production key verifies", async () => {
  const witness = makeWitness({ code: CODE });
  const fetch = witness.fetch as typeof globalThis.fetch;
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  const smuggled = { pending, code: CODE, holder: HOLDER, fetch, issuerKeys: witness.issuerKeys } as Parameters<typeof completeEmailProof>[0];
  await expect(completeEmailProof(smuggled))
    .rejects.toMatchObject({ name: "EmailProofError", step: "credential" });
});

test("a wrong code is a recoverable rejection and keeps the pending request", async () => {
  const witness = makeWitness({ code: CODE });
  const store = createMemoryEmailProofPendingStore();
  await expect(acquireEmailProofWithIssuerKeys(
    { address: ADDRESS, holder: HOLDER, fetch: witness.fetch as typeof globalThis.fetch, pendingStore: store, getCode: async () => "00000000" },
    witness.issuerKeys,
  )).rejects.toMatchObject({ name: "EmailProofError", step: "code", code: "CODE_REJECTED", recoverable: true });
  expect(await store.findLive(ADDRESS, new Date())).toBeDefined();
});

test("exhausted proof attempts are non-recoverable and delete the pending request", async () => {
  const witness = makeWitness({ code: CODE, maxAttempts: 1 });
  const store = createMemoryEmailProofPendingStore();
  await expect(acquireEmailProofWithIssuerKeys(
    { address: ADDRESS, holder: HOLDER, fetch: witness.fetch as typeof globalThis.fetch, pendingStore: store, getCode: async () => "00000000" },
    witness.issuerKeys,
  )).rejects.toMatchObject({ name: "EmailProofError", code: "CODE_ATTEMPTS_EXHAUSTED", recoverable: false });
  expect(await store.findLive(ADDRESS, new Date())).toBeUndefined();
});

test("a malformed code is refused locally, recoverable, with zero network calls", async () => {
  const witness = makeWitness({ code: CODE });
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: witness.fetch as typeof globalThis.fetch });
  let calls = 0;
  const counting = (async (url: string | URL | Request, init?: RequestInit) => { calls += 1; return witness.fetch(url, init); }) as typeof globalThis.fetch;
  await expect(completeEmailProofWithIssuerKeys({ pending, code: "1234", holder: HOLDER, fetch: counting }, witness.issuerKeys))
    .rejects.toMatchObject({ name: "EmailProofError", code: "CODE_INVALID", recoverable: true });
  expect(calls).toBe(0);
});

function withIssuer(patch: Partial<CredentialFlowDescriptor["issuer"]>): CredentialFlowDescriptor {
  return { ...email, issuer: { ...email.issuer, ...patch } };
}

/** Discovery returns `descriptor`. The pin check must refuse it: no create call may follow discovery. */
async function refusedBeforeCreate(descriptor: CredentialFlowDescriptor): Promise<void> {
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    return String(url) === DISCOVERY_URL ? catalogFor(descriptor) : Response.json({ requestId: REQUEST }, { status: 201 });
  };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "PROFILE_UNAVAILABLE" });
  expect(calls).toEqual([DISCOVERY_URL]);
}

test("pin: an issuer origin other than the pinned witness origin is refused before create", async () => {
  await refusedBeforeCreate(withIssuer({ origin: "https://evil.example" }));
});

test("pin: an issuer did other than the pinned issuer is refused before create", async () => {
  await refusedBeforeCreate(withIssuer({ did: "did:web:evil.example", kid: "did:web:evil.example#controller" }));
});

test("pin: a descriptor without the pinned mailbox step is refused before create", async () => {
  await refusedBeforeCreate({ ...email, steps: email.steps.filter((step) => step.type !== "mailbox_otp") });
});

test("pin: a descriptor whose digest is not the pinned digest is refused before create", async () => {
  await refusedBeforeCreate({ ...email, display: { ...email.display, title: "Email proof, drifted" } });
});

function witnessExpiringIn(descriptor: CredentialFlowDescriptor, ms: number) {
  const base = happyWitness(descriptor);
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await base(url, init);
    if (init?.method !== "POST" || String(url).endsWith("/challenge")) return response;
    const body = await response.json() as Record<string, unknown>;
    return Response.json({ ...body, expiresAt: new Date(Date.now() + ms).toISOString() }, { status: 201 });
  };
}

test("a pending request never outlives 15 minutes, however long the witness offers", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: witnessExpiringIn(email, 3_600_000) as typeof globalThis.fetch });
  expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)).toBe(EMAIL_PROOF_PENDING_MAX_MS);
});

test("completion refuses a pending past its deadline before any network call", async () => {
  const t0 = new Date();
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch, now: () => t0 });
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  await expect(completeEmailProof({ pending, code: CODE, holder: HOLDER, fetch: fetch as typeof globalThis.fetch, now: () => new Date(Date.parse(pending.expiresAt) + 1) }))
    .rejects.toMatchObject({ step: "session", code: "SESSION_EXPIRED" });
  expect(calls).toEqual([]);
});

function withPending(pending: EmailProofPending, changes: Partial<EmailProofPending>): EmailProofPending {
  return restoreEmailProofPending({ ...pending, verifier: pending.verifier, ...changes } as EmailProofPending);
}

test("completion refuses a pending whose requirement digest no longer matches, before any network call", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  await expect(completeEmailProof({ pending: withPending(pending, { requirementDigest: "sha256-other" }), code: CODE, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "session", code: "SESSION_INVALID" });
  expect(calls).toEqual([]);
});

test("completion refuses a pending whose descriptor digest differs from the live descriptor, before any code is submitted", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  await expect(completeEmailProof({ pending: withPending(pending, { descriptorDigest: "sha256-other" }), code: CODE, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "session", code: "SESSION_INVALID" });
  expect(calls).toEqual([DISCOVERY_URL]);
});

test("completion refuses a request the witness says must be challenged first, before submitting a code", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  const submitted: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href === DISCOVERY_URL) return catalogFor(email);
    if (href.endsWith("/state")) return Response.json({ type: "tinycloud.credentials/acquisition-state/v1", requestId: REQUEST, profile: email.profile, profileVersion: 1, state: "challenge_required", resultPreviouslyRead: false, nextStep: { step: "mailbox_otp", constraints: { challengeRequired: true } } });
    submitted.push(`${init?.method ?? "GET"} ${href}`);
    return new Response("unexpected", { status: 500 });
  };
  await expect(completeEmailProof({ pending, code: CODE, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "session", code: "SESSION_INVALID" });
  expect(submitted).toEqual([]);
});

test("a rate-limit hint rounds up to whole minutes", async () => {
  const fetch = async (url: string | URL | Request) => (String(url) === DISCOVERY_URL
    ? catalogFor(email)
    : new Response(JSON.stringify({ type: "tinycloud.credentials/error/v1", code: "RATE_LIMITED", recoverable: false, state: "rate_limited", correlationId: "C".repeat(16) }), { status: 429, headers: { "content-type": "application/json", "retry-after": "150" } }));
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch })).rejects.toThrow("Try again in 3 minutes");
});

test("a holder did that carries a fragment is refused before any network call", async () => {
  const calls: string[] = [];
  const bare = didKeyFor(ed25519.getPublicKey(FRAGMENT_SEED));
  const did = `${bare}#frag`;
  const holder = { did, alg: "EdDSA", kid: `${did}#${did.slice("did:key:".length)}`, sign: async () => new Uint8Array(64) };
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: holder as unknown as HolderSigner, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "HOLDER_INVALID" });
  expect(calls).toEqual([]);
});

test("completion refuses a pending whose opener origin is not the driver's, before any network call", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
  const forged = { ...pending, verifier: pending.verifier, openerOrigin: "https://evil.example" } as EmailProofPending;
  await expect(completeEmailProof({ pending: forged, code: CODE, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "session", code: "SESSION_INVALID" });
  expect(calls).toEqual([]);
});

test("a pending held by the memory store shows no verifier through JSON, spread, inspect, or console", async () => {
  const store = createMemoryEmailProofPendingStore();
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  await store.put(pending);
  const held = await store.findLive(ADDRESS, new Date());
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(format(...args)); };
  try { console.log(held); } finally { console.log = original; }
  expect(inspect(held)).toContain(REQUEST);
  expect(logged.join("\n")).toContain(REQUEST);
  for (const surface of [JSON.stringify(held), JSON.stringify({ ...held }), inspect(held), ...logged]) {
    expect(surface).not.toContain(pending.verifier);
  }
});

test("a pending resumed from the file store shows no verifier through JSON, spread, inspect, or console", async () => {
  const home = mkdtempSync(join(tmpdir(), "email-proof-redact-"));
  try {
    const writer = createFileEmailProofPendingStore({ home });
    const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
    await writer.put(pending);
    const resumed = await createFileEmailProofPendingStore({ home }).findLive(ADDRESS, new Date());
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(format(...args)); };
    try { console.log(resumed); } finally { console.log = original; }
    expect(inspect(resumed)).toContain(REQUEST);
    for (const surface of [JSON.stringify(resumed), JSON.stringify({ ...resumed }), inspect(resumed), ...logged]) {
      expect(surface).not.toContain(pending.verifier);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a 503 from the witness keeps the witness's recoverable flag; without one it defaults to recoverable", async () => {
  const outage = (recoverable?: boolean) => async (url: string | URL | Request) => (String(url) === DISCOVERY_URL
    ? catalogFor(email)
    : new Response(JSON.stringify({ type: "tinycloud.credentials/error/v1", code: "ISSUER_UNREADY", recoverable, state: "unavailable", correlationId: "C".repeat(16) }), { status: 503, headers: { "content-type": "application/json" } }));
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: outage(false) as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "ISSUER_UNAVAILABLE", recoverable: false });
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: outage(true) as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "ISSUER_UNAVAILABLE", recoverable: true });
});

test("a code that is not exactly eight digits is refused locally, recoverable, with zero network calls", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  for (const code of ["1234567", "123456789", "1234567a", " 12345678", "1234 5678", ""]) {
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
    await expect(completeEmailProof({ pending, code, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
      .rejects.toMatchObject({ step: "code", code: "CODE_INVALID", recoverable: true });
    expect(calls).toEqual([]);
  }
});

test("completion refuses a pending whose stored fields are not the shape the driver wrote, before any network call", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: happyWitness(email) as typeof globalThis.fetch });
  const forgeries: Record<string, unknown>[] = [{ requestId: 42 }, { holderDid: undefined }, { descriptorDigest: null }, { createdAt: "not-a-date" }, { expiresAt: "not-a-date" }];
  for (const changes of forgeries) {
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return catalogFor(email); };
    const forged = { ...pending, verifier: pending.verifier, ...changes } as unknown as EmailProofPending;
    await expect(completeEmailProof({ pending: forged, code: CODE, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
      .rejects.toMatchObject({ step: "session", code: "SESSION_INVALID" });
    expect(calls).toEqual([]);
  }
});

test("a credential issued to a holder other than the one that opened the request is refused", async () => {
  const other = holderFromSeed(ed25519.utils.randomPrivateKey());
  const witness = makeWitness({ code: CODE, subjectDid: other.did });
  const fetch = witness.fetch as typeof globalThis.fetch;
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  await expect(completeEmailProofWithIssuerKeys({ pending, code: CODE, holder: HOLDER, fetch }, witness.issuerKeys))
    .rejects.toMatchObject({ step: "credential", code: "CREDENTIAL_INVALID" });
});

test("the pinned issuer key table matches the published issuer identity", async () => {
  const identity = await Bun.file(new URL("./test-support/issuer-did.json", import.meta.url)).json() as { id: string; verificationMethod: { id: string; publicKeyJwk: { x: string } }[] };
  const method = identity.verificationMethod[0]!;
  expect(EMAIL_PROOF_PINS).toMatchObject({ issuerDid: identity.id, issuerKid: method.id, issuerX: method.publicKeyJwk.x });
  expect(EMAIL_PROOF_ISSUER_KEYS).toEqual([expect.objectContaining({ kid: method.id, alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: method.publicKeyJwk.x } })]);
});

test("public completion refuses a credential signed by a key that is not pinned", async () => {
  const witness = makeWitness({ code: CODE });
  const fetch = asFetch(witness.fetch);
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  await expect(completeEmailProof({ pending, code: CODE, holder: HOLDER, fetch }))
    .rejects.toMatchObject({ code: "CREDENTIAL_INVALID", step: "credential" });
});

test("public acquisition ignores caller-supplied issuer keys", async () => {
  const witness = makeWitness({ code: CODE });
  const input = { address: ADDRESS, holder: HOLDER, getCode: async () => CODE, fetch: asFetch(witness.fetch), issuerKeys: witness.issuerKeys };
  await expect(acquireEmailProof(input)).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
});

test("caller abort during discovery is reported as CANCELED", async () => {
  const controller = new AbortController();
  const fetch = asFetch(async () => {
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch, signal: controller.signal }))
    .rejects.toMatchObject({ code: "CANCELED", step: "request", recoverable: false });
});

test("caller abort wins over a discovery body that fails to parse", async () => {
  const controller = new AbortController();
  const fetch = asFetch(async () => {
    controller.abort();
    return new Response("<html>not a catalog</html>", { status: 200 });
  });
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch, signal: controller.signal }))
    .rejects.toMatchObject({ code: "CANCELED", step: "request", recoverable: false });
});

test("caller abort during a network failure is reported as CANCELED", async () => {
  const controller = new AbortController();
  const fetch = asFetch(async (url) => {
    if (String(url) === DISCOVERY_URL) return catalogFor(email);
    controller.abort();
    throw new TypeError("fetch failed");
  });
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch, signal: controller.signal }))
    .rejects.toMatchObject({ code: "CANCELED", recoverable: false });
});

test("a fetch timeout during discovery is a recoverable NETWORK failure", async () => {
  const fetch = asFetch(async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch }))
    .rejects.toMatchObject({ code: "NETWORK", step: "request", recoverable: true });
});

test("a recoverable SIGNATURE_REJECTED keeps the server's recoverable flag", async () => {
  const witness = makeWitness({ code: CODE });
  const fetch = asFetch(async (url, init) => {
    const response = await witness.fetch(url, init);
    if (response.status !== 400) return response;
    return Response.json({ ...(await response.json()), recoverable: true }, { status: 400 });
  });
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  const badSigner = createEd25519HolderSigner(HOLDER.did, async () => new Uint8Array(64));
  const error = await completeEmailProof({ pending, code: CODE, holder: badSigner, fetch }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "SIGNATURE_REJECTED", recoverable: true });
});

test("a restored pending record cannot outlive the 15-minute cap", async () => {
  const store = createMemoryEmailProofPendingStore();
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: asFetch(happyWitness(email)) });
  const created = Date.parse(pending.createdAt);
  await store.put({ ...pending, expiresAt: new Date(created + 60 * 60_000).toISOString() });
  expect(await store.findLive(ADDRESS, new Date(created + EMAIL_PROOF_PENDING_MAX_MS - 1))).toMatchObject({ requestId: pending.requestId });
  expect(await store.findLive(ADDRESS, new Date(created + EMAIL_PROOF_PENDING_MAX_MS))).toBeUndefined();
});

test.each([
  ["RATE_LIMITED", "ISSUER_UNREADY"],
  ["CHALLENGE_EXPIRED", "REQUEST_EXPIRED"],
  ["SIGNATURE_REJECTED", "SIGNATURE_REJECTED"],
] as const)("a transport without honorServerRecoverable ignores the server flag on %s", async (serverCode, expected) => {
  const body = { type: "tinycloud.credentials/error/v1", code: serverCode, recoverable: false, state: "state", correlationId: "corr-aaaaaaaaaaaaaaaa" };
  const fetch = asFetch(async () => Response.json(body, { status: 400 }));
  await expect(new OpenCredentialsHttpTransport(email, fetch).issue("req-aaaaaaaaaaaaaaaa", "verifier"))
    .rejects.toMatchObject({ code: expected, recoverable: true });
  await expect(new OpenCredentialsHttpTransport(email, fetch, { honorServerRecoverable: true }).issue("req-aaaaaaaaaaaaaaaa", "verifier"))
    .rejects.toMatchObject({ code: expected, recoverable: false });
});

test("a discovery body that times out mid-read is a recoverable NETWORK failure", async () => {
  const fetch = asFetch(async () => new Response(new ReadableStream({
    start(stream) { stream.error(new DOMException("The operation timed out.", "TimeoutError")); },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch }))
    .rejects.toMatchObject({ code: "NETWORK", step: "request", recoverable: true });
});

test("a caller abort during the discovery body read is CANCELED at the request step", async () => {
  const controller = new AbortController();
  const fetch = asFetch(async () => new Response(new ReadableStream({
    start(stream) {
      controller.abort();
      stream.error(new DOMException("The operation was aborted.", "AbortError"));
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch, signal: controller.signal }))
    .rejects.toMatchObject({ code: "CANCELED", step: "request", recoverable: false });
});

test("a holder whose kid is not its own did key id is refused before any request", async () => {
  let calls = 0;
  const fetch = asFetch(async () => { calls += 1; return new Response(null, { status: 500 }); });
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: asFetch(happyWitness(email)) });
  const custom = { ...HOLDER, kid: `${HOLDER.did}#custom-key` };
  await expect(completeEmailProof({ pending, code: CODE, holder: custom, fetch }))
    .rejects.toMatchObject({ code: "HOLDER_INVALID" });
  expect(calls).toBe(0);
});

/** Moves a requested acquisition to holder_binding_required and returns a holder signature over the binding the witness issued. */
async function signHolderBinding(transport: OpenCredentialsHttpTransport, pending: EmailProofPending): Promise<string> {
  await transport.beginStep(pending.requestId, pending.verifier, "mailbox_otp");
  await transport.submitStep(pending.requestId, pending.verifier, "mailbox_otp", { otp: CODE });
  const binding = await transport.holderBinding(pending.requestId, pending.verifier);
  return Buffer.from(await HOLDER.sign(holderBindingSigningBytes(binding))).toString("base64url");
}

test("the transport posts an explicit holder key's kid verbatim, and the did's own kid when none is given", async () => {
  const witness = makeWitness({ code: CODE });
  const bodies: { alg: string; kid: string }[] = [];
  const fetch = asFetch(async (url, init) => {
    if (String(url).endsWith("/holder-signature")) bodies.push(JSON.parse(String(init?.body)));
    return witness.fetch(url, init);
  });
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  const transport = new OpenCredentialsHttpTransport(email, fetch, { honorServerRecoverable: true });
  const signature = await signHolderBinding(transport, pending);
  await expect(transport.submitHolderSignature(pending.requestId, pending.verifier, signature, undefined, { alg: "EdDSA", kid: "custom-kid#x" }))
    .rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
  await transport.submitHolderSignature(pending.requestId, pending.verifier, signature);
  expect(bodies).toEqual([
    { alg: "EdDSA", kid: "custom-kid#x", signature },
    { alg: "EdDSA", kid: `${HOLDER.did}#${HOLDER.did.slice("did:key:".length)}`, signature },
  ]);
});

test("the transport keeps the witness's recoverable:false on SIGNATURE_REJECTED when it honors the flag", async () => {
  const witness = makeWitness({ code: CODE });
  const fetch = asFetch((url, init) => witness.fetch(url, init));
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  const transport = new OpenCredentialsHttpTransport(email, fetch, { honorServerRecoverable: true });
  await signHolderBinding(transport, pending);
  const error = await transport.submitHolderSignature(pending.requestId, pending.verifier, Buffer.alloc(64).toString("base64url")).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "SIGNATURE_REJECTED", recoverable: false });
});

test("an explicit recoverable flag on CredentialError overrides the per-code default", () => {
  expect(new CredentialError("ISSUER_UNREADY", "Credential issuer is not ready", { recoverable: false }).recoverable).toBe(false);
});

/** A live pending of the held profile for `address`: a real v1 record with only the profile and request id changed. */
async function heldPendingFor(address: string): Promise<EmailProofPending> {
  const witness = makeWitness({ code: CODE });
  const seeded = await requestEmailProofCode({ address, holder: HOLDER, fetch: asFetch(witness.fetch) });
  const createdAt = new Date();
  // Spreading a pending drops the non-enumerable verifier, so rebuild it from named fields.
  return restoreEmailProofPending({
    type: seeded.type,
    version: seeded.version,
    profile: "tinycloud.email-held/v1",
    address: seeded.address,
    requestId: "H".repeat(32),
    verifier: seeded.verifier,
    holderDid: seeded.holderDid,
    descriptorDigest: seeded.descriptorDigest,
    requirementDigest: seeded.requirementDigest,
    openerOrigin: seeded.openerOrigin,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
    serverExpiresAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
  });
}

/** The one pending file under `<home>/credentials` whose content names `requestId`. */
function pendingFileHolding(home: string, requestId: string): string {
  const dir = join(home, "credentials");
  const matches = readdirSync(dir).filter((name) => readFileSync(join(dir, name), "utf8").includes(requestId));
  if (matches.length !== 1) throw new Error(`expected one pending file for ${requestId}, found ${matches.length}`);
  return join(dir, matches[0]!);
}

test("v1 acquire never resumes or deletes a live held pending for the same address (memory store)", async () => {
  const store = createMemoryEmailProofPendingStore();
  const held = await heldPendingFor(ADDRESS);
  await store.put(held);
  const witness = makeWitness({ code: CODE });
  const codedFor: string[] = [];
  const acquisition = await acquireEmailProofWithIssuerKeys({
    address: ADDRESS,
    holder: HOLDER,
    fetch: asFetch(witness.fetch),
    pendingStore: store,
    getCode: async ({ pending }) => { codedFor.push(pending.requestId); return CODE; },
  }, witness.issuerKeys);
  expect(acquisition.status).toBe("issued");
  expect(codedFor).toHaveLength(1);
  expect(codedFor).not.toContain(held.requestId);
  expect(await store.get(held.requestId, new Date())).toEqual(held);
});

test("v1 acquire never resumes or deletes a live held pending for the same address (file store)", async () => {
  const home = mkdtempSync(join(tmpdir(), "email-proof-held-"));
  try {
    const store = createFileEmailProofPendingStore({ home });
    const held = await heldPendingFor(ADDRESS);
    await store.put(held);
    const heldFile = pendingFileHolding(home, held.requestId);
    const heldBytes = readFileSync(heldFile);
    const witness = makeWitness({ code: CODE });
    const codedFor: string[] = [];
    const acquisition = await acquireEmailProofWithIssuerKeys({
      address: ADDRESS,
      holder: HOLDER,
      fetch: asFetch(witness.fetch),
      pendingStore: createFileEmailProofPendingStore({ home }),
      getCode: async ({ pending }) => { codedFor.push(pending.requestId); return CODE; },
    }, witness.issuerKeys);
    expect(acquisition.status).toBe("issued");
    expect(codedFor).toHaveLength(1);
    expect(codedFor).not.toContain(held.requestId);
    expect(readFileSync(heldFile).equals(heldBytes)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a refused v1 proof with a live held pending for the same address leaves the held pending in place", async () => {
  const store = createMemoryEmailProofPendingStore();
  const held = await heldPendingFor(ADDRESS);
  await store.put(held);
  const witness = makeWitness({ code: CODE });
  const refused = asFetch(async (url, init) => (String(url).endsWith("/proof") ? unknownCode(false) : witness.fetch(url, init)));
  const error: unknown = await acquireEmailProofWithIssuerKeys({ address: ADDRESS, holder: HOLDER, getCode: async () => CODE, fetch: refused, pendingStore: store }, witness.issuerKeys)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmailProofError);
  expect(await store.get(held.requestId, new Date())).toEqual(held);
});
