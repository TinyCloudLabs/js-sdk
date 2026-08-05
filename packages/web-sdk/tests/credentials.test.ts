import { expect, test } from "bun:test";
import { CredentialError, canonicalDigest, createHolderBinding, type CredentialFlowDescriptor, type CredentialRequirement, type VerifiedCredential } from "@tinycloud/sdk-core";
import { BrowserCredentialInteraction, InlineCredentialInteraction } from "../src/credentials/browser";
import { interpretCredentialFlow } from "../src/credentials/interpreter";
import { renderCredentialDescriptor } from "../src/credentials/renderer";
import { findStoredCredential, storeCredential } from "../src/credentials/storage";
import { OpenCredentialsHttpTransport } from "../src/credentials/transport";
import type { CredentialAcquisitionTransport, CredentialRequestState } from "../src/credentials/types";

const HOLDER = "did:key:z6MkActive"; const OWNER = "did:pkh:eip155:1:0x1234567890123456789012345678901234567890"; const ORIGIN = "https://witness.credentials.org"; const REQUEST = "RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR";
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor; const synthetic = fixture.vectors[1]!.descriptor;
function requirement(descriptor: CredentialFlowDescriptor): CredentialRequirement { const name = descriptor.claims[0]!.name; return { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: descriptor.profile, version: 1 }, credentialType: { id: descriptor.format.vct, version: 1 }, claims: { [name]: name === "email" ? "alice@example.com" : "alice" } }; }
function binding(descriptor: CredentialFlowDescriptor, descriptorDigest: string, requirementDigest: string) { return createHolderBinding({ requestId: REQUEST, profile: descriptor.profile, profileVersion: 1, descriptorDigest, requirementDigest, issuer: descriptor.issuer.did, issuerKid: descriptor.issuer.kid, holderDid: HOLDER, normalizedClaimsDigest: "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN", challengeNonce: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", audience: "tinycloud://credentials", openerOrigin: "https://app.test", completionOrigin: "https://app.test", completionContext: "sdk-acquisition", jti: "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ", issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T00:05:00Z" }); }

class InterpreterTransport implements CredentialAcquisitionTransport {
  index = 0; submitted: string[] = []; signatures = 0; issued = 0;
  constructor(readonly states: readonly CredentialRequestState[], readonly holder: any) {}
  async create(): Promise<any> { throw new Error("unused"); } async state() { return this.states[Math.min(this.index, this.states.length - 1)]!; }
  async beginStep() {}
  async submitStep(_id: string, _verifier: string, step: string) { this.submitted.push(step); this.index += 1; }
  async holderBinding() { return this.holder; } async submitHolderSignature() { this.signatures += 1; this.index += 1; }
  async issue() { this.issued += 1; this.index += 1; } async result(): Promise<any> { throw new Error("unused"); } async issuerMetadata(): Promise<any> { throw new Error("unused"); } async checkStatus() { return true; }
}

test("HTTP transport emits the Rust-owned request, challenge, and proof wire shapes", async () => {
  const verifier = "V".repeat(32);
  const calls: { url: string; init: RequestInit }[] = []; const responses = [
    { status: 201, body: { type: "tinycloud.credentials/acquisition-request/v1", protocol: email.protocol, requestId: REQUEST, expiresAt: "2030-01-01T00:10:00Z", next: "challenge", endpoint: "challenge" } },
    { status: 200, body: { type: "tinycloud.credentials/acquisition-state/v1", requestId: REQUEST, state: "challenge_required", profile: email.profile, profileVersion: 1, expiresAt: "2030-01-01T00:10:00Z", resultAvailable: false, resultPreviouslyRead: false } },
    { status: 200, body: { type: "tinycloud.credentials/challenge/v1", step: "mailbox_otp", stepVersion: 1, challengeNonce: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", expiresAt: "2030-01-01T00:05:00Z", attemptsRemaining: 5 } },
    { status: 200, body: { type: "tinycloud.credentials/proof-result/v1", verified: true, next: "holder_binding" } },
  ];
  const transport = new OpenCredentialsHttpTransport(email, async (url, init = {}) => { calls.push({ url: String(url), init }); const next = responses.shift()!; return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } }); });
  const req = requirement(email); const descriptorDigest = await canonicalDigest(email); const requirementDigest = await canonicalDigest(req);
  expect((await transport.create({ descriptor: email, descriptorDigest, requirement: req, requirementDigest, holderDid: HOLDER, openerOrigin: "https://app.test", completionVerifierChallenge: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" })).requestId).toBe(REQUEST);
  expect(new URL(calls[0]!.url).pathname).toBe("/v1/acquisitions"); expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ protocol: email.protocol, profile: email.profile, profileVersion: 1, descriptorDigest, requirementDigest, holderDid: HOLDER, inputs: req.claims, audience: "tinycloud://credentials", openerOrigin: "https://app.test", completionOrigin: "https://app.test", completionContext: "sdk-acquisition", completionVerifierChallenge: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" });
  const pending = await transport.state(REQUEST, verifier); expect(pending.nextStep?.type).toBe("mailbox_otp"); expect(pending.nextStep?.constraints.challengeRequired).toBe(true); expect(calls).toHaveLength(2);
  await transport.beginStep(REQUEST, verifier, "mailbox_otp"); expect(new URL(calls[2]!.url).pathname).toBe(`/v1/acquisitions/${REQUEST}/challenge`); expect((calls[2]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${verifier}`);
  await transport.submitStep(REQUEST, verifier, "mailbox_otp", { otp: "redacted" }); expect(JSON.parse(calls[3]!.init.body as string)).toEqual({ step: "mailbox_otp", stepVersion: 1, challengeNonce: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", proof: { otp: "redacted" } });
});

for (const [code, status] of [["REQUEST_EXPIRED", 410], ["ISSUER_UNREADY", 503], ["UNSUPPORTED_PROFILE", 400], ["UNSUPPORTED_VERSION", 400], ["SIGNATURE_REJECTED", 400]] as const) {
  test(`HTTP transport preserves typed recoverable server error ${code}`, async () => {
    const transport = new OpenCredentialsHttpTransport(email, async () => new Response(JSON.stringify({
      type: "tinycloud.credentials/error/v1", code, recoverable: true,
      state: code.toLowerCase(), correlationId: REQUEST,
    }), { status, headers: { "content-type": "application/json" } }));
    await expect(transport.state(REQUEST, "V".repeat(43))).rejects.toMatchObject({ code, recoverable: true, details: { correlationId: REQUEST } });
  });
}

test("HTTP transport classifies offline and caller cancellation as recoverable", async () => {
  const offline = new OpenCredentialsHttpTransport(email, async () => { throw new TypeError("offline"); });
  await expect(offline.state(REQUEST, "V".repeat(43))).rejects.toMatchObject({ code: "OFFLINE", recoverable: true });
  const canceled = new OpenCredentialsHttpTransport(email, async () => { throw new DOMException("aborted", "AbortError"); });
  await expect(canceled.state(REQUEST, "V".repeat(43))).rejects.toMatchObject({ code: "CANCELED", recoverable: true });
});

for (const descriptor of [email, synthetic]) test(`unchanged interpreter executes ${descriptor.profile} only by primitive`, async () => {
  const req = requirement(descriptor); const descriptorDigest = await canonicalDigest(descriptor); const requirementDigest = await canonicalDigest(req); const proofType = descriptor.steps.some((step) => step.type === "mailbox_otp") ? "mailbox_otp" : "collect_input";
  const states: CredentialRequestState[] = [
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "proof", state: "pending", nextStep: { id: proofType, type: proofType, version: 1, constraints: {} }, correlationId: REQUEST },
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "sign", state: "pending", nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} }, correlationId: REQUEST },
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "issue", state: "ready_to_issue", correlationId: REQUEST },
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "complete", state: "complete", correlationId: REQUEST },
  ];
  const transport = new InterpreterTransport(states, binding(descriptor, descriptorDigest, requirementDigest));
  await interpretCredentialFlow({ descriptor, requirement: req, requestId: REQUEST, verifier: "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV", holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport, signing: { autoSign: async () => new Uint8Array([1]) }, handlers: { collect_input: async () => ({ acknowledged: true }), mailbox_otp: async () => ({ otp: "redacted" }) } });
  expect(transport.submitted).toEqual([proofType]); expect(transport.signatures).toBe(1); expect(transport.issued).toBe(1); expect(renderCredentialDescriptor(descriptor).steps.map((step) => step.primitive)).toEqual(descriptor.steps.map((step) => step.type));
});

test("uses normal approval only when the exact-request auto-sign policy declines", async () => {
  const req = requirement(synthetic); const descriptorDigest = await canonicalDigest(synthetic); const requirementDigest = await canonicalDigest(req); const states: CredentialRequestState[] = [{ type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "sign", state: "pending", nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} }, correlationId: REQUEST }, { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "done", state: "complete", correlationId: REQUEST }]; let approvals = 0;
  await interpretCredentialFlow({ descriptor: synthetic, requirement: req, requestId: REQUEST, verifier: "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV", holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport: new InterpreterTransport(states, binding(synthetic, descriptorDigest, requirementDigest)), signing: { autoSign: async () => undefined, requestApproval: async () => { approvals += 1; return new Uint8Array([2]); } } }); expect(approvals).toBe(1);
});

test.each(["CANCELED", "POPUP_BLOCKED"] as const)(
  "preserves existing %s identity from credential approval",
  async (code) => {
    const req = requirement(synthetic); const descriptorDigest = await canonicalDigest(synthetic); const requirementDigest = await canonicalDigest(req);
    const states: CredentialRequestState[] = [{ type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "sign", state: "pending", nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} }, correlationId: REQUEST }];
    const error = new CredentialError(code, "approval surface ended");
    await expect(interpretCredentialFlow({ descriptor: synthetic, requirement: req, requestId: REQUEST, verifier: "V".repeat(32), holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport: new InterpreterTransport(states, binding(synthetic, descriptorDigest, requirementDigest)), signing: { autoSign: async () => undefined, requestApproval: async () => { throw error; } } })).rejects.toBe(error);
  },
);

test("maps ordinary credential approval failure to SIGNATURE_REJECTED", async () => {
  const req = requirement(synthetic); const descriptorDigest = await canonicalDigest(synthetic); const requirementDigest = await canonicalDigest(req);
  const states: CredentialRequestState[] = [{ type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "sign", state: "pending", nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} }, correlationId: REQUEST }];
  await expect(interpretCredentialFlow({ descriptor: synthetic, requirement: req, requestId: REQUEST, verifier: "V".repeat(32), holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport: new InterpreterTransport(states, binding(synthetic, descriptorDigest, requirementDigest)), signing: { autoSign: async () => undefined, requestApproval: async () => { throw new Error("declined"); } } })).rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
});

test("popup uses a locator-only URL and exact-origin allowlisted wake messages", async () => {
  const listeners = new Set<(event: any) => void>(); const popup = { closed: false, close: () => undefined } as any; let opened = ""; const opener = { addEventListener: (_: string, listener: any) => listeners.add(listener), removeEventListener: (_: string, listener: any) => listeners.delete(listener) } as any;
  const interaction = await new BrowserCredentialInteraction("popup", { opener, open: (url) => { opened = url; return popup; }, redirect: () => undefined }).start({ interaction: email.interaction, locator: REQUEST }); expect(new URL(opened).origin).toBe(email.interaction.origin); expect(new URL(opened).search).toBe(""); expect(new URL(opened).hash).toBe("");
  let woke = false; const waiting = interaction.wake().then(() => { woke = true; }); for (const listener of listeners) listener({ origin: "https://evil.test", source: popup, data: { type: "opencredentials-wake", version: 1, locator: REQUEST } }); await Promise.resolve(); expect(woke).toBe(false); for (const listener of listeners) listener({ origin: email.interaction.origin, source: popup, data: { type: "opencredentials-wake", version: 1, locator: REQUEST } }); await waiting; expect(woke).toBe(true);
});

test("browser interaction rejects descriptor-substituted origins", async () => {
  const interaction = new BrowserCredentialInteraction("redirect", {
    opener: {} as Window,
    open: () => null,
    redirect: () => undefined,
  });
  await expect(interaction.start({
    interaction: { ...email.interaction, origin: "https://evil.test" } as typeof email.interaction,
    locator: REQUEST,
  })).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
});

test("inline interaction exposes no OpenCredentials capability to the host", async () => {
  let presented: Record<string, unknown> | undefined;
  const inline = new InlineCredentialInteraction(async (input) => {
    presented = input;
    return { wake: async () => undefined, close: () => undefined, closed: () => false, requestProof: async () => ({ code: "entered-locally" }) };
  });
  const surface = await inline.start({});
  expect(inline.kind).toBe("inline");
  expect(presented).toEqual({ signal: undefined });
  expect(await surface.requestProof?.({ descriptor: email, requirement: requirement(email), stepId: "collect_input", constraints: {} })).toEqual({ code: "entered-locally" });
  expect(await surface.wake()).toBeUndefined();
});

function kvMemory(failReadback = false) { const values = new Map<string, unknown>(); const headers = { etag: "\"etag\"", get: () => null }; return { service: { batchPut: async (items: any[]) => { for (const item of items) values.set(item.key, item.value); return { ok: true, data: { keys: items.map((item) => item.key), count: items.length } }; }, get: async (key: string) => failReadback ? { ok: false, error: {} } : values.has(key) ? { ok: true, data: { data: values.get(key), headers } } : { ok: false, error: {} }, list: async ({ prefix }: any) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(prefix)) } }) } as any }; }

test("storage succeeds only after active-owner readback", async () => {
  const req = requirement(synthetic); const claims = req.claims; const verified = { type: "OpenCredentialsIssuedCredential", version: 1, protocol: synthetic.protocol, profile: req.profile, credentialType: req.credentialType, schema: synthetic.format.vct, format: "vc+sd-jwt", issuerDid: synthetic.issuer.did, issuerKid: synthetic.issuer.kid, subjectDid: HOLDER, holderDid: HOLDER, claims, claimsDigest: await canonicalDigest(claims), descriptorDigest: await canonicalDigest(synthetic), credentialId: "credential", issuedAt: "2030-01-01T00:00:00Z", notBefore: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z", status: { method: "none", freshnessSeconds: 300 }, credential: "signed", verifiedAt: "2030-01-01T00:00:00Z", credentialDigest: await canonicalDigest("signed"), statusCheckedAt: "2030-01-01T00:00:00Z" } as VerifiedCredential; const memory = kvMemory(); const digest = await canonicalDigest(req);
  const saved = await storeCredential({ kv: memory.service, verified, requirement: req, requirementDigest: digest, activeHolderDid: HOLDER, activeOwnerDid: OWNER, now: new Date("2030-01-01T00:00:01Z") }); expect(saved.record.ownerDid).toBe(OWNER); expect(saved.record.holderDid).toBe(HOLDER); expect((await findStoredCredential({ kv: memory.service, requirement: req, holderDid: HOLDER, ownerDid: OWNER, now: new Date("2030-01-01T00:00:02Z") }))?.recordId).toBe(saved.record.recordId); expect(await findStoredCredential({ kv: memory.service, requirement: req, holderDid: HOLDER, ownerDid: "did:pkh:eip155:1:other", now: new Date("2030-01-01T00:00:02Z") })).toBeUndefined(); await expect(storeCredential({ kv: kvMemory(true).service, verified, requirement: req, requirementDigest: digest, activeHolderDid: HOLDER, activeOwnerDid: OWNER })).rejects.toMatchObject({ code: "VERIFIED_NOT_SAVED", recoverable: true }); await expect(storeCredential({ kv: memory.service, verified: { ...verified, holderDid: "did:key:other" }, requirement: req, requirementDigest: digest, activeHolderDid: HOLDER, activeOwnerDid: OWNER })).rejects.toBeInstanceOf(CredentialError);
});
