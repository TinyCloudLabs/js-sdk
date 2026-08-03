import { CredentialError, canonicalDigest, createHolderBinding, type CredentialFlowDescriptor, type CredentialRequirement, type VerifiedCredential } from "@tinycloud/sdk-core";
import { BrowserCredentialInteraction } from "../src/credentials/browser";
import { interpretCredentialFlow } from "../src/credentials/interpreter";
import { renderCredentialDescriptor } from "../src/credentials/renderer";
import { findStoredCredential, storeCredential } from "../src/credentials/storage";
import type { CredentialAcquisitionTransport, CredentialRequestState } from "../src/credentials/types";

const HOLDER = "did:key:z6MkActive";
const ORIGIN = "https://issuer.test";

function flow(profile: string, primitives: CredentialFlowDescriptor["steps"]): CredentialFlowDescriptor {
  return {
    type: "OpenCredentialsFlowDescriptor", protocol: "tinycloud.credentials/acquisition/v1", version: 1, stepRegistryVersion: 1,
    profile: { id: profile, version: 1 }, issuer: { origin: ORIGIN, did: "did:web:issuer.test" }, credential: { type: `opencredentials.${profile}`, version: 1, schema: `urn:${profile}`, format: "vc+sd-jwt" },
    claims: [{ id: "identifier", matching: "exact", required: true }], inputs: [{ id: "identifier", label: "Identifier", required: true, prefill: "allowed", schema: { type: "string" }, accessibility: { label: "Identifier" } }], steps: primitives,
    holderBinding: { required: true, domain: "tinycloud.credentials/holder-binding/v1", version: 1 }, endpoints: { create_request: "create_request", request_state: "request_state", create_challenge: "create_challenge", submit_proof: "submit_proof", holder_binding: "holder_binding", submit_holder_signature: "submit_holder_signature", issue: "issue", result: "result", issuer_metadata: "issuer_metadata", credential_status: "credential_status", interaction: "interaction" },
    ttlSeconds: 600, freshnessSeconds: 300, presentation: { title: "Credential", description: "Description", consent: "Consent", progressLabel: "Progress", successLabel: "Success", recoveryLabel: "Recovery" },
  };
}

const inputStep = { id: "input", type: "collect_input", version: 1, endpoint: "submit_proof", title: "Input", description: "Input" } as const;
const otpStep = { id: "otp", type: "mailbox_otp", version: 1, endpoint: "submit_proof", title: "OTP", description: "OTP" } as const;
const signStep = { id: "sign", type: "holder_signature", version: 1, endpoint: "holder_binding", title: "Sign", description: "Sign" } as const;

function requirement(descriptor: CredentialFlowDescriptor): CredentialRequirement { return { type: "TinyCloudCredentialRequirement", version: 1, profile: descriptor.profile, credentialType: { id: descriptor.credential.type, version: 1 }, claims: { identifier: "alice" } }; }

class InterpreterTransport implements CredentialAcquisitionTransport {
  index = 0; submitted: string[] = []; signatures = 0; issued = 0;
  constructor(readonly descriptor: CredentialFlowDescriptor, readonly states: readonly CredentialRequestState[], readonly binding: any) {}
  async create(): Promise<any> { throw new Error("unused"); }
  async state() { return this.states[Math.min(this.index, this.states.length - 1)]!; }
  async submitStep(_id: string, _verifier: string, step: string) { this.submitted.push(step); this.index += 1; }
  async holderBinding() { return this.binding; }
  async submitHolderSignature() { this.signatures += 1; this.index += 1; }
  async issue() { this.issued += 1; this.index += 1; }
  async result(): Promise<any> { throw new Error("unused"); }
  async issuerMetadata(): Promise<any> { throw new Error("unused"); }
  async checkStatus() { return true; }
}

