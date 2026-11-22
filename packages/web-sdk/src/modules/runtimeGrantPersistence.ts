/*
 * Runtime grants requested from the panel, and an app's grants of its owner's secrets' own keys, kept across a page
 * reload. They are stored beside the session record
 * (`BrowserSessionStorage.saveRuntimeGrants`), with the same lifecycle: a new sign-in, a sign-out and the session's
 * expiry remove them. A restore activates each one again through the SDK's validated activation, which recomputes the
 * CID from the signed bytes and reads expiry, audience and abilities from the signed grant, not from stored fields.
 * Nothing here throws: a storage or activation failure leaves the session as it was.
 */
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";
import { parseSecretKeyPath } from "@tinycloud/sdk-services";

import { TAB_PERMISSION } from "../ui/data/authority";

export interface RuntimeGrantStore {
  loadRuntimeGrants(address: string): Promise<PortableDelegation[]>;
  saveRuntimeGrants(address: string, grants: readonly PortableDelegation[]): Promise<void>;
}

const mutations = new WeakMap<RuntimeGrantStore, Promise<void>>();

/** Serialize short storage mutations while grant activation runs independently. */
export function serializeRuntimeGrantMutation<T>(
  store: RuntimeGrantStore | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  if (store === undefined) return mutation();
  const previous = mutations.get(store) ?? Promise.resolve();
  const current = previous.then(mutation);
  mutations.set(store, current.then(() => undefined, () => undefined));
  return current;
}

/** Bound for the automatic post-restore grant reactivation wait. */
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

const SECRET_KEY_ACTIONS = ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"];

/**
 * True when every resource is the exact key of one of this owner's secrets on the owner's default network
 * (`secrets/<name>` or `secrets/scoped/<scope>/<name>`, as `secretKeyPath` derives it), with decrypt and/or
 * key.create only and no caveats (TC-3284). One resource that is anything else (a prefix, another network or owner,
 * another key, any other service) refuses the whole set.
 */
export function isSecretKeyResourceSet(
  resources: readonly Resource[],
  owner: { readonly address: string; readonly chainId: number },
): boolean {
  const network = `urn:tinycloud:encryption:did:pkh:eip155:${owner.chainId}:${owner.address}:default/`.toLowerCase();
  return resources.length > 0 && resources.every((resource) =>
    longService(resource.service) === "tinycloud.encryption" &&
    (resource.space === "encryption" || resource.space === "") &&
    (resource.caveats?.length ?? 0) === 0 &&
    resource.path.slice(0, network.length).toLowerCase() === network &&
    parseSecretKeyPath(resource.path.slice(network.length)) !== undefined &&
    resource.actions.length > 0 &&
    resource.actions.every((action) => SECRET_KEY_ACTIONS.includes(action)));
}

/** True when `grant` is exactly a grant of the session owner's own secrets' keys (see `isSecretKeyResourceSet`). */
export function isSecretKeyGrant(grant: PortableDelegation, address: string): boolean {
  return (
    grant.ownerAddress.toLowerCase() === address.toLowerCase() &&
    grant.resources !== undefined &&
    isSecretKeyResourceSet(grant.resources, { address: grant.ownerAddress, chainId: grant.chainId })
  );
}

/**
 * Stores the panel's own grants and the owner's secret-key grants among `grants` for `address`, replacing a stored
 * grant with the same cid. Other delegations (an app's larger grant that already covered the request) are never stored.
 */
export async function rememberRuntimeGrants(
  store: RuntimeGrantStore,
  address: string,
  grants: readonly PortableDelegation[],
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const own = grants.filter((grant) => isPanelGrant(grant, address) || isSecretKeyGrant(grant, address));
  if (own.length === 0) return;
  await serializeRuntimeGrantMutation(store, async () => {
    const known = await store.loadRuntimeGrants(address);
    if (!isCurrent()) return;
    const added = new Set(own.map((grant) => grant.cid));
    await store.saveRuntimeGrants(address, [...known.filter((grant) => !added.has(grant.cid)), ...own]);
  });
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
    const grants = await serializeRuntimeGrantMutation(store, () => store.loadRuntimeGrants(address));
    const refused = new Set<string>();
    for (const grant of grants) {
      if (!isCurrent()) return;
      try {
        await use(grant);
      } catch (error) {
        if (refusesGrant(error)) refused.add(grant.cid);
      }
    }
    if (refused.size > 0 && isCurrent()) {
      await serializeRuntimeGrantMutation(store, async () => {
        const current = await store.loadRuntimeGrants(address);
        if (!isCurrent()) return;
        await store.saveRuntimeGrants(address, current.filter((grant) => !refused.has(grant.cid)));
      });
    }
  })().catch(() => undefined);
  // The wait ends with the work or at the budget; the timer is cleared when the work finishes first.
  const budget = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, options.budgetMs ?? RESTORE_GRANT_BUDGET_MS);
    void work.finally(() => clearTimeout(timer));
  });
  await Promise.race([work, budget]);
}
