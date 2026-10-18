import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, computeCid, fromBase64Url, signEnvelopeV3, toBase64Url, verifyEnvelopeV3, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { verifyEnvelopeV3At } from "../../src/share-index/verify/policy-v3.js";
import { newKey, rawCid, type TestKey } from "./helpers.js";
import v3Fixture from "./fixtures/v3-envelope.json";

/**
 * `verifyEnvelopeV3At` is a copy of share-envelope `verifyEnvelopeV3` with an
 * explicit clock. With the clock frozen inside the binding window, the two must
 * agree on a genuine envelope and on every single-field tamper, and every
 * tamper must be refused. The envelope is the real one from a local node (the
 * fixture), re-signed under throwaway owner and node keys so that each tamper
 * can be re-signed at the outer layers and reach the check it targets.
 */
const encoder = new TextEncoder();
const POLICY_V1_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
const ATTESTED_ENFORCER_V2_DOMAIN = "xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0";

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
function base32Lower(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += alphabet[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

function decodeSegment(segment: string): Json {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(segment))) as Json;
}

/** A canonical compact root UCAN signed by `key`. */
function signRoot(key: TestKey, payload: Json): { readonly authorization: string; readonly cid: string } {
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(ed25519.getPublicKey(key.privateKey)) }, typ: "JWT", ucv: "0.10.0" };
  const h = toBase64Url(encoder.encode(canonicalize(header)));
  const p = toBase64Url(encoder.encode(canonicalize(payload)));
  const authorization = `${h}.${p}.${toBase64Url(ed25519.sign(encoder.encode(`${h}.${p}`), key.privateKey))}`;
  return { authorization, cid: rawCid(encoder.encode(authorization)) };
}

interface Built {
  readonly owner: TestKey;
  readonly node: TestKey;
  readonly envelope: ShareEnvelopeV3;
  readonly rootPayloads: { readonly policy: Json; readonly enforcement: Json };
}

/**
 * Tampers that must reach one specific check: every value derived from the
 * tampered one (roots' facts, outer signature) is redone around it, so only
 * the targeted check can refuse the envelope.
 */
interface Consistent {
  /** A policy signature that does not verify; policyCid and the roots' facts follow it. */
  readonly forgePolicySignature?: boolean;
  /** A policyCid that is not the CID of the policy bytes, named by the roots' facts too. */
  readonly policyCid?: string;
  /** A contentSourceDigestHex that is not the content source's digest, named by the roots' facts too. */
  readonly contentSourceDigestHex?: string;
}