test.each([
  ["tinycloud.email-proof", [inputStep, otpStep, signStep]],
  ["tinycloud.dev.synthetic-handle", [inputStep, signStep]],
])("unchanged interpreter executes %s only by primitive", async (profile, steps) => {
  const descriptor = flow(profile as string, steps as any); const req = requirement(descriptor); const descriptorDigest = await canonicalDigest(descriptor); const requirementDigest = await canonicalDigest(req);
  const binding = await createHolderBinding({ requestId: "request_abcdefghijklmnop", descriptor, descriptorDigest, requirement: req, requirementDigest, issuerKid: "did:web:issuer.test#key", holderDid: HOLDER, claimsDigest: await canonicalDigest(req.claims), challengeNonce: "nonce_abcdefghijklmnop", openerOrigin: "https://app.test", audience: ORIGIN, completionContext: { mode: "popup" }, jti: "binding_abcdefghijklmnop", issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:05:00.000Z" });
  const pending = steps.map((step, index) => ({ type: "OpenCredentialsAcquisitionState", version: 1, requestId: "request_abcdefghijklmnop", transitionId: `transition_${index}abcdefghijk`, state: "pending", nextStep: { id: step.id, type: step.type, version: 1, constraints: {} }, correlationId: "correlation_abcdefgh" } as CredentialRequestState));
  const transport = new InterpreterTransport(descriptor, [...pending, { type: "OpenCredentialsAcquisitionState", version: 1, requestId: "request_abcdefghijklmnop", transitionId: "transition_ready_abc", state: "ready_to_issue", correlationId: "correlation_abcdefgh" }, { type: "OpenCredentialsAcquisitionState", version: 1, requestId: "request_abcdefghijklmnop", transitionId: "transition_complete", state: "complete", correlationId: "correlation_abcdefgh" }], binding);
  let autoSigns = 0;
  await interpretCredentialFlow({ descriptor, requirement: req, requestId: "request_abcdefghijklmnop", verifier: "verifier_abcdefghijklmnop", holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport, signing: { autoSign: async () => { autoSigns += 1; return new Uint8Array([1]); } }, handlers: { collect_input: async () => ({ identifier: "alice" }), mailbox_otp: async () => ({ code: "redacted" }) } });
  expect(transport.submitted).toEqual(steps.filter((step) => step.type !== "holder_signature").map((step) => step.id));
  expect(autoSigns).toBe(1); expect(transport.signatures).toBe(1); expect(transport.issued).toBe(1);
  expect(renderCredentialDescriptor(descriptor).steps.map((step) => step.primitive)).toEqual(steps.map((step) => step.type));
});

test("falls back to normal approval only when exact-request auto-sign does not apply", async () => {
  const descriptor = flow("tinycloud.dev.synthetic-handle", [signStep]); const req = requirement(descriptor); const descriptorDigest = await canonicalDigest(descriptor); const requirementDigest = await canonicalDigest(req);
  const binding = await createHolderBinding({ requestId: "request_abcdefghijklmnop", descriptor, descriptorDigest, requirement: req, requirementDigest, issuerKid: "did:web:issuer.test#key", holderDid: HOLDER, claimsDigest: await canonicalDigest(req.claims), challengeNonce: "nonce_abcdefghijklmnop", openerOrigin: "https://app.test", audience: ORIGIN, completionContext: {}, jti: "binding_abcdefghijklmnop", issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:05:00.000Z" });
  const states: CredentialRequestState[] = [{ type: "OpenCredentialsAcquisitionState", version: 1, requestId: binding.requestId, transitionId: "transition_sign_abc", state: "pending", nextStep: { id: "sign", type: "holder_signature", version: 1, constraints: {} }, correlationId: "correlation_abcdefgh" }, { type: "OpenCredentialsAcquisitionState", version: 1, requestId: binding.requestId, transitionId: "transition_ready_abc", state: "ready_to_issue", correlationId: "correlation_abcdefgh" }, { type: "OpenCredentialsAcquisitionState", version: 1, requestId: binding.requestId, transitionId: "transition_complete", state: "complete", correlationId: "correlation_abcdefgh" }];
  const transport = new InterpreterTransport(descriptor, states, binding); let approvals = 0;
  await interpretCredentialFlow({ descriptor, requirement: req, requestId: binding.requestId, verifier: "verifier_abcdefghijklmnop", holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport, signing: { autoSign: async () => undefined, requestApproval: async () => { approvals += 1; return new Uint8Array([2]); } } });
  expect(approvals).toBe(1);
});

test("popup uses a locator-only URL and accepts only exact-origin allowlisted wake messages", async () => {
  const listeners = new Set<(event: any) => void>(); const popup = { closed: false, close: jest.fn() } as any; let opened = "";
  const opener = { addEventListener: (_: string, listener: any) => listeners.add(listener), removeEventListener: (_: string, listener: any) => listeners.delete(listener) } as any;
  const adapter = new BrowserCredentialInteraction("popup", { opener, open: (url) => { opened = url; return popup; }, redirect: jest.fn() });
  const interaction = await adapter.start({ issuerOrigin: ORIGIN, locator: "locator_abcdefghijklmnop" });
  expect(new URL(opened).search).toBe(""); expect(new URL(opened).hash).toBe("");
  let woke = false; const waiting = interaction.wake().then(() => { woke = true; });
  for (const listener of listeners) listener({ origin: "https://evil.test", source: popup, data: { type: "opencredentials-wake", version: 1, locator: "locator_abcdefghijklmnop" } });
  for (const listener of listeners) listener({ origin: ORIGIN, source: popup, data: { type: "opencredentials-wake", version: 1, locator: "locator_abcdefghijklmnop", credential: "secret" } });
  await Promise.resolve(); expect(woke).toBe(false);
  for (const listener of listeners) listener({ origin: ORIGIN, source: popup, data: { type: "opencredentials-wake", version: 1, locator: "locator_abcdefghijklmnop" } });
  await waiting; expect(woke).toBe(true); interaction.close();
});

function kvMemory(failReadback = false) {
  const values = new Map<string, unknown>();
  const headers = { etag: '"etag"', get: () => null };
  return {
    values,
    service: {
      batchPut: jest.fn(async (items: any[]) => { for (const item of items) values.set(item.key, item.value); return { ok: true, data: { keys: items.map((item) => item.key), count: items.length } }; }),
      get: jest.fn(async (key: string) => failReadback ? { ok: false, error: {} } : values.has(key) ? { ok: true, data: { data: values.get(key), headers } } : { ok: false, error: {} }),
      list: jest.fn(async ({ prefix }: any) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(prefix)) } })),
    } as any,
  };
}

