import { ed25519 } from "@noble/curves/ed25519";
import { computeCid, ed25519PublicKeyFromDidKey, fromBase64Url } from "@tinycloud/share-envelope";
import { POLICY_ENFORCEMENT_DOMAIN, dagCborEncode, type SignedDelegation } from "../../owner-policy.js";

/**
 * Verifier for a Policy/v2 enforcement delegation
 * (`TinyCloudSharePolicyEnforcement`, signed by the share key;
 * `createPolicyEnforcementDelegation`). No verifier existed before
 * (design C §5 check 7, C4).
 *
 * Checks, all fail-closed:
 * - the DAG-CBOR bytes are exactly the canonical encoding of
 *   `{ domain, unsigned: { type, version: 2, issuerDid, audienceDid, facts } }`
 *   built from the delegation's own fields (so every reported field is signed);
 * - the Ed25519 signature over those bytes verifies against `issuerDid`
 *   (a did:key), strict RFC 8032;
 * - the CID recomputed from the exact bytes equals `cid` (and `expectedCid`);
 * - `facts.shareKeyDid` equals the issuer.
 */
export async function verifyPolicyEnforcementDelegation(delegation: SignedDelegation, expectedCid?: string): Promise<SignedDelegation> {
  if (delegation === null || typeof delegation !== "object" || typeof delegation.dagCbor !== "string" || typeof delegation.signature !== "string" || typeof delegation.cid !== "string" || typeof delegation.issuerDid !== "string" || typeof delegation.audienceDid !== "string" || delegation.facts === null || typeof delegation.facts !== "object") {
    throw new Error("enforcement delegation is malformed");
  }
  const bytes = fromBase64Url(delegation.dagCbor);
  const unsigned = { type: "TinyCloudSharePolicyEnforcement", version: 2, issuerDid: delegation.issuerDid, audienceDid: delegation.audienceDid, facts: delegation.facts };
  const expected = dagCborEncode({ domain: POLICY_ENFORCEMENT_DOMAIN, unsigned });
  if (expected.length !== bytes.length || expected.some((byte, index) => byte !== bytes[index])) throw new Error("enforcement delegation fields are not the signed bytes");
  const signature = fromBase64Url(delegation.signature);
  const publicKey = ed25519PublicKeyFromDidKey(delegation.issuerDid);
  if (signature.length !== 64 || !ed25519.verify(signature, bytes, publicKey, { zip215: false })) throw new Error("enforcement delegation signature is invalid");
  const cid = await computeCid(bytes);
  if (cid !== delegation.cid || (expectedCid !== undefined && cid !== expectedCid)) throw new Error("enforcement delegation CID does not match its bytes");
  if (delegation.facts.shareKeyDid !== delegation.issuerDid) throw new Error("enforcement delegation is not issued by its share key");
  return delegation;
}
