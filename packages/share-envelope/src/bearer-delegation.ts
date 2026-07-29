/**
 * Bearer-slice delegation: ONE module for both sides so create and verify
 * cannot drift — the CLI mints with `mintBearerDelegation`, the viewer checks
 * with `checkBearerDelegation`, and both share `bearerResourceUri` and
 * `READ_ABILITIES` (this module began life as the stage-3 viewer's
 * delegation.ts and moved here when the stage-4 create flow needed the same
 * conventions from node).
 *
 * --- The check (viewer spec §1 "Mode detection") -------------------------
 *
 * The UI must derive its mode from EFFECTIVE CAPABILITIES, never from the
 * envelope's unsigned hints — and never from the mere fact that the envelope
 * decrypted. `checkBearerDelegation` decodes AND cryptographically verifies
 * the envelope's embedded delegation (a UCAN/JWT-shaped token: three
 * base64url segments, header.payload.signature, capabilities in the
 * payload's `att` array) and fails closed unless ALL of the following hold:
 *
 *   1. the token parses (three non-empty base64url segments; header and
 *      payload are JSON objects; the signature segment decodes),
 *   2. the header's `alg` is EdDSA and the signature VERIFIES (strict
 *      RFC 8032 ed25519) over the JWS signing input against the key the
 *      token's own `iss` did:key names — the token is internally
 *      consistent: `iss` really signed exactly these claims,
 *   3. the token carries a REQUIRED integer `exp` (UCAN epoch-seconds
 *      convention) that has not passed, and — if present — an `nbf` that
 *      has (expiry-less tokens are rejected outright),
 *   4. the delegatee (`aud`) DID EQUALS the did:key derived from the
 *      envelope's embedded bearer sessionJwk — otherwise the key the link
 *      carries cannot use this delegation at all,
 *   5. some capability grants the read ability (`BEARER_READ_ABILITY`,
 *      the SAME single constant the mint emits) on a CANONICAL resource
 *      URI that covers the envelope's signed target
 *      (origin + spaceId + resource.path) exactly or via a `/*` prefix on
 *      a segment boundary — see `resourceUriCovers`.
 *
 * WHAT THE CHECK DOES **NOT** DO — and must never be presented as doing:
 * verification of a delegation CHAIN against an out-of-band trust root
 * (proof/`prf` chains, issuer authority over the resource, revocation).
 * In the bearer slice the delegation is SELF-ISSUED — internal consistency
 * is everything there is to verify. In the policy / recipient-DID slices
 * this becomes full chain verification against the owner/issuer roots, and
 * the NODE repeats it at read time as the real enforcement boundary. This
 * check makes the viewer honest — a link whose delegation is unsigned,
 * expired, or cannot authorize its own embedded key is rejected before any
 * "read access" claim is shown — it does not make the link authorized.
 *
 * --- The mint (bearer slice ONLY) ----------------------------------------
 *
 * In the bearer slice there is no owner node: possession of the link IS the
 * authority, so `mintBearerDelegation` self-issues a minimal, internally
 * consistent token — a fresh ed25519 issuer signs (real EdDSA over the JWS
 * signing input) a delegation whose `aud` is the link's embedded session
 * did:key and whose single capability grants read over the bearer resource
 * URI. It satisfies exactly the structure `checkBearerDelegation` validates.
 * In the policy / recipient-DID slices this mint is REPLACED by a real
 * owner-signed delegation chain that the node verifies at read time; nothing
 * about the check side changes.
 */
import { ed25519 } from "@noble/curves/ed25519";

import { fromBase64Url, toBase64Url, utf8Bytes } from "./bytes.js";
import {
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyFromDidKey,
} from "./didkey.js";
import { getBearerSessionJwk } from "./bearer.js";
import {
  isCanonicalHttpsOrigin,
  isCanonicalResourcePath,
  type ShareEnvelope,
} from "./schema.js";

