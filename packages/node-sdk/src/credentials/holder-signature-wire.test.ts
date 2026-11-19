import { expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { canonicalDigest, createHolderBinding, holderBindingSigningBytes, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import { acquireEmailProofWithIssuerKeys, createEd25519HolderSigner, EmailProofError, requestEmailProofCode } from "./email-proof";
import { interpretCredentialFlow } from "./interpreter";
import { OpenCredentialsHttpTransport } from "./transport";
import type { CredentialAcquisitionTransport, CredentialRequestState, CredentialRequirement, CredentialSigningAdapter, HolderSignatureKey } from "./types";
import { generateHolderKey, makeWitness } from "./test-support/witness-stub.mjs";

const ADDRESS = "reader@example.com";
const CODE = "12345678";
const fixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;

/** Types a fetch implementation as `typeof globalThis.fetch` without a cast: Bun's fetch type includes `preconnect`. */
function asFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: (_url?: string | URL) => {} });
}

// Holder key as Courier stores it: a private JWK plus its bare did:key.
const holderKey = generateHolderKey();
const privateKey = createPrivateKey({ key: holderKey.jwk, format: "jwk" });
const HOLDER = createEd25519HolderSigner(holderKey.bare, async (bytes) => new Uint8Array(sign(null, bytes, privateKey)));

test("the transport posts the alg it is given on the holder signature, not a hard-coded EdDSA", async () => {
  const witness = makeWitness({ code: CODE });
  const bodies: unknown[] = [];
  const fetch = asFetch(async (url, init) => {
    if (String(url).endsWith("/holder-signature")) bodies.push(JSON.parse(String(init?.body)));
    return witness.fetch(url, init);
  });
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch });
  const transport = new OpenCredentialsHttpTransport(email, fetch, { honorServerRecoverable: true });
  await transport.beginStep(pending.requestId, pending.verifier, "mailbox_otp");
  await transport.submitStep(pending.requestId, pending.verifier, "mailbox_otp", { otp: CODE });
  const binding = await transport.holderBinding(pending.requestId, pending.verifier);
  const signature = Buffer.from(await HOLDER.sign(holderBindingSigningBytes(binding))).toString("base64url");
  // HolderSignatureKey types alg as the literal "EdDSA"; the cast exists only to prove the transport forwards an override verbatim.
  const override = { alg: "ES256", kid: "custom-kid#x" } as unknown as HolderSignatureKey;
  await expect(transport.submitHolderSignature(pending.requestId, pending.verifier, signature, undefined, override))
    .rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
  expect(bodies).toEqual([{ alg: "ES256", kid: "custom-kid#x", signature }]);
});

for (const recoverable of [true, false]) {
  test(`SIGNATURE_REJECTED keeps the witness's recoverable=${recoverable} flag on the EmailProofError`, async () => {
    const witness = makeWitness({ code: CODE });
    const fetch = asFetch(async (url, init) => {
      if (String(url).endsWith("/holder-signature")) {
        return Response.json(
          { type: "tinycloud.credentials/error/v1", code: "SIGNATURE_REJECTED", recoverable, state: "holder_signature_required", correlationId: "corr-1" },
          { status: 400 },
        );
      }
      return witness.fetch(url, init);
    });
    const error: unknown = await acquireEmailProofWithIssuerKeys({ address: ADDRESS, holder: HOLDER, getCode: async () => CODE, fetch }, witness.issuerKeys).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmailProofError);
    expect(error).toMatchObject({ code: "SIGNATURE_REJECTED", recoverable });
  });
}

test("interpretCredentialFlow hands the signing adapter's holderKey to submitHolderSignature as the fifth argument", async () => {
  const requestId = "request-id-0123456789abcdef";
  const verifier = "verifier-token-0123456789";
  const origin = "https://app.example.com";
  const descriptorDigest = await canonicalDigest(email);
  const requirementDigest = await canonicalDigest({ requirement: "email-proof" });
  const binding = createHolderBinding({
    profileVersion: 1,
    requestId,
    profile: email.profile,
    descriptorDigest,
    requirementDigest,
    issuer: email.issuer.did,
    issuerKid: email.issuer.kid,
    holderDid: HOLDER.did,
    normalizedClaimsDigest: await canonicalDigest({ email: ADDRESS }),
    challengeNonce: "nonce-0123456789abcdef",
    audience: "tinycloud://credentials",
    openerOrigin: origin,
    completionOrigin: origin,
    completionContext: "context-0123456789abcdef",
    jti: "jti-0123456789abcdefgh",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const state = (overrides: Partial<CredentialRequestState>): CredentialRequestState => ({
    type: "OpenCredentialsAcquisitionState",
    version: 1,
    requestId,
    transitionId: "transition-1",
    state: "pending",
    correlationId: "corr-1",
    ...overrides,
  });
  const states = [
    state({ nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} } }),
    state({ transitionId: "transition-2", state: "complete" }),
  ];
  const submitted: unknown[][] = [];
  const transport = {
    state: async () => states.shift(),
    holderBinding: async () => binding,
    submitHolderSignature: async (...args: unknown[]) => { submitted.push(args); },
  } as unknown as CredentialAcquisitionTransport;
  const signing: CredentialSigningAdapter = {
    autoSign: async () => new Uint8Array([1, 2, 3]),
    holderKey: { alg: "EdDSA", kid: "holder-kid#fragment" },
  };

  await interpretCredentialFlow({
    descriptor: email,
    requirement: { claims: { email: ADDRESS } } as unknown as CredentialRequirement,
    requestId,
    verifier,
    holderDid: HOLDER.did,
    descriptorDigest,
    requirementDigest,
    openerOrigin: origin,
    transport,
    signing,
  });

  expect(submitted).toHaveLength(1);
  expect(submitted[0]?.[4]).toEqual({ alg: "EdDSA", kid: "holder-kid#fragment" });
});
