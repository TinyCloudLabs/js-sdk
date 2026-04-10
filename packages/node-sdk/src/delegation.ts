import { Delegation, DelegatedResource } from "@tinycloud/sdk-core";

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
