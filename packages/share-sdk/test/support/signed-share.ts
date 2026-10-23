import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { canonicalize, generateKey, seal, toBase64Url } from "@tinycloud/share-envelope";
import { buildFullLink, prepareLinkRecord, signerFromSeed } from "@tinycloud/share-envelope/links";

/**
 * Fixtures for a fully signed Policy/v3 envelope: real owner and node keys, real compact-UCAN roots and a signed
 * enforcer binding, so `verifyEnvelopeV3` passes without OpenCredentials. Test keys only; shared by artifact-pin.test.ts
 * and the real-node evidence script.
 */
export const didFor = (seed: Uint8Array) => `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))}`;
export const ownerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
export const ownerDid = didFor(ownerSeed);
export const foreignSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
export const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
export const nodeDid = didFor(nodeSeed);
export const enc = (value: string) => new TextEncoder().encode(value);

/**
 * A real owner root, as `verifyEnvelopeV3` demands: a compact UCAN signed by the owner key, carrying the policy facts
 * and the attenuation the policy's capabilities imply. (`signCompactUcanAuthorization` caps a lifetime at 60 s, which
 * is for invocations; share roots live as long as the share, so the token is assembled here the way the node does.)
 */
export function signedRoot(input: AddressedOwnerRootInput): { readonly cid: string; readonly delegationHeader: { readonly Authorization: string } } {
  const attenuation = Object.fromEntries(input.capabilities.map((capability) => capability.kind === "encryption"
    ? [capability.resource, { [capability.action]: [{}] }]
    : [capability.resource, Object.fromEntries(capability.actions.map((action) => [action, [{ kind: capability.selector, type: "xyz.tinycloud.resource/selector", value: capability.resource }]]))]));
  const fact = {
    ownerDid: input.ownerDid, policyId: input.policyId, policyDigestHex: input.policyDigestHex, policyCid: input.policyCid,
    contentSourceDigestHex: input.contentSourceDigestHex, capabilityCeilingHashHex: input.capabilityCeilingHashHex,
    nativeProjectionHashHex: input.nativeProjectionHashHex, nodeAudience: input.nodeAudience, role: input.role,
    ...(input.role === "policy-authority" ? { mode: "policy-source" } : { mode: "conditional-mint", enforcerDid: input.audienceDid }),
  };
  const principal = input.ownerDid;
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(ed25519.getPublicKey(ownerSeed)) }, typ: "JWT", ucv: "0.10.0" };
  const payload = {
    att: attenuation, aud: input.audienceDid, exp: Math.floor(input.expiresAt.getTime() / 1000), fct: [fact],
    iss: `${principal}#${principal.slice("did:key:".length)}`, nbf: Math.floor(input.notBefore.getTime() / 1000), nnc: crypto.randomUUID(), prf: [] as string[],
  };
  const head = toBase64Url(enc(canonicalize(header)));
  const body = toBase64Url(enc(canonicalize(payload)));
  const authorization = `${head}.${body}.${toBase64Url(ed25519.sign(enc(`${head}.${body}`), ownerSeed))}`;
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(enc(authorization)))).toString();
  return { cid, delegationHeader: { Authorization: authorization } };
}

/** The node's attested enforcer binding, signed by the node key, valid for the whole share lifetime. */
export function signedBinding(expiresAt: Date) {
  const unsigned = {
    schema: "xyz.tinycloud.policy/attested-enforcer/v2" as const, enforcerDid: nodeDid, nodeAudience: nodeDid,
    attestationBindingDigestHex: Array.from(sha256(enc(canonicalize({ enforcerDid: nodeDid, nodeAudience: nodeDid }))), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(expiresAt.getTime() + 3600_000).toISOString(),
  };
  const digest = sha256(enc(`xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0${canonicalize(unsigned)}`));
  return { ...unsigned, signature: { suite: "Ed25519" as const, signerDid: nodeDid, value: toBase64Url(ed25519.sign(digest, nodeSeed)) } };
}

/**
 * Seal an envelope into the full `v=4` link `inspectShare` opens. The header is signed by whichever test key signed
 * the envelope (the envelope's signer is the issuer every reader binds the record to).
 */
export async function linkFor(envelope: unknown): Promise<string> {
  const key = generateKey();
  const sealed = await seal(enc(canonicalize(envelope)), key);
  const fields = typeof envelope === "object" && envelope !== null ? envelope : {};
  const signature = "signature" in fields && typeof fields.signature === "object" && fields.signature !== null ? fields.signature : {};
  const issuerSeed = "signerDid" in signature && signature.signerDid === didFor(foreignSeed) ? foreignSeed : ownerSeed;
  const expiry = "expiry" in fields && typeof fields.expiry === "string" ? Date.parse(fields.expiry) : Number.NaN;
  const { record } = await prepareLinkRecord({
    type: "share",
    sealed: { blob: sealed.blob, key },
    issuerKey: signerFromSeed(issuerSeed),
    apiOrigin: "https://api.tinycloud.xyz",
    expiresAt: new Date(expiry > Date.now() ? expiry : Date.now() + 3600_000),
    enforceServiceLife: false,
  });
  return buildFullLink({ origin: "https://share.tinycloud.xyz", key, record });
}

