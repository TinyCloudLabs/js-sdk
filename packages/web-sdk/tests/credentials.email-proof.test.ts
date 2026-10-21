import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { canonicalDigest, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import { requestEmailProofCode } from "../src/credentials/email-proof";

const DISCOVERY_URL = "https://witness.credentials.org/.well-known/opencredentials";
const ADDRESS = "reader@example.com";
const REQUEST = "R".repeat(32);
const HOLDER = { did: "did:key:z6MkHolderTest", sign: async () => new Uint8Array(64) };
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;

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
