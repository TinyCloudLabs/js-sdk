import { Delegation, DelegatedResource, PermissionEntry } from "@tinycloud/sdk-core";

/**
 * A portable delegation that can be transported between users.
 * Extends the base Delegation type with fields required for transport.
 *
 * @remarks
 * PortableDelegation adds transport fields to Delegation:
 * - `delegationHeader`: Structured authorization header for API calls
 * - `ownerAddress`: Space owner's address for session creation
 * - `chainId`: Chain ID for session creation
 * - `host`: Optional server URL
 * - `resources`: Multi-resource grant breakdown (present when the
 *   delegation was issued via the multi-resource WASM path, i.e. one
 *   UCAN covering multiple `(service, path, actions)` entries). The
 *   flat `path` + `actions` fields mirror the first entry for
 *   single-resource callers; consumers that need the full picture
 *   read `resources`.
 */
export interface PortableDelegation extends Omit<Delegation, "isRevoked"> {
  /** The authorization header for this delegation (structured format) */
  delegationHeader: { Authorization: string };

  /** The address of the space owner */
  ownerAddress: string;

  /** The chain ID */
  chainId: number;

  /** TinyCloud server URL where this delegation was created */
  host?: string;

  /** Whether the recipient is prevented from creating sub-delegations */
  disableSubDelegation?: boolean;

  /** Companion delegation for the user's public space (auto-created when includePublicSpace is true) */
  publicDelegation?: PortableDelegation;

  /**
   * Full multi-resource grant breakdown. Present when the delegation
   * was issued via the multi-resource WASM path; each entry describes
   * one `(service, space, path, actions)` grant carried by the single
   * underlying UCAN. When absent, only the flat `path` + `actions`
   * fields are authoritative (legacy single-resource shape).
   */
  resources?: DelegatedResource[];
}

/**
 * The transport shape `tc auth request --emit` produces and that an owner
 * grants to its requester. Only the fields the grant logic needs are declared;
 * the CLI artifact carries more (posture, captured command, ...) and remains a
 * structural superset of this interface.
 */
export interface AuthRequestArtifact {
  kind: "tinycloud.auth.request";
  version: 1;
  requestId: string;
  /** The requester's session DID — the audience the grant is issued to. */
  sessionDid: string;
  /** The capabilities the requester is asking the owner to delegate. */
  requested: PermissionEntry[];
  /** Optional lifetime override carried from the request. */
  requestedExpiry?: string | number;
}

/**
 * The transport shape returned by {@link grantAuthRequest} (and written by
 * `tc auth grant`). `tc auth import` accepts this artifact directly.
 */
export interface AuthDelegationArtifact {
  kind: "tinycloud.auth.delegation";
  version: 1;
  requestId: string;
  delegationCid: string;
  delegation: PortableDelegation;
  permissions: PermissionEntry[];
  expiry: string;
  /** Whether issuing the delegation triggered a wallet prompt. */
  prompted: boolean;
}

/**
 * Minimal owner-side capability {@link grantAuthRequest} needs: the signed
 * `delegateTo` primitive. `TinyCloudNode` satisfies this directly; web/SDK
 * contexts can supply any object that exposes the same method.
 */
export interface DelegationAuthority {
  delegateTo(
    did: string,
    permissions: PermissionEntry[],
    options?: { expiry?: string | number; forceWalletSign?: boolean },
  ): Promise<{ delegation: PortableDelegation; prompted: boolean }>;
}

/**
 * Turn a delegation REQUEST into a signed GRANT.
 *
 * Lifts the body of `tc auth grant` into the SDK so the request→grant
 * handshake is callable programmatically (future SDK/web owner tooling and the
 * KV delegation inbox), with the CLI verb reduced to a thin wrapper. The owner
 * `authority` (a `TinyCloudNode`) signs a delegation scoped to exactly the
 * requested caps, audienced to the requester's `sessionDid`, honoring the
 * request's expiry. The returned artifact round-trips through `tc auth import`.
 *
 * Authorization is enforced cryptographically by `delegateTo`: caps that are
 * not derivable from the owner's own session capability chain are rejected
 * (it throws), so this never widens authority the owner doesn't hold.
 */
export async function grantAuthRequest(
  authority: DelegationAuthority,
  request: AuthRequestArtifact,
  options?: { expiry?: string | number },
): Promise<AuthDelegationArtifact> {
  if (request.kind !== "tinycloud.auth.request") {
    throw new Error(
      `grantAuthRequest expects a tinycloud.auth.request artifact, got "${request.kind}".`,
    );
  }
  if (!Array.isArray(request.requested) || request.requested.length === 0) {
    throw new Error("grantAuthRequest request has no requested capabilities.");
  }

  const expiry = options?.expiry ?? request.requestedExpiry;
  const result = await authority.delegateTo(
    request.sessionDid,
    request.requested,
    expiry !== undefined ? { expiry } : undefined,
  );

  return {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: request.requestId,
    delegationCid: result.delegation.cid,
    delegation: result.delegation,
    permissions: request.requested,
    expiry: result.delegation.expiry.toISOString(),
    prompted: result.prompted,
  };
}

/**
 * Serialize a PortableDelegation for transport (e.g., over network).
 */
export function serializeDelegation(delegation: PortableDelegation): string {
  return JSON.stringify({
    ...delegation,
    expiry: delegation.expiry.toISOString(),
  });
}

/**
 * Deserialize a PortableDelegation from transport.
 */
export function deserializeDelegation(data: string): PortableDelegation {
  const parsed = JSON.parse(data);
  return {
    ...parsed,
    cid: parsed.cid,
    expiry: new Date(parsed.expiry),
  };
}