/** The fixture's envelope, every signature redone under fresh (or the given) owner and node keys. */
async function build(tamper: Consistent = {}, keys: { readonly owner: TestKey; readonly node: TestKey } = { owner: newKey(), node: newKey() }): Promise<Built> {
  const { owner, node } = keys;
  const template = clone(v3Fixture.v3.envelope) as unknown as Json & { policy: Json; target: Json; attestedEnforcerBinding: Json; policyRoot: Json; enforcementRoot: Json };
  const { policyId: _policyId, signature: _signature, ...unsignedPolicy } = { ...template.policy, ownerDid: owner.did };
  const policyDigest = sha256(encoder.encode(`${POLICY_V1_DOMAIN}${canonicalize(unsignedPolicy)}`));
  const policySignature = ed25519.sign(policyDigest, owner.privateKey);
  if (tamper.forgePolicySignature === true) policySignature[0] = policySignature[0]! ^ 0x01;
  const policy = { ...unsignedPolicy, policyId: `pol_${base32Lower(policyDigest)}`, signature: { suite: "Ed25519", signerDid: owner.did, value: toBase64Url(policySignature) } };
  const policyCid = tamper.policyCid ?? await computeCid(encoder.encode(canonicalize(policy)));
  const contentSourceDigestHex = tamper.contentSourceDigestHex ?? (template.contentSourceDigestHex as string);
  const { signature: _bindingSignature, ...unsignedBinding } = {
    ...template.attestedEnforcerBinding, enforcerDid: node.did, nodeAudience: node.did,
    attestationBindingDigestHex: hex(sha256(encoder.encode(canonicalize({ enforcerDid: node.did, nodeAudience: node.did })))),
  };
  const bindingSignature = ed25519.sign(sha256(encoder.encode(`${ATTESTED_ENFORCER_V2_DOMAIN}${canonicalize(unsignedBinding)}`)), node.privateKey);
  const binding = { ...unsignedBinding, signature: { suite: "Ed25519", signerDid: node.did, value: toBase64Url(bindingSignature) } };
  const rootPayload = (root: Json, aud: string): Json => {
    const payload = decodeSegment((root.authorization as string).split(".")[1]!);
    const fact = (payload.fct as Json[])[0]!;
    const facts = { ...fact, ownerDid: owner.did, policyId: policy.policyId, policyDigestHex: hex(policyDigest), policyCid, contentSourceDigestHex, nodeAudience: node.did, ...("enforcerDid" in fact ? { enforcerDid: node.did } : {}) };
    return { ...payload, iss: `${owner.did}#${owner.did.slice("did:key:".length)}`, aud, fct: [facts] };
  };
  const policyPayload = rootPayload(template.policyRoot, `did:tinycloud:policy:${hex(policyDigest)}`);
  const enforcementPayload = rootPayload(template.enforcementRoot, node.did);
  const policyRoot = { ...template.policyRoot, ...signRoot(owner, policyPayload) };
  const enforcementRoot = { ...template.enforcementRoot, ...signRoot(owner, enforcementPayload) };
  const { signature: _outer, ...unsigned } = { ...template, policy, policyCid, contentSourceDigestHex, target: { ...template.target, nodeAudience: node.did }, attestedEnforcerBinding: binding, policyRoot, enforcementRoot };
  const envelope = signEnvelopeV3(unsigned as never, owner.privateKey);
  return { owner, node, envelope, rootPayloads: { policy: policyPayload, enforcement: enforcementPayload } };
}

/** Re-sign the outer envelope so a tamper reaches the inner check it targets. */
function resign(built: Built, envelope: Json): ShareEnvelopeV3 {
  const { signature: _signature, ...unsigned } = envelope;
  return signEnvelopeV3(unsigned as never, built.owner.privateKey);
}

const flipLastByte = (value: string): string => {
  const bytes = fromBase64Url(value);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
  return toBase64Url(bytes);
};

const binding = v3Fixture.v3.envelope.attestedEnforcerBinding;
/** Inside the binding window: a minute after the node issued it. */
const NOW = Date.parse(binding.issuedAt) + 60_000;

afterEach(() => { setSystemTime(); });

async function both(envelope: ShareEnvelopeV3, signer: string): Promise<readonly [boolean, boolean]> {
  setSystemTime(new Date(NOW));
  const original = await verifyEnvelopeV3(envelope, { expectedSignerDid: signer });
  const copy = await verifyEnvelopeV3At(envelope, signer, NOW);
  return [original, copy];
}

