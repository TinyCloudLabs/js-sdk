/*
 * Runtime grants requested from the panel, kept across a page reload. They are stored beside the session record
 * (`BrowserSessionStorage.saveRuntimeGrants`), with the same lifecycle: a new sign-in, a sign-out and the session's
 * expiry remove them. A restore activates each one again through the SDK's validated activation, which recomputes the
 * CID from the signed bytes and reads expiry, audience and abilities from the signed grant, not from stored fields.
 * Nothing here throws: a storage or activation failure leaves the session as it was.
 */
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

import { TAB_PERMISSION } from "../ui/data/authority";

export interface RuntimeGrantStore {
  loadRuntimeGrants(address: string): Promise<PortableDelegation[]>;
  saveRuntimeGrants(address: string, grants: readonly PortableDelegation[]): Promise<void>;
}

/** How long a restore waits for stored grants to be activated before it carries on without them. */
export const RESTORE_GRANT_BUDGET_MS = 4_000;

interface Resource {
  readonly service: string;
  readonly space: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly caveats?: readonly unknown[] | undefined;
}

const longService = (service: string): string => (service.startsWith("tinycloud.") ? service : `tinycloud.${service}`);

/**
 * True when `resources` are exactly one tab's entry for this owner: that service, the resolved space, that path,
 * exactly those actions, no caveats. A grant that carries anything more (an app's larger grant) is not a panel grant.
 */
export function isPanelResourceSet(
  resources: readonly Resource[],
  owner: { readonly address: string; readonly chainId: number },
): boolean {
  const [resource, ...more] = resources;
  if (resource === undefined || more.length > 0 || (resource.caveats?.length ?? 0) > 0) return false;
  return Object.values(TAB_PERMISSION).some((entry: PermissionEntry | undefined) => {
    if (entry === undefined || longService(resource.service) !== longService(entry.service)) return false;
    const space = entry.space?.startsWith("tinycloud:")
      ? entry.space
      : `tinycloud:pkh:eip155:${owner.chainId}:${owner.address}:${entry.space ?? "applications"}`;
    const wanted = entry.actions.map((action) => (action.includes("/") ? action : `${longService(entry.service)}/${action}`));
    return (
      resource.space.toLowerCase() === space.toLowerCase() &&
      resource.path === entry.path &&
      resource.actions.length === wanted.length &&
      wanted.every((action) => resource.actions.includes(action))
    );
  });
}

/** True when `grant` is exactly a panel grant of the session owned by `address`. */
export function isPanelGrant(grant: PortableDelegation, address: string): boolean {
  return (
    grant.ownerAddress.toLowerCase() === address.toLowerCase() &&
    grant.resources !== undefined &&
    isPanelResourceSet(grant.resources, { address: grant.ownerAddress, chainId: grant.chainId })
  );
}

/**
 * Stores the panel's own grants among `grants` for `address`, replacing a stored grant with the same cid. Other
 * delegations (an app's larger grant that already covered the request) are never stored.
 */
export async function rememberRuntimeGrants(
  store: RuntimeGrantStore,
  address: string,
  grants: readonly PortableDelegation[],
): Promise<void> {
  const own = grants.filter((grant) => isPanelGrant(grant, address));
  if (own.length === 0) return;
  const known = await store.loadRuntimeGrants(address);
  const added = new Set(own.map((grant) => grant.cid));
  await store.saveRuntimeGrants(address, [...known.filter((grant) => !added.has(grant.cid)), ...own]);
}

/**
 * Refusals that say the grant itself is no good for this session (expired, issued to another key, bytes that do not
 * verify, rejected by the node). Not these: a host that cannot be reached or answers 408, 429 or 5xx, a host that
 * is not the one the grant was made on yet, a runtime that cannot verify, or any other error. Those keep the grant.
 */
function refusesGrant(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "RuntimeDelegationRejectedError" || !("reason" in error)) return false;
  return error.reason !== "activation_unavailable" && error.reason !== "host_mismatch" && error.reason !== "unsupported";
}

/**
 * Activates each stored grant through `use` (the SDK's validated activation). A grant refused for good is removed from
 * storage; the others stay, including one whose activation failed for a transient reason. Waits at most `budgetMs`;
 * activations still running then finish in the background. Never throws. `isCurrent` false (signed out meanwhile)
 * stops any write to storage.
 */
export async function reuseRuntimeGrants(
  store: RuntimeGrantStore,
  address: string,
  use: (grant: PortableDelegation) => Promise<unknown>,
  options: { readonly budgetMs?: number; readonly isCurrent?: () => boolean } = {},
): Promise<void> {
  const isCurrent = options.isCurrent ?? (() => true);
  const work = (async () => {
    const grants = await store.loadRuntimeGrants(address);
    const refused = new Set<PortableDelegation>();
    for (const grant of grants) {
      if (!isCurrent()) return;
      try {
        await use(grant);
      } catch (error) {
        if (refusesGrant(error)) refused.add(grant);
      }
    }
    if (refused.size > 0 && isCurrent()) {
      await store.saveRuntimeGrants(address, grants.filter((grant) => !refused.has(grant)));
    }
  })().catch(() => undefined);
  // The wait ends with the work or at the budget; the timer is cleared when the work finishes first.
  const budget = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, options.budgetMs ?? RESTORE_GRANT_BUDGET_MS);
    void work.finally(() => clearTimeout(timer));
  });
  await Promise.race([work, budget]);
}