test("storage reports success only after active-owner readback and emits VERIFIED_NOT_SAVED otherwise", async () => {
  const descriptor = flow("tinycloud.dev.synthetic-handle", [signStep]); const req = requirement(descriptor);
  const verified = { type: "OpenCredentialsIssuedCredential", version: 1, protocol: descriptor.protocol, profile: descriptor.profile, credentialType: req.credentialType, schema: descriptor.credential.schema, format: "vc+sd-jwt", issuerDid: descriptor.issuer.did, issuerKid: `${descriptor.issuer.did}#key`, subjectDid: HOLDER, holderDid: HOLDER, claims: req.claims, claimsDigest: await canonicalDigest(req.claims), descriptorDigest: await canonicalDigest(descriptor), credentialId: "credential", issuedAt: "2030-01-01T00:00:00.000Z", notBefore: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T01:00:00.000Z", status: { method: "issuer", reference: "urn:opencredentials:status:abcdefghijklmnop" }, credential: "signed", verifiedAt: "2030-01-01T00:00:00.000Z", credentialDigest: await canonicalDigest("signed"), statusCheckedAt: "2030-01-01T00:00:00.000Z" } as VerifiedCredential;
  const memory = kvMemory(); const saved = await storeCredential({ kv: memory.service, verified, requirement: req, requirementDigest: await canonicalDigest(req), activeOwnerDid: HOLDER, now: new Date("2030-01-01T00:00:01.000Z") });
  expect(saved.receipt.ownerDid).toBe(HOLDER); expect(await findStoredCredential({ kv: memory.service, requirement: req, holderDid: HOLDER, now: new Date("2030-01-01T00:00:02.000Z") })).toMatchObject({ recordId: saved.record.recordId });
  await expect(storeCredential({ kv: kvMemory(true).service, verified, requirement: req, requirementDigest: await canonicalDigest(req), activeOwnerDid: HOLDER })).rejects.toMatchObject({ code: "VERIFIED_NOT_SAVED", recoverable: true });
  await expect(storeCredential({ kv: memory.service, verified: { ...verified, holderDid: "did:key:other" }, requirement: req, requirementDigest: await canonicalDigest(req), activeOwnerDid: HOLDER })).rejects.toBeInstanceOf(CredentialError);
});