/** The ONE read ability of the bearer slice — minted AND checked (no drift). */
export const BEARER_READ_ABILITY = "kv/get";

/**
 * Read abilities accepted for the single-file bearer viewer (spec §1 table).
 * Derived from — never listed separately from — the single mint constant, so
 * the set the checker accepts is PROVABLY identical to what the mint emits.
 */
export const READ_ABILITIES: ReadonlySet<string> = new Set([BEARER_READ_ABILITY]);

/**
 * Strict ed25519 verification (RFC 8032, not ZIP-215) — same interop
 * rationale as sign.ts: agree byte-for-byte with a strict Rust verifier.
 */
const ED25519_VERIFY_OPTS = { zip215: false } as const;

export type DelegationCheckResult =
  | { ok: true; delegateeDid: string }
  | { ok: false; detail: string };

interface UcanCapability {
  readonly with: string;
  readonly can: string;
}

/** Strict base64url segment → JSON value, or null on ANY failure. */
function decodeJsonSegment(segment: string): unknown {
  try {
    const bytes = fromBase64Url(segment);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCapability(value: unknown): UcanCapability | null {
  if (!isJsonObject(value)) return null;
  const withUri = value["with"];
  const can = value["can"];
  if (typeof withUri !== "string" || withUri.length === 0) return null;
  if (typeof can !== "string" || can.length === 0) return null;
  return { with: withUri, can };
}

/**
 * Parse a resource URI into a canonical https origin plus CANONICAL path
 * segments (schema.ts grammar: no `.`/`..` segments, no `//`, no backslash,
 * no percent-encoded separator aliases, no control chars). Returns null —
 * fail closed — for anything else, so a URI carrying a traversal alias can
 * never even reach the comparison below.
 */
function parseCanonicalResourceUri(
  uri: string,
): { origin: string; segments: readonly string[] } | null {
  const match = /^(https:\/\/[^/\\]+)\/(.*)$/.exec(uri);
  if (match === null) return null;
  const [, origin, path] = match as unknown as [string, string, string];
  if (!isCanonicalHttpsOrigin(origin)) return null;
  if (!isCanonicalResourcePath(path)) return null;
  return { origin, segments: path.split("/") };
}

/**
 * Does a granted resource URI cover the target resource URI? BOTH sides must
 * parse under the canonical grammar (anything non-canonical — `..` segments,
 * `//`, encoded separators — is rejected outright, never normalized-and-
 * accepted). Coverage is exact segment-wise equality, or a `<prefix>/*`
 * grant whose segments are a strict prefix of the target's segments — i.e.
 * only on canonical segment boundaries: `foo/*` covers `foo/bar`, never
 * `foobar` and never `foo/../bar`. Nothing looser (no mid-segment globs,
 * no scheme-relative tricks) — fail closed.
 */
export function resourceUriCovers(granted: string, target: string): boolean {
  const targetParsed = parseCanonicalResourceUri(target);
  if (targetParsed === null) return false;
  const wildcard = granted.endsWith("/*");
  const grantedParsed = parseCanonicalResourceUri(
    wildcard ? granted.slice(0, -2) : granted,
  );
  if (grantedParsed === null) return false;
  if (grantedParsed.origin !== targetParsed.origin) return false;
  const grantedSegments = grantedParsed.segments;
  const targetSegments = targetParsed.segments;
  const prefixMatches = grantedSegments.every(
    (segment, index) => segment === targetSegments[index],
  );
  if (!prefixMatches) return false;
  return wildcard
    ? targetSegments.length > grantedSegments.length
    : targetSegments.length === grantedSegments.length;
}

/**
 * The canonical bearer-slice resource URI: `<origin>/<spaceId>/<path>`.
 * THE single convention shared by mint (CLI) and check (viewer) — it must be
 * aligned with the node's authoritative resource grammar before real
 * node-gated reads ship in the policy/recipient-DID slices.
 */
export function bearerResourceUri(
  origin: string,
  spaceId: string,
  path: string,
): string {
  return `${origin}/${spaceId}/${path}`;
}

/** The resource URI a delegation must cover for this envelope's signed target. */
export function requiredResourceUri(envelope: ShareEnvelope): string {
  const { origin, spaceId, resource } = envelope.target;
  return bearerResourceUri(origin, spaceId, resource.path);
}

export interface CheckBearerDelegationOptions {
  /** Clock override (epoch MILLISECONDS) for exp/nbf; defaults to Date.now(). */
  now?: () => number;
}

/**
 * Bearer-binding check described in the module header: structural decode +
 * cryptographic verification of the token's own EdDSA signature, expiry, and
 * not-before. Returns a failure `detail` suitable for logging/diagnostics —
 * NOT for claiming more than internal consistency (see module header for
 * what chain verification is deferred to the node in later slices).
 */
export function checkBearerDelegation(
  envelope: ShareEnvelope,
  options: CheckBearerDelegationOptions = {},
): DelegationCheckResult {
  // 1. Derive the did:key the embedded bearer key actually is. Only Ed25519
  //    OKP session keys are supported in this slice (the did:key helper is
  //    ed25519-only); anything else fails closed rather than guessing.
  let sessionDid: string;
  try {
    const jwk = getBearerSessionJwk(envelope);
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      return {
        ok: false,
        detail: `unsupported bearer session key family ${jwk.kty}/${jwk.crv}; this build binds Ed25519 keys only`,
      };
    }
    sessionDid = didKeyFromEd25519PublicKey(fromBase64Url(jwk.x));
  } catch (error) {
    return {
      ok: false,
      detail: `could not derive did:key from embedded session key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // 2. Structural token decode: header.payload.signature.
  const segments = envelope.delegation.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    return { ok: false, detail: "delegation is not a three-segment JWT-shaped token" };
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [
    string,
    string,
    string,
  ];
  const header = decodeJsonSegment(headerSegment);
  if (!isJsonObject(header)) {
    return { ok: false, detail: "delegation header is not a base64url JSON object" };
  }
  const payload = decodeJsonSegment(payloadSegment);
  if (!isJsonObject(payload)) {
    return { ok: false, detail: "delegation payload is not a base64url JSON object" };
  }
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signatureSegment);
    if (signatureBytes.length === 0) {
      return { ok: false, detail: "delegation signature segment is empty" };
    }
  } catch {
    return { ok: false, detail: "delegation signature segment is not base64url" };
  }

  // 3. Cryptographic verification: the token must be EdDSA-signed by the key
  //    its own `iss` did:key names (the mint signs for real — an unsigned or
  //    tampered token is rejected, never waved through on shape alone).
  if (header["alg"] !== "EdDSA") {
    return {
      ok: false,
      detail: `delegation alg must be EdDSA, got ${JSON.stringify(header["alg"])}`,
    };
  }
  const issuer = payload["iss"];
  if (typeof issuer !== "string" || issuer.length === 0) {
    return { ok: false, detail: "delegation payload has no issuer (iss) DID" };
  }
  let issuerPublicKey: Uint8Array;
  try {
    issuerPublicKey = ed25519PublicKeyFromDidKey(issuer);
  } catch (error) {
    return {
      ok: false,
      detail: `delegation issuer is not an ed25519 did:key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  let signatureValid: boolean;
  try {
    signatureValid = ed25519.verify(
      signatureBytes,
      utf8Bytes(`${headerSegment}.${payloadSegment}`),
      issuerPublicKey,
      ED25519_VERIFY_OPTS,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, detail: "delegation signature does not verify against iss" };
  }

  // 4. Time bounds, fail closed: `exp` is REQUIRED (UCAN epoch seconds — an
  //    expiry-less delegation is rejected outright) and `nbf` is enforced
  //    when present.
  const nowMs = options.now?.() ?? Date.now();
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) {
    return { ok: false, detail: "delegation has no valid expiry (exp) claim" };
  }
  if (nowMs >= exp * 1000) {
    return { ok: false, detail: "delegation is expired" };
  }
  const nbf = payload["nbf"];
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isSafeInteger(nbf)) {
      return { ok: false, detail: "delegation nbf claim is not a valid time" };
    }
    if (nowMs < nbf * 1000) {
      return { ok: false, detail: "delegation is not yet valid (nbf)" };
    }
  }

  // 5. Delegatee binding: aud must BE the embedded key's did:key.
  const audience = payload["aud"];
  if (typeof audience !== "string" || audience.length === 0) {
    return { ok: false, detail: "delegation payload has no audience (aud) DID" };
  }
  if (audience !== sessionDid) {
    return {
      ok: false,
      detail: "delegation audience is not the link's embedded session key",
    };
  }

  // 6. Capability coverage: some `att` entry must grant read on a CANONICAL
  //    resource URI covering the envelope's signed target.
  const att = payload["att"];
  if (!Array.isArray(att) || att.length === 0) {
    return { ok: false, detail: "delegation payload has no capabilities (att)" };
  }
  const required = requiredResourceUri(envelope);
  const granted = att
    .map(parseCapability)
    .some(
      (capability) =>
        capability !== null &&
        READ_ABILITIES.has(capability.can) &&
        resourceUriCovers(capability.with, required),
    );
  if (!granted) {
    return {
      ok: false,
      detail: `delegation grants no read capability covering ${required}`,
    };
  }

  return { ok: true, delegateeDid: audience };
}

