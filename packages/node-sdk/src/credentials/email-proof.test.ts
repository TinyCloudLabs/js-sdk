import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { createFileEmailProofPendingStore } from "../credential-pending-store";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalDigest, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import {
  acquireEmailProof,
  acquireEmailProofWithIssuerKeys,
  completeEmailProof,
  completeEmailProofWithIssuerKeys,
  createEd25519HolderSigner,
  createMemoryEmailProofPendingStore,
  EMAIL_PROOF_PENDING_MAX_MS,
  EMAIL_PROOF_PINS,
  EmailProofError,
  type EmailProofPending,
  type EmailProofProfileId,
  type HolderSigner,
  requestEmailProofCode,
  restoreEmailProofPending,
} from "./email-proof";
import { makeWitness } from "./test-support/witness-stub.mjs";

const DISCOVERY_URL = "https://witness.credentials.org/.well-known/opencredentials";
const ADDRESS = "reader@example.com";
const REQUEST = "R".repeat(32);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
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

test("production pins are the literal values and the fixture descriptor matches the descriptor pin", async () => {
  expect(EMAIL_PROOF_PINS).toEqual({
    witnessOrigin: "https://witness.credentials.org",
    issuerDid: "did:web:issuer.credentials.org",
    issuerKid: "did:web:issuer.credentials.org#controller",
    issuerX: "eEJI4xEobto4HtQ7Pg9R1vBOwcpfGRTlXDG5QfqLnGQ",
    descriptorDigest: "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0",
  });
  expect(await canonicalDigest(email)).toBe("1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0");
});

test("step 1 refuses a descriptor from the pinned issuer whose digest is not the pinned digest", async () => {
  const calls: string[] = [];
  const drifted = { ...email, title: "Email proof, drifted" } as CredentialFlowDescriptor;
  const fetch = async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    return href === DISCOVERY_URL ? catalogFor(drifted) : Response.json({ requestId: REQUEST }, { status: 201 });
  };
  await expect(requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: fetch as typeof globalThis.fetch }))
    .rejects.toMatchObject({ step: "request", code: "PROFILE_UNAVAILABLE" });
  expect(calls.every((href) => href === DISCOVERY_URL)).toBe(true);
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

