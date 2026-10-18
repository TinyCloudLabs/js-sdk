/**
 * Three-state registry verdict for an owner DID (TC-1443, TC-1444).
 *
 * A registry lookup has exactly three outcomes, and callers must never
 * collapse them:
 *
 * - `registered`: a verified owner record exists. `hosts: []` is a valid
 *   registered record with no hosts (a tombstone), not "no record".
 * - `unregistered`: the registry authoritatively said there is no record and
 *   nothing remembered says otherwise. Only this state may route an owner to a
 *   new-user default.
 * - `unavailable`: anything else. Network errors, timeouts, non-200/404
 *   statuses, unrecognised or oversize bodies, subject mismatches, bad
 *   signatures, and records older than the remembered sequence all fail
 *   closed here.
 *
 * {@link classifyRegistryLookup} is a pure classifier over one registry
 * response. It performs no I/O and is not used by host resolution yet.
 */

import {
  multiaddrToHttpUrl,
  validateLocationRecord,
  verifyLocationRecord,
  type LocationRecord,
} from "./location";

export type RegistryVerdictStatus = "registered" | "unregistered" | "unavailable";

/** Which registry source produced a verdict. */
export type RegistryVerdictSource = "chain" | "chain-cache" | "offchain";

/** Which source listed a host. `hint` is an address hint not yet confirmed by a node record. */
export type RegistryHostSource = RegistryVerdictSource | "hint";

export interface RegistryHost {
  /** Node DID that must answer `/info` at these URLs, when the record names one. */
  readonly nodeDid?: string;
  readonly urls: readonly string[];
  readonly source: RegistryHostSource;
  /** Expiry of the node record the URLs came from, when it has one. */
  readonly expiresAt?: string;
}

export type RegistryUnavailableReason =
  /** The registry could not be reached (refused, DNS, TLS, redirect refused). */
  | "network-error"
  /** The lookup exceeded its time budget. */
  | "timeout"
  /** The registry answered with a status other than 200 or 404. */
  | "http-status"
  /** The body is not the registry's record or not-found response. */
  | "malformed-response"
  /** The body exceeds {@link REGISTRY_LOOKUP_MAX_BODY_BYTES}. */
  | "oversize-response"
  /** A record was returned for a different subject. */
  | "subject-mismatch"
  /** The record signature does not verify for its subject. */
  | "invalid-signature"
  /** The record's sequence is below the remembered sequence. */
  | "rollback"
  /** The registry said "not found" for a subject remembered as registered. */
  | "not-found-after-registered";

export interface RegisteredRegistryVerdict {
  readonly status: "registered";
  readonly subject: string;
  readonly source: RegistryVerdictSource;
  /** Sequence of the accepted record. Callers persist the maximum they have seen. */
  readonly sequence: number;
  /** Listed hosts in record order. Empty for a registered record with no hosts. */
  readonly hosts: readonly RegistryHost[];
}

export interface UnregisteredRegistryVerdict {
  readonly status: "unregistered";
  readonly subject: string;
  readonly source: RegistryVerdictSource;
  readonly hosts: readonly [];
}

export interface UnavailableRegistryVerdict {
  readonly status: "unavailable";
  readonly subject: string;
  readonly source: RegistryVerdictSource;
  readonly reason: RegistryUnavailableReason;
  /** Human-readable detail for logs and errors. Not part of the contract. */
  readonly message: string;
  readonly hosts: readonly [];
}

export type RegistryVerdict =
  | RegisteredRegistryVerdict
  | UnregisteredRegistryVerdict
  | UnavailableRegistryVerdict;

/** One observed registry lookup: an HTTP response, or the reason none arrived. */
export type RegistryLookupResponse =
  | { readonly kind: "http"; readonly status: number; readonly body: string }
  | { readonly kind: "network-error" }
  | { readonly kind: "timeout" };

export interface ClassifyRegistryLookupOptions {
  /**
   * Highest record sequence previously accepted for this subject. Its
   * presence means the subject is known to be registered: a later not-found
   * or an older record is `unavailable`, never `unregistered`.
   */
  rememberedSequence?: number | null;
}

/** Largest registry response body accepted, in UTF-8 bytes. */
export const REGISTRY_LOOKUP_MAX_BODY_BYTES = 64 * 1024;

/** The `error` string of the location registry's 404 for a subject with no record. */
export const REGISTRY_NOT_FOUND_ERROR = "location record not found";

