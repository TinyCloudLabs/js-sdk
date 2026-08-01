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

/**
 * Immutable SIWE header fields the OpenKey widget is NOT allowed to alter.
 * The user may narrow capabilities (which changes the ReCap `urn:recap:`
 * resource AND — because the WASM statement is a human-readable rendering of
 * the ReCap — the statement text along with it). But domain/address/URI/
 * version/chainId/nonce/issuedAt bind the message to a specific relying party
 * plus a specific session-key request and MUST come back identical byte-for-byte.
 *
 * `statement` is intentionally NOT part of the immutable set: it derives from
 * the ReCap and MUST be allowed to change when the ReCap changes. The
 * capability-subset check (via `unauthorizedRecapCapabilities`) is the
 * authoritative gate for what the widget was allowed to change.
 */
export interface ImmutableSiweFields {
  domain?: string;
  address?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
}

/**
 * Extract the header fields that must be preserved byte-for-byte between the
 * caller's original prepared SIWE and the bytes OpenKey actually signed. Uses
 * line-based parsing tolerant of the specific format the WASM emitter uses:
 *
 *   <domain> wants you to sign in with your Ethereum account:
 *   <address>
 *
 *   <statement>
 *
 *   URI: <uri>
 *   Version: <n>
 *   Chain ID: <n>
 *   Nonce: <hex>
 *   Issued At: <iso8601>
 *   Resources:
 *   - <resource1>
 *   ...
 *
 * Returns fields it was able to identify; downstream comparison is field-by-field
 * so a missing field on both sides is treated as equal.
 */
export function extractImmutableSiweFields(siwe: string): ImmutableSiweFields {
  const lines = siwe.split(/\r?\n/);
  const result: ImmutableSiweFields = {};

  const headerLine = lines[0];
  if (headerLine) {
    const domainMatch = headerLine.match(/^(.+?)\s+wants you to sign in/);
    if (domainMatch) {
      result.domain = domainMatch[1];
    }
  }

  // Address is the second non-empty line following the header. Simplest to
  // pattern-match on an EIP-55 address rather than track line offsets.
  for (let i = 1; i < lines.length && i < 5; i++) {
    const line = lines[i]?.trim() ?? "";
    if (/^0x[0-9a-fA-F]{40}$/.test(line)) {
      result.address = line;
      break;
    }
  }

  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Za-z ]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case "URI":
        result.uri = value;
        break;
      case "Version":
        result.version = value;
        break;
      case "Chain ID":
        result.chainId = value;
        break;
      case "Nonce":
        result.nonce = value;
        break;
      case "Issued At":
        result.issuedAt = value;
        break;
      default:
        break;
    }
  }

  return result;
}

/**
 * Diff two SIWE header field sets. Returns the field names that differ. An
 * empty array means the caller's prepared header and the signed header agree
 * on every immutable field.
 */
export function diffImmutableSiweFields(
  original: ImmutableSiweFields,
  signed: ImmutableSiweFields,
): string[] {
  const keys: (keyof ImmutableSiweFields)[] = [
    "domain",
    "address",
    "uri",
    "version",
    "chainId",
    "nonce",
    "issuedAt",
  ];
  const diffs: string[] = [];
  for (const key of keys) {
    if (original[key] !== signed[key]) {
      diffs.push(key);
    }
  }
  return diffs;
}

/**
 * Parsed ReCap attenuation payload. Keyed by resource URI ("space/service/path"),
 * each value is a map of action -> list of caveat objects. Consumers care about
 * subset comparisons on (resource, action) pairs; caveats are compared shallowly
 * (any narrowing of caveats is treated as still a subset when the parent grants
 * the same action).
 */
export interface RecapAttenuation {
  [resource: string]: {
    [action: string]: unknown[];
  };
}

/**
 * Extract the union of `att` maps from every `urn:recap:` resource in a SIWE
 * message. Returns an empty object if the SIWE contains no ReCap resources
 * (which is legal — a plain SIWE grants nothing beyond the message itself).
 *
 * Throws if a `urn:recap:` payload is present but cannot be decoded as
 * base64url JSON with an `att` object. Silent tolerance would let a compromised
 * OpenKey response bypass the subset check by returning garbage.
 */
