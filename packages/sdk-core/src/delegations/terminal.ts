import { blake3 } from "@noble/hashes/blake3";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { decodeBase64Url, encodeBase64Url } from "../credentials/digest";

/**
 * The UCAN fact a TinyCloud node reads when admitting a child delegation:
 * a parent carrying it is refused with `terminal-parent-cannot-redelegate`.
 * The node matches any object in the payload's `fct` array with this exact
 * key and string value (tinycloud-core `util.rs` `DelegationMode`).
 */
export const TERMINAL_DELEGATION_FACT: Readonly<Record<string, string>> = Object.freeze({
  "xyz.tinycloud.policy/delegationMode": "terminal",
});

/** The Ed25519 session key a UCAN delegation was signed with. */
export interface TerminalDelegationSigningKey {
  readonly kty?: string;
  readonly crv?: string;
  readonly d?: string;
}

/**
 * Add {@link TERMINAL_DELEGATION_FACT} to a signed session-key UCAN delegation.
 *
 * The WASM delegation builder takes no facts, so the token it signed is
 * reopened, the fact appended to `fct`, and the payload re-signed with the
 * same key, which must be the token's issuer. Every other claim is kept as
 * signed; a token that already carries the fact is returned unchanged.
 * Returns the token and its CID (CIDv1, raw codec, BLAKE3-256, as the node
 * stores it).
 */
export function markDelegationTerminal(
  token: string,
  key: TerminalDelegationSigningKey,
): { delegation: string; cid: string } {
  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(decodeBase64Url(headerSegment!)));
  const payload = JSON.parse(decoder.decode(decodeBase64Url(payloadSegment!)));
  if (signatureSegment === undefined || header.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519" || !key.d) {
    throw new Error("terminal delegations require an Ed25519 session key");
  }
  const privateKey = decodeBase64Url(key.d);
  const signer = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...ed25519.getPublicKey(privateKey)))}`;
  if (typeof payload.iss !== "string" || payload.iss.split("#")[0] !== signer) {
    throw new Error("session key is not the delegation issuer");
  }
  const facts: unknown = payload.fct ?? [];
  if (!Array.isArray(facts)) throw new Error("delegation facts are not an array");
  const encoder = new TextEncoder();
  let delegation = token;
  if (!facts.some((fact) => fact?.["xyz.tinycloud.policy/delegationMode"] === "terminal")) {
    payload.fct = [...facts, { ...TERMINAL_DELEGATION_FACT }];
    const signingInput = `${headerSegment}.${encodeBase64Url(encoder.encode(JSON.stringify(payload)))}`;
    delegation = `${signingInput}.${encodeBase64Url(ed25519.sign(encoder.encode(signingInput), privateKey))}`;
  }
  return { delegation, cid: CID.createV1(0x55, createDigest(0x1e, blake3(encoder.encode(delegation)))).toString() };
}