export interface MintBearerDelegationOptions {
  /** ed25519 private key (32-byte seed) of the self-issued bearer issuer. */
  issuerPrivateKey: Uint8Array;
  /** The link's embedded session did:key — the delegatee (`aud`). */
  audienceDid: string;
  /** Resource the capability covers — build it with `bearerResourceUri`. */
  resourceUri: string;
  /** Delegation expiry, epoch SECONDS (UCAN `exp` convention). */
  expiresAtSeconds: number;
}

/**
 * Mint the bearer slice's self-issued delegation token (see module header:
 * a stand-in for a real owner-signed chain, replaced in later slices).
 * JWT-shaped: base64url(header) "." base64url(payload) "." base64url(sig),
 * signed EdDSA (ed25519) over the UTF-8 signing input `header.payload` by
 * the issuer key, so the token is internally consistent — `iss` really did
 * sign it — even though no node verifies the chain in this slice.
 */
export function mintBearerDelegation(options: MintBearerDelegationOptions): string {
  const { issuerPrivateKey, audienceDid, resourceUri, expiresAtSeconds } = options;
  if (!audienceDid.startsWith("did:")) {
    throw new TypeError(`audienceDid must be a DID, got ${audienceDid}`);
  }
  if (resourceUri.length === 0) {
    throw new TypeError("resourceUri must be non-empty");
  }
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw new TypeError(
      `expiresAtSeconds must be a positive integer (epoch seconds), got ${expiresAtSeconds}`,
    );
  }
  const issuerDid = didKeyFromEd25519PublicKey(
    ed25519.getPublicKey(issuerPrivateKey),
  );
  const header = { alg: "EdDSA", typ: "JWT", ucv: "0.9.1" };
  const payload = {
    iss: issuerDid,
    aud: audienceDid,
    att: [{ with: resourceUri, can: BEARER_READ_ABILITY }],
    prf: [],
    exp: expiresAtSeconds,
  };
  const signingInput = `${toBase64Url(utf8Bytes(JSON.stringify(header)))}.${toBase64Url(
    utf8Bytes(JSON.stringify(payload)),
  )}`;
  const signature = ed25519.sign(utf8Bytes(signingInput), issuerPrivateKey);
  return `${signingInput}.${toBase64Url(signature)}`;
}
