/**
 * Network-descriptor discovery.
 *
 * Resolution order (per architecture):
 *
 * 1. The node's authoritative endpoint
 *    `GET /encryption/networks/<networkId>` returns the current
 *    descriptor (`state`, `publicEncryptionKey`, `keyVersion`, ...).
 * 2. If the node is unreachable, fall back to the cached discovery
 *    record at `.well-known/encryption/network/<name>` inside the
 *    principal's public space.
 *
 * The node DB is authoritative on conflict; cached records are
 * advisory only.
 */

import {
  NetworkIdError,
  networkDiscoveryKey,
  parseNetworkId,
} from "./networkId";
import {
  encryptionError,
  type EncryptionError,
  type NetworkDescriptor,
} from "./types";

export type DiscoverySource = "node" | "well-known";

export interface DiscoveredNetwork {
  descriptor: NetworkDescriptor;
  source: DiscoverySource;
}

export interface NodeDescriptorFetcher {
  /** Fetch the descriptor by full networkId URN. */
  fetchByNetworkId(networkId: string): Promise<NetworkDescriptor | null>;
}

export interface WellKnownDescriptorFetcher {
  /**
   * Read the cached well-known descriptor by principal + network name.
   * Returns null if no record exists or the record is unreadable.
   */
  fetchWellKnown(
    principal: string,
    discoveryKey: string,
  ): Promise<NetworkDescriptor | null>;
}

export interface DiscoverNetworkInput {
  /** Either a networkId URN or a bare network name (paired with `principal`). */
  identifier: string;
  /** Required when identifier is a bare name. */
  principal?: string;
  node?: NodeDescriptorFetcher;
  wellKnown?: WellKnownDescriptorFetcher;
}

/**
 * Resolve a network descriptor. The node fetcher is preferred; the
 * well-known fallback is used only on transport failure.
 *
 * The returned descriptor is sanity-checked: `networkId`, `principal`,
 * and `name` must agree with the URN, and the public key field must
 * be non-empty.
 */
export async function discoverNetwork(
  input: DiscoverNetworkInput,
):
  | Promise<{ ok: true; data: DiscoveredNetwork } | { ok: false; error: EncryptionError }> {
  let networkId: string;
  let principal: string;
  let name: string;
  try {
    if (input.identifier.startsWith("urn:tinycloud:encryption:")) {
      const parsed = parseNetworkId(input.identifier);
      networkId = parsed.networkId;
      principal = parsed.principal;
      name = parsed.name;
    } else {
      if (input.principal === undefined) {
        return {
          ok: false,
          error: encryptionError({
            code: "INVALID_INPUT",
            message:
              "discoverNetwork requires `principal` when identifier is a bare network name",
          }),
        };
      }
      networkId = `urn:tinycloud:encryption:${input.principal}:${input.identifier}`;
      const parsed = parseNetworkId(networkId);
      principal = parsed.principal;
      name = parsed.name;
    }
  } catch (err) {
    if (err instanceof NetworkIdError) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_NETWORK_ID",
          message: err.message,
        }),
      };
    }
    throw err;
  }

  // 1) Try the node first.
  if (input.node !== undefined) {
    try {
      const descriptor = await input.node.fetchByNetworkId(networkId);
      if (descriptor !== null) {
        const validated = validateDescriptor(descriptor, networkId, principal, name);
        if (!validated.ok) return validated;
        return { ok: true, data: { descriptor: validated.data, source: "node" } };
      }
    } catch (err) {
      // Fall through to well-known
    }
  }

  // 2) Fallback to well-known cache.
  if (input.wellKnown !== undefined) {
    try {
      const descriptor = await input.wellKnown.fetchWellKnown(
        principal,
        networkDiscoveryKey(name),
      );
      if (descriptor !== null) {
        const validated = validateDescriptor(descriptor, networkId, principal, name);
        if (!validated.ok) return validated;
        return {
          ok: true,
          data: { descriptor: validated.data, source: "well-known" },
        };
      }
    } catch (err) {
      // Fall through to NOT_FOUND
    }
  }

  return {
    ok: false,
    error: encryptionError({
      code: "NETWORK_NOT_FOUND",
      networkId,
      name,
    }),
  };
}

function validateDescriptor(
  descriptor: NetworkDescriptor,
  networkId: string,
  principal: string,
  name: string,
):
  | { ok: true; data: NetworkDescriptor }
  | { ok: false; error: EncryptionError } {
  if (descriptor.networkId !== networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: `descriptor networkId ${JSON.stringify(descriptor.networkId)} does not match expected ${JSON.stringify(networkId)}`,
      }),
    };
  }
  if (descriptor.principal !== principal) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: "descriptor principal does not match networkId principal",
      }),
    };
  }
  if (descriptor.name !== name) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: "descriptor name does not match networkId name",
      }),
    };
  }
  if (
    typeof descriptor.publicEncryptionKey !== "string" ||
    descriptor.publicEncryptionKey.length === 0
  ) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: "descriptor publicEncryptionKey must be a non-empty string",
      }),
    };
  }
  return { ok: true, data: descriptor };
}

/**
 * Reject a descriptor that is not in a state that accepts decrypt
 * requests. Only `active` and `rotating` networks may decrypt; revoked
 * or pending networks reject.
 */
export function ensureNetworkUsableForDecrypt(
  descriptor: NetworkDescriptor,
):
  | { ok: true; data: NetworkDescriptor }
  | { ok: false; error: EncryptionError } {
  if (descriptor.state === "active" || descriptor.state === "rotating") {
    return { ok: true, data: descriptor };
  }
  return {
    ok: false,
    error: encryptionError({
      code: "NETWORK_NOT_ACTIVE",
      state: descriptor.state,
    }),
  };
}
