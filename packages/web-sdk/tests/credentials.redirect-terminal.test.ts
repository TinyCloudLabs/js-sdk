import { expect, test } from "bun:test";
import { CredentialError, canonicalDigest, type CredentialFlowDescriptor, type CredentialRequirement } from "@tinycloud/sdk-core";
import { CredentialsService } from "../src/credentials/service";
import { OpenCredentialsHttpTransport } from "../src/credentials/transport";
import type { CredentialAcquisitionTransport, CredentialRedirectResumeState, CredentialRedirectStore, CredentialRequestState } from "../src/credentials/types";

const HOLDER = "did:key:z6MkActive";
const REQUEST = "R".repeat(32);
const ORIGIN = "https://app.test";
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;
const requirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: email.profile, version: 1 }, credentialType: { id: email.format.vct, version: 1 }, claims: { email: "reader@example.com" } };

const client = {
  credentialHolderDid: HOLDER,
  credentialHolderKid: `${HOLDER}#${HOLDER.slice("did:key:".length)}`,
  session: () => ({}) as never,
} as never;

class MemoryStore implements CredentialRedirectStore {
  constructor(public value: CredentialRedirectResumeState | undefined) {}
  async load() { return this.value; }
  async save(state: CredentialRedirectResumeState) { this.value = state; }
  async clear() { this.value = undefined; }
}

async function seeded(): Promise<MemoryStore> {
  return new MemoryStore({ type: "TinyCloudCredentialRedirectResume", version: 1, requestId: REQUEST, locator: REQUEST, verifier: "V".repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString(), correlationId: REQUEST, holderDid: HOLDER, descriptorDigest: await canonicalDigest(email), requirementDigest: await canonicalDigest(requirement), openerOrigin: ORIGIN });
}

function transportFailing(next: () => Promise<CredentialRequestState>): CredentialAcquisitionTransport {
  return { state: next, create: async () => { throw new Error("a resumed request must not be created again"); } } as unknown as CredentialAcquisitionTransport;
}

function resume(store: MemoryStore, transport: CredentialAcquisitionTransport) {
  return new CredentialsService(client).acquire(requirement, { descriptor: email, interaction: "redirect", redirectStore: store, transport, openerOrigin: ORIGIN } as never);
}

const terminalState = (state: "expired" | "canceled"): CredentialRequestState => ({ type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: state, state, correlationId: REQUEST });

test("an expired redirect request is cleared from storage", async () => {
  const store = await seeded();
  await expect(resume(store, transportFailing(async () => terminalState("expired")))).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  expect(store.value).toBeUndefined();
});

test("a canceled redirect request is cleared from storage", async () => {
  const store = await seeded();
  await expect(resume(store, transportFailing(async () => terminalState("canceled")))).rejects.toMatchObject({ code: "CANCELED" });
  expect(store.value).toBeUndefined();
});

test("an exhausted redirect request is cleared from storage", async () => {
  const store = await seeded();
  const exhausted = new CredentialError("VERIFICATION_FAILED", "The proof attempt limit was reached", { state: "proof_attempts_exhausted" });
  await expect(resume(store, transportFailing(async () => { throw exhausted; }))).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  expect(store.value).toBeUndefined();
});

test("a bare 410 from the issuer is a terminal expired request that clears storage", async () => {
  const store = await seeded();
  const transport = new OpenCredentialsHttpTransport(email, async () => new Response("", { status: 410 }));
  await expect(resume(store, transport)).rejects.toMatchObject({ code: "REQUEST_EXPIRED", details: { state: "expired" } });
  expect(store.value).toBeUndefined();
});

test("a transient error keeps the redirect request for the next attempt", async () => {
  const store = await seeded();
  const before = store.value;
  await expect(resume(store, transportFailing(async () => { throw new CredentialError("OFFLINE", "OpenCredentials is unavailable"); }))).rejects.toMatchObject({ code: "OFFLINE" });
  expect(store.value).toEqual(before);
});

test("a 410 from issuer metadata after the flow does not clear the stored request", async () => {
  const store = await seeded();
  const before = store.value;
  const complete: CredentialRequestState = { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "complete", state: "complete", correlationId: REQUEST };
  const metadataGone = new OpenCredentialsHttpTransport(email, async () => new Response("", { status: 410 }));
  const transport = { state: async () => complete, result: async () => ({}), issuerMetadata: (signal?: AbortSignal) => metadataGone.issuerMetadata(signal) } as unknown as CredentialAcquisitionTransport;
  await expect(resume(store, transport)).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  expect(store.value).toEqual(before);
});

test("an expired challenge that can be re-issued keeps the stored request", async () => {
  const store = await seeded();
  const before = store.value;
  const challengeExpired = new Response(JSON.stringify({ type: "tinycloud.credentials/error/v1", code: "CHALLENGE_EXPIRED", recoverable: true, state: "challenge_expired", correlationId: "C".repeat(16) }), { status: 409 });
  const transport = new OpenCredentialsHttpTransport(email, async () => challengeExpired.clone());
  await expect(resume(store, transport)).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  expect(store.value).toEqual(before);
});
