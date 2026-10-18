import { blake3 } from "@noble/hashes/blake3";
import { ed25519 } from "@noble/curves/ed25519";
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
  readonly x?: string;
  readonly d?: string;
}

/**
 * Add {@link TERMINAL_DELEGATION_FACT} to a signed session-key UCAN delegation.
 *
 * The WASM delegation builder takes no facts, so the token it signed is
 * reopened, the fact appended to `fct`, and the payload re-signed with the
 * same key. Every other claim is kept as signed. Returns the new token and
 * its CID (CIDv1, raw codec, BLAKE3-256, the form the node stores).
 */
export function markDelegationTerminal(
  token: string,
  key: TerminalDelegationSigningKey,
): { delegation: string; cid: string } {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("delegation is not a compact UCAN");
  const [headerSegment, payloadSegment] = segments as [string, string, string];
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(decodeBase64Url(headerSegment))) as { alg?: unknown };
  if (header.alg !== "EdDSA") throw new Error("terminal delegations require an Ed25519 session key");
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || !key.d || !key.x) {
    throw new Error("terminal delegations require an Ed25519 session key");
  }
  const privateKey = decodeBase64Url(key.d);
  const publicKey = encodeBase64Url(ed25519.getPublicKey(privateKey));
  if (publicKey !== key.x) throw new Error("session key does not match its public key");

  const payload = JSON.parse(decoder.decode(decodeBase64Url(payloadSegment))) as Record<string, unknown>;
  const facts = payload.fct;
  if (facts !== undefined && facts !== null && !Array.isArray(facts)) {
    throw new Error("delegation facts are not an array");
  }
  payload.fct = [...(facts ?? []), { ...TERMINAL_DELEGATION_FACT }];

  const encoder = new TextEncoder();
  const signingInput = `${headerSegment}.${encodeBase64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = ed25519.sign(encoder.encode(signingInput), privateKey);
  const delegation = `${signingInput}.${encodeBase64Url(signature)}`;
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(encoder.encode(delegation)))).toString();
  return { delegation, cid };
}
