import { canonicalAddressSpelling } from "../agent-record.js";
import { attenuationCovers, type Attenuation } from "./attenuation.js";
import { principalOf } from "./ucan.js";

/**
 * Owner→session SIWE CACAO checks (design C4). Security-sensitive.
 *
 * Signature, canonical DAG-CBOR, exact-bytes CID and the ReCap statement are
 * verified by the injected parser: sdk-core `parseSignedSiweCacao`
 * (`cacao.ts:205-276`; share-sdk cannot depend on sdk-core, which depends on
 * share-sdk). That parser does not check validity times, so this module adds:
 * `Not Before`/`Expiration Time` against `now`, issuer == the account owner,
 * audience == the child's issuer, and child attenuation ⊆ the CACAO's.
 */
export interface ParsedSiweCacao {
  readonly cid: string;
  /** `did:pkh:eip155:<chain>:<address>`. */
  readonly issuer: string;
  /** SIWE `uri`: the delegate DID. */
  readonly audience: string;
  readonly attenuation: Attenuation;
  readonly expiresAt?: string;
  readonly notBefore?: string;
}

/** Verifies signature, encoding and the exact-bytes CID; throws otherwise. */
export type SiweCacaoParser = (authorization: string, expectedCid: string) => Promise<ParsedSiweCacao>;

export type DelegationTime = "current" | "expired";

/** Clock skew tolerated for a `Not Before` slightly in the future. */
export const NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;

export interface OwnerSessionCheck {
  readonly authorization: string;
  readonly expectedCid: string;
  readonly accountOwnerDid: string;
  /** The issuer of the delegation this CACAO must authorize (the leaf or root issuer). */
  readonly childIssuer: string;
  readonly childAttenuation: Attenuation;
  readonly now: Date;
  readonly parse: SiweCacaoParser;
}

export interface VerifiedOwnerSession {
  readonly cid: string;
  /** The session principal (audience without fragment). */
  readonly sessionDid: string;
  readonly time: DelegationTime;
}

function timeOf(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`SIWE ${label} is not a timestamp`);
  return parsed;
}

/** Throws when the CACAO does not prove the owner→session hop; reports expiry separately. */
export async function verifyOwnerSessionDelegation(input: OwnerSessionCheck): Promise<VerifiedOwnerSession> {
  const cacao = await input.parse(input.authorization, input.expectedCid);
  if (cacao.cid !== input.expectedCid) throw new Error("SIWE CID does not match");
  if (canonicalAddressSpelling(cacao.issuer) !== canonicalAddressSpelling(input.accountOwnerDid)) throw new Error("SIWE issuer is not the account owner");
  if (principalOf(cacao.audience) !== principalOf(input.childIssuer)) throw new Error("SIWE audience is not the delegation issuer");
  if (!attenuationCovers(cacao.attenuation, input.childAttenuation)) throw new Error("delegation widens the SIWE attenuation");
  const notBefore = timeOf(cacao.notBefore, "Not Before");
  const expiresAt = timeOf(cacao.expiresAt, "Expiration Time");
  if (notBefore !== undefined && expiresAt !== undefined && notBefore >= expiresAt) throw new Error("SIWE validity window is empty");
  if (notBefore !== undefined && notBefore > input.now.getTime() + NOT_BEFORE_SKEW_MS) throw new Error("SIWE is not yet valid");
  return { cid: cacao.cid, sessionDid: principalOf(cacao.audience), time: expiresAt !== undefined && expiresAt <= input.now.getTime() ? "expired" : "current" };
}