export function extractRecapAttenuations(siwe: string): RecapAttenuation {
  const merged: RecapAttenuation = {};
  const lines = siwe.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/urn:recap:([A-Za-z0-9_-]+=*)/);
    if (!match) continue;
    const encoded = match[1];
    let decodedJson: string;
    try {
      // base64url decode, tolerating with or without padding
      const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      decodedJson = Buffer.from(padded, "base64").toString("utf8");
    } catch (err) {
      throw new Error(
        `Failed to decode urn:recap: payload: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodedJson);
    } catch (err) {
      throw new Error(
        `urn:recap: payload is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("urn:recap: payload must be an object");
    }
    const att = (parsed as Record<string, unknown>).att;
    if (att === undefined) {
      continue; // ReCap without an `att` block grants nothing.
    }
    if (typeof att !== "object" || att === null || Array.isArray(att)) {
      throw new Error("urn:recap: att must be an object");
    }
    for (const [resource, actionMap] of Object.entries(att as Record<string, unknown>)) {
      if (!actionMap || typeof actionMap !== "object" || Array.isArray(actionMap)) {
        throw new Error(`urn:recap: att[${resource}] must be an object`);
      }
      const existing = merged[resource] ?? {};
      for (const [action, caveats] of Object.entries(actionMap as Record<string, unknown>)) {
        if (!Array.isArray(caveats)) {
          throw new Error(
            `urn:recap: att[${resource}][${action}] must be an array`,
          );
        }
        const previous = existing[action] ?? [];
        existing[action] = previous.concat(caveats);
      }
      merged[resource] = existing;
    }
  }
  return merged;
}

/**
 * Deterministic JSON stringify with sorted object keys. Used for structural
 * deep-equality comparison of caveat objects — two caveats that differ only
 * in key insertion order must compare equal.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Deep-equality check for two caveat objects. Because caveats can be arbitrary
 * JSON, we compare by canonical JSON serialization with sorted keys — this is
 * the conservative safe path: caveats that are structurally identical hash to
 * the same string, and any lexical drift (added field, changed value, dropped
 * field) yields a different string.
 */
function caveatsDeepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Prove that `child` grants are a subset of `parent` grants. Returns a list of
 * unauthorized (resource, action) pairs — empty means every capability in
 * `child` was authorized by `parent`.
 *
 * "Subset" here means:
 *   1. Every (resource, action) pair the child grants must appear in the parent.
 *   2. Every caveat object in the child's caveat list for a given (resource,
 *      action) must be present (by deep-equality with sorted-key canonicalization)
 *      in the parent's caveat list for the same pair. That is: child caveats ⊆
 *      parent caveats as sets of caveat objects.
 *
 * ReCap caveat semantics: a caveat list is a DISJUNCTION of alternatives — the
 * caller may exercise the ability under ANY listed caveat. Broadening a list
 * (adding a new alternative not in parent) is a violation. Removing an
 * alternative is fine (narrowing). Replacing a restrictive alternative with a
 * less-restrictive one is a violation (the replacement is a different object).
 *
 * The conservative safe rule: reject if child has ANY caveat not present in the
 * parent's caveat set. This catches:
 *   - Removed caveats (parent had 1+, child has 0): the empty list is "no
 *     restriction" which is broader than any restriction — reject.
 *   - Broadened caveats (parent had caveat X, child has caveat Y not equal to
 *     X): Y is a new alternative — reject.
 *   - Incompatible duplicate caveats (child adds a new caveat alongside a
 *     parent one): the new caveat is unauthorized — reject.
 *
 * Special case: when both parent and child have empty caveat lists, that means
 * neither imposes restrictions, and the child is a subset.
 */
export function unauthorizedRecapCapabilities(
  child: RecapAttenuation,
  parent: RecapAttenuation,
): Array<{ resource: string; action: string }> {
  const unauthorized: Array<{ resource: string; action: string }> = [];
  for (const [resource, actions] of Object.entries(child)) {
    const parentActions = parent[resource];
    for (const [action, childCaveatsRaw] of Object.entries(actions)) {
      if (!parentActions || parentActions[action] === undefined) {
        unauthorized.push({ resource, action });
        continue;
      }
      const parentCaveatsRaw = parentActions[action];
      const parentCaveats: unknown[] = Array.isArray(parentCaveatsRaw)
        ? parentCaveatsRaw
        : [];
      const childCaveats: unknown[] = Array.isArray(childCaveatsRaw)
        ? (childCaveatsRaw as unknown[])
        : [];

      // If parent imposes no restrictions (empty caveat list), the child is
      // free to impose whatever restrictions it likes — even none.
      if (parentCaveats.length === 0) {
        continue;
      }

      // Parent imposes restrictions. Child MUST also impose at least a subset
      // of those same restrictions. Dropping to an empty list would broaden
      // authority — reject.
      if (childCaveats.length === 0) {
        unauthorized.push({ resource, action });
        continue;
      }

      // Every child caveat object must exist in parent's caveat list by
      // structural deep-equality. Any child caveat not present in the parent
      // set is a broadening — reject.
      const parentCanonSet = new Set(parentCaveats.map((c) => stableStringify(c)));
      let allChildCaveatsAuthorized = true;
      for (const childCaveat of childCaveats) {
        if (!parentCanonSet.has(stableStringify(childCaveat))) {
          allChildCaveatsAuthorized = false;
          break;
        }
      }
      if (!allChildCaveatsAuthorized) {
        unauthorized.push({ resource, action });
      }
      // Explicitly silence the deep-equality helper "unused" warning while
      // keeping it exported for testability in the future.
      void caveatsDeepEqual;
    }
  }
  return unauthorized;
}