describe("verifyEnvelopeV3At matches share-envelope verifyEnvelopeV3 on a frozen clock", () => {
  test("the re-signed real envelope verifies under both", async () => {
    const built = await build();
    expect(await both(built.envelope, built.owner.did)).toEqual([true, true]);
  });

  test("every single-field tamper is refused by both", async () => {
    const built = await build();
    const { owner } = built;
    const keys = { owner, node: built.node };
    // Each "consistent" tamper rebuilds everything derived from the tampered value, so only its own check can refuse it.
    const consistent: Record<string, Consistent> = {
      "policy signature (policyCid and facts follow it)": { forgePolicySignature: true },
      "policyCid (named by the roots' facts too)": { policyCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" },
      "contentSourceDigestHex (named by the roots' facts too)": { contentSourceDigestHex: "0".repeat(64) },
    };
    for (const [name, tamper] of Object.entries(consistent)) {
      expect({ name, results: await both((await build(tamper, keys)).envelope, owner.did) }).toEqual({ name, results: [false, false] });
    }
    const tampers: Record<string, () => ShareEnvelopeV3> = {
      "outer signature": () => ({ ...clone(built.envelope), signature: { ...built.envelope.signature, value: flipLastByte(built.envelope.signature.value) } }),
      "policy signature": () => {
        const env = clone(built.envelope) as unknown as Json & { policy: Json & { signature: Json } };
        env.policy.signature.value = flipLastByte(env.policy.signature.value as string);
        return resign(built, env);
      },
      "binding signature": () => {
        const env = clone(built.envelope) as unknown as Json & { attestedEnforcerBinding: Json & { signature: Json } };
        env.attestedEnforcerBinding.signature.value = flipLastByte(env.attestedEnforcerBinding.signature.value as string);
        return resign(built, env);
      },
      policyCid: () => resign(built, { ...clone(built.envelope), policyCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" }),
      "policyRoot authorization bytes (bad signature, CID recomputed)": () => {
        const env = clone(built.envelope) as unknown as Json & { policyRoot: Json };
        const authorization = env.policyRoot.authorization as string;
        const [h, p, s] = authorization.split(".") as [string, string, string];
        const forged = `${h}.${p}.${flipLastByte(s)}`;
        env.policyRoot = { ...env.policyRoot, authorization: forged, cid: rawCid(encoder.encode(forged)) };
        return resign(built, env);
      },
      "enforcementRoot authorization bytes (bad signature, CID recomputed)": () => {
        const env = clone(built.envelope) as unknown as Json & { enforcementRoot: Json };
        const [h, p, s] = (env.enforcementRoot.authorization as string).split(".") as [string, string, string];
        const forged = `${h}.${p}.${flipLastByte(s)}`;
        env.enforcementRoot = { ...env.enforcementRoot, authorization: forged, cid: rawCid(encoder.encode(forged)) };
        return resign(built, env);
      },
      "policyRoot CID": () => {
        const env = clone(built.envelope) as unknown as Json & { policyRoot: Json };
        env.policyRoot = { ...env.policyRoot, cid: rawCid(encoder.encode("other")) };
        return resign(built, env);
      },
      "enforcementRoot CID": () => {
        const env = clone(built.envelope) as unknown as Json & { enforcementRoot: Json };
        env.enforcementRoot = { ...env.enforcementRoot, cid: rawCid(encoder.encode("other")) };
        return resign(built, env);
      },
      "policyRoot attenuation (owner-signed, widened)": () => {
        const env = clone(built.envelope) as unknown as Json & { policyRoot: Json };
        const payload = { ...built.rootPayloads.policy, att: { ...(built.rootPayloads.policy.att as Json), "tinycloud:other/kv/x": { "tinycloud.kv/get": [{}] } } };
        env.policyRoot = { ...env.policyRoot, ...signRoot(owner, payload) };
        return resign(built, env);
      },
      "enforcementRoot attenuation (owner-signed, widened)": () => {
        const env = clone(built.envelope) as unknown as Json & { enforcementRoot: Json };
        const payload = { ...built.rootPayloads.enforcement, att: { ...(built.rootPayloads.enforcement.att as Json), "tinycloud:other/kv/x": { "tinycloud.kv/get": [{}] } } };
        env.enforcementRoot = { ...env.enforcementRoot, ...signRoot(owner, payload) };
        return resign(built, env);
      },
      contentSourceDigestHex: () => resign(built, { ...clone(built.envelope), contentSourceDigestHex: "0".repeat(64) }),
    };
    for (const [name, tamper] of Object.entries(tampers)) {
      expect({ name, results: await both(tamper(), owner.did) }).toEqual({ name, results: [false, false] });
    }
    // Another expected signer is refused by both too.
    expect(await both(built.envelope, newKey().did)).toEqual([false, false]);
  });

  test("outside the binding window both refuse; the copy judges the window at its own clock only", async () => {
    const built = await build();
    setSystemTime(new Date(Date.parse(binding.expiresAt)));
    expect(await verifyEnvelopeV3(built.envelope, { expectedSignerDid: built.owner.did })).toBe(false);
    expect(await verifyEnvelopeV3At(built.envelope, built.owner.did, Date.parse(binding.expiresAt))).toBe(false);
    // The system clock does not move the copy: it verifies at a time inside the window.
    expect(await verifyEnvelopeV3At(built.envelope, built.owner.did, NOW)).toBe(true);
  });
});