/**
 * Classify one off-chain location registry response for `subject`.
 *
 * Checks run in this order, and the first failure decides the reason:
 * transport (`network-error`, `timeout`); status other than 200 or 404
 * (`http-status`); body size (`oversize-response`); then for 404 the exact
 * body `{"error":"location record not found"}` (`malformed-response`) and the
 * remembered sequence (`not-found-after-registered`); for 200 a JSON object
 * with a valid v1 `record` (`malformed-response`), the exact subject
 * (`subject-mismatch`), the signature (`invalid-signature`) and the
 * remembered sequence (`rollback`).
 *
 * A 404 is unauthenticated: its body shape is the only evidence that the
 * registry itself answered. A record equal to the remembered sequence is
 * accepted. Record multiaddrs that do not map to an HTTP(S) URL are omitted
 * from `hosts`; transport policy (HTTPS-only, node identity) belongs to host
 * selection, not to this verdict.
 *
 * @throws TypeError if `subject` is not a did:pkh/did:key string or
 * `rememberedSequence` is not a non-negative safe integer.
 */
export async function classifyRegistryLookup(
  subject: string,
  response: RegistryLookupResponse,
  options: ClassifyRegistryLookupOptions = {},
): Promise<RegistryVerdict> {
  if (
    typeof subject !== "string" ||
    !(subject.startsWith("did:pkh:") || subject.startsWith("did:key:"))
  ) {
    throw new TypeError("subject must be a did:pkh or did:key string");
  }
  const remembered = options.rememberedSequence ?? null;
  if (
    remembered !== null &&
    (!Number.isSafeInteger(remembered) || remembered < 0)
  ) {
    throw new TypeError("rememberedSequence must be a non-negative safe integer");
  }

  const unavailable = (
    reason: RegistryUnavailableReason,
    message: string,
  ): UnavailableRegistryVerdict => ({
    status: "unavailable",
    subject,
    source: "offchain",
    reason,
    message,
    hosts: [],
  });

  if (response.kind === "network-error") {
    return unavailable("network-error", "location registry could not be reached");
  }
  if (response.kind === "timeout") {
    return unavailable("timeout", "location registry lookup timed out");
  }
  if (response.status !== 200 && response.status !== 404) {
    return unavailable("http-status", `location registry returned HTTP ${response.status}`);
  }
  if (new TextEncoder().encode(response.body).byteLength > REGISTRY_LOOKUP_MAX_BODY_BYTES) {
    return unavailable("oversize-response", "location registry response is too large");
  }

  if (response.status === 404) {
    if (!isRegistryNotFoundBody(response.body)) {
      return unavailable(
        "malformed-response",
        "location registry 404 is not the registry's not-found response",
      );
    }
    if (remembered !== null) {
      return unavailable(
        "not-found-after-registered",
        `location registry has no record, but sequence ${remembered} was seen before`,
      );
    }
    return { status: "unregistered", subject, source: "offchain", hosts: [] };
  }

  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return unavailable("malformed-response", "location registry response is not JSON");
  }
  if (!isJsonObject(body) || !("record" in body)) {
    return unavailable("malformed-response", "location registry response missing record");
  }
  let record: LocationRecord;
  try {
    record = validateLocationRecord(body.record);
  } catch (error) {
    return unavailable(
      "malformed-response",
      error instanceof Error ? error.message : "location record is invalid",
    );
  }
  if (record.subject !== subject) {
    return unavailable(
      "subject-mismatch",
      "location record subject does not match requested subject",
    );
  }
  let verified = false;
  try {
    verified = await verifyLocationRecord(record);
  } catch {
    // Signature encoding errors (non-hex, wrong length, bad did:key) are
    // signature failures, not a different verdict.
  }
  if (!verified) {
    return unavailable("invalid-signature", "location record signature is invalid");
  }
  if (remembered !== null && record.sequence < remembered) {
    return unavailable(
      "rollback",
      `location record sequence ${record.sequence} is below remembered sequence ${remembered}`,
    );
  }

  const hosts: RegistryHost[] = [];
  for (const address of record.multiaddrs) {
    let url: string;
    try {
      url = multiaddrToHttpUrl(address);
    } catch {
      // Non-HTTP transports are valid record entries but not HTTP hosts.
      continue;
    }
    hosts.push({ urls: [url], source: "offchain" });
  }
  return {
    status: "registered",
    subject,
    source: "offchain",
    sequence: record.sequence,
    hosts,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRegistryNotFoundBody(text: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    isJsonObject(body) &&
    Object.keys(body).length === 1 &&
    body.error === REGISTRY_NOT_FOUND_ERROR
  );
}
