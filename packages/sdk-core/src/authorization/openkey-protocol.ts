// Versioned TinyCloud <-> OpenKey authorization protocol (v1).
//
// This file is the SDK-core mirror of the protocol OpenKey ships in
// `@openkey/sdk`. It exists in sdk-core so both node-sdk and web-sdk can
// import the same types when they consume an authorization result.
//
// Invariants (mirrored from the OpenKey side):
//   - `signedMessage` is the EXACT bytes the signature verifies against.
//     Consumers MUST NOT recompute the SIWE and complete a session with
//     different bytes. NodeUserAuthorization completes the session with
//     the returned `signedMessage`.
//   - `permissions` is the EFFECTIVE grant set after any narrowing. It is
//     never a superset of what the caller requested; the user is allowed
//     to remove any non-required grant.
//   - `selectedActionKeys` are opaque IDs the API produced. Consumers must
//     not rebuild them from ability strings alone.

export interface TinyCloudAuthorizationRequestV1 {
  protocolVersion: 1;
  /** The suggested SIWE. OpenKey may narrow this before signing. */
  siwe: string;
  /** Which OpenKey keyId to sign with. Optional; user may pick. */
  keyId?: string;
  /** Optional presentation envelope for the review page. */
  presentation?: CapabilityPresentationEnvelopeV1;
}

export interface TinyCloudAuthorizationResultV1 {
  protocolVersion: 1;
  /** EIP-55 encoded signer address. */
  address: string;
  /** Signature over `signedMessage`, hex-encoded (0x…). */
  signature: string;
  /**
   * The EXACT bytes the signature verifies against. When the user narrows
   * capabilities in the review, this is the regenerated SIWE — not the
   * caller's original request.
   */
  signedMessage: string;
  /** Action IDs the user selected (or default consent). Opaque strings. */
  selectedActionKeys: string[];
  /** Effective grant set after narrowing. */
  permissions: Array<TinyCloudEffectiveGrantV1>;
}

export interface TinyCloudEffectiveGrantV1 {
  service: string;
  space: string;
  path: string;
  actions: string[];
}

export interface CapabilityPresentationEnvelopeV1 {
  protocolVersion: 1;
  displayName?: string;
  reason?: string;
  manifestId?: string;
  manifestDigest?: string;
}

/**
 * Runtime validator for a TinyCloudAuthorizationResultV1. Returns null when
 * the payload matches the expected shape; returns an error message string
 * otherwise. Designed for use at the js-sdk trust boundary (browser-auth,
 * NodeUserAuthorization) so a compromised OpenKey response cannot inject
 * unexpected fields into a session.
 */
export function validateAuthorizationResultV1(
  value: unknown,
): { ok: true; value: TinyCloudAuthorizationResultV1 } | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "authorization result must be an object" };
  }
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== 1) {
    return { ok: false, error: `unsupported protocolVersion ${String(v.protocolVersion)}` };
  }
  if (typeof v.address !== "string" || !v.address) {
    return { ok: false, error: "address must be a non-empty string" };
  }
  if (typeof v.signature !== "string" || !v.signature) {
    return { ok: false, error: "signature must be a non-empty string" };
  }
  if (typeof v.signedMessage !== "string" || !v.signedMessage) {
    return { ok: false, error: "signedMessage must be a non-empty string" };
  }
  if (!Array.isArray(v.selectedActionKeys) || v.selectedActionKeys.some((k) => typeof k !== "string")) {
    return { ok: false, error: "selectedActionKeys must be a string[]" };
  }
  if (!Array.isArray(v.permissions)) {
    return { ok: false, error: "permissions must be an array" };
  }
  const permissions: TinyCloudEffectiveGrantV1[] = [];
  for (const [index, entry] of (v.permissions as unknown[]).entries()) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `permissions[${index}] must be an object` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.service !== "string" || typeof e.space !== "string" || typeof e.path !== "string") {
      return { ok: false, error: `permissions[${index}] must have string service/space/path` };
    }
    if (!Array.isArray(e.actions) || e.actions.some((a) => typeof a !== "string")) {
      return { ok: false, error: `permissions[${index}].actions must be a string[]` };
    }
    permissions.push({
      service: e.service,
      space: e.space,
      path: e.path,
      actions: e.actions as string[],
    });
  }
  return {
    ok: true,
    value: {
      protocolVersion: 1,
      address: v.address,
      signature: v.signature,
      signedMessage: v.signedMessage,
      selectedActionKeys: v.selectedActionKeys as string[],
      permissions,
    },
  };
}

/**
 * Selected action ID rules. The OpenKey side builds these with the exact
 * separator convention below (mirror of `packages/capability-review/src/ids`).
 * Consumers should treat them as opaque; only equality comparisons and set
 * membership are guaranteed to be stable.
 */
export const OPENKEY_ACTION_ID_SEPARATOR = "\0";

export function isPlausibleOpenKeyActionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.split(OPENKEY_ACTION_ID_SEPARATOR).length === 4 &&
    id.length > 0
  );
}
