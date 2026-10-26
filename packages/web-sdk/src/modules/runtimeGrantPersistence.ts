/*
 * Runtime grants requested from the panel, kept across a page reload. They are stored beside the session record
 * (`BrowserSessionStorage.saveRuntimeGrants`), with the same lifecycle: a new sign-in, a sign-out and the session's
 * expiry remove them. A restore registers each one with the node again; no signer is involved.
 */
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

export interface RuntimeGrantStore {
  loadRuntimeGrants(address: string): Promise<PortableDelegation[]>;
  saveRuntimeGrants(address: string, grants: readonly PortableDelegation[]): Promise<void>;
}

/** Stores `grants` for `address`, replacing a stored grant with the same cid. */
export async function rememberRuntimeGrants(
  store: RuntimeGrantStore,
  address: string,
  grants: readonly PortableDelegation[],
): Promise<void> {
  const known = await store.loadRuntimeGrants(address);
  const added = new Set(grants.map((grant) => grant.cid));
  await store.saveRuntimeGrants(address, [...known.filter((grant) => !added.has(grant.cid)), ...grants]);
}

/**
 * Registers each stored grant through `use` (the node's `useRuntimeDelegation`). `use` rejects a grant that is expired
 * or was not issued to the session key; that grant is removed from storage, the others stay.
 */
export async function reuseRuntimeGrants(
  store: RuntimeGrantStore,
  address: string,
  use: (grant: PortableDelegation) => Promise<void>,
): Promise<void> {
  const grants = await store.loadRuntimeGrants(address);
  const kept: PortableDelegation[] = [];
  for (const grant of grants) {
    try {
      await use(grant);
      kept.push(grant);
    } catch {
      // Not usable with this session: left out of `kept`, so it is removed below.
    }
  }
  if (kept.length !== grants.length) await store.saveRuntimeGrants(address, kept);
}
