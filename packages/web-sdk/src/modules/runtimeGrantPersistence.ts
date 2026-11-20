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

/**
 * Stores the panel's own grants among `grants` for `address`, replacing a stored grant with the same cid. Other
 * delegations (an app's larger grant that already covered the request) are never stored.
 */
export async function rememberRuntimeGrants(
  store: RuntimeGrantStore,
  address: string,
  grants: readonly PortableDelegation[],
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const own = grants.filter((grant) => isPanelGrant(grant, address));
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

/** A stored grant. `askedBy` names the apps it was approved for (the `onBehalfOf` of each approving request). */
export type StoredRuntimeGrant = PortableDelegation & { readonly askedBy?: readonly string[] };

/** The apps a stored grant was approved for; anything else in the field is ignored. */
export function storedGrantAskers(grant: PortableDelegation): readonly string[] {
  const askedBy = (grant as StoredRuntimeGrant).askedBy;
  return Array.isArray(askedBy) ? askedBy.filter((asker): asker is string => typeof asker === "string" && asker !== "") : [];
}

/** The services this module knows. A service not listed here is elevated. */
const KNOWN_SERVICES: ReadonlySet<string> = new Set(["tinycloud.kv", "tinycloud.sql", "tinycloud.vfs", "tinycloud.delegation"]);

/** The known services whose non-elevated grants are kept across a reload. `tinycloud.delegation` is not: its one kept entry is the panel's own (see `isPanelResourceSet`). */
const REMEMBERED_SERVICES: ReadonlySet<string> = new Set(["tinycloud.kv", "tinycloud.sql", "tinycloud.vfs"]);

/** The space that holds secrets. Anything in it is elevated. */
const SECRETS_SPACE = "secrets";

/** The name of a space given as a full id (`tinycloud:pkh:eip155:1:0x…:name`) or as a bare name; `applications` when absent. */
function spaceName(space: string | undefined): string {
  if (space === undefined || space === "") return "applications";
  return (space.startsWith("tinycloud:") ? space.slice(space.lastIndexOf(":") + 1) : space).toLowerCase();
}

/**
 * True when a grant entry is elevated: any service this module does not know (decrypt and key creation among them),
 * anything in the secrets space, or a caveat of any shape. Failing closed: an entry this function cannot classify is
 * elevated, and an elevated grant is never written to storage.
 */
export function isElevatedResource(resource: {
  readonly service: string;
  readonly space?: string | undefined;
  readonly caveats?: unknown;
}): boolean {
  if (!KNOWN_SERVICES.has(longService(resource.service))) return true;
  const caveats = resource.caveats;
  if (caveats !== undefined && !(Array.isArray(caveats) && caveats.length === 0)) return true;
  return spaceName(resource.space) === SECRETS_SPACE;
}

/** True when `space` is a full space id of this owner on this chain. */
function isOwnedSpace(space: string, owner: { readonly address: string; readonly chainId: number }): boolean {
  return space.toLowerCase().startsWith(`tinycloud:pkh:eip155:${owner.chainId}:${owner.address}:`.toLowerCase());
}

/** True when every resource is in a space the owner owns and none is elevated. An empty set is not rememberable. */
export function isRememberableResourceSet(
  resources: readonly Resource[],
  owner: { readonly address: string; readonly chainId: number },
): boolean {
  return (
    resources.length > 0 &&
    resources.every((resource) => isOwnedSpace(resource.space, owner) && !isElevatedResource(resource) && REMEMBERED_SERVICES.has(longService(resource.service)))
  );
}

/** True when `grant` is an unexpired, non-elevated grant of the session owned by `address`. */
export function isRememberableGrant(grant: PortableDelegation, address: string): boolean {
  return (
    grant.ownerAddress.toLowerCase() === address.toLowerCase() &&
    grant.expiry.getTime() > Date.now() &&
    grant.resources !== undefined &&
    isRememberableResourceSet(grant.resources, { address: grant.ownerAddress, chainId: grant.chainId })
  );
}

/**
 * Stores the non-elevated grants among `grants` for `address`, with `asker` added to the apps each was approved for,
 * replacing a stored grant with the same cid. An elevated grant is never stored. A signed grant that spans several
 * spaces arrives as several delegations with one cid; it is not stored, because a restore rebuilds its resources from
 * the signed bytes, not from the delegation. A stored grant keeps its own signed expiry.
 */
export async function rememberAskedGrants(
  store: RuntimeGrantStore,
  address: string,
  grants: readonly PortableDelegation[],
  asker: string | undefined,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const byCid = new Map<string, PortableDelegation[]>();
  for (const grant of grants) byCid.set(grant.cid, [...(byCid.get(grant.cid) ?? []), grant]);
  const eligible = [...byCid.values()].flatMap((group) => (group.length === 1 && isRememberableGrant(group[0]!, address) ? group : []));
  if (eligible.length === 0) return;
  await serializeRuntimeGrantMutation(store, async () => {
    const known = await store.loadRuntimeGrants(address);
    if (!isCurrent()) return;
    const added = new Set(eligible.map((grant) => grant.cid));
    const stored = eligible.map((grant): StoredRuntimeGrant => {
      const prior = known.find((entry) => entry.cid === grant.cid);
      const askers = [...new Set([...(prior === undefined ? [] : storedGrantAskers(prior)), ...storedGrantAskers(grant), ...(asker === undefined ? [] : [asker])])];
      return askers.length === 0 ? grant : { ...grant, askedBy: askers };
    });
    await store.saveRuntimeGrants(address, [...known.filter((grant) => !added.has(grant.cid)), ...stored]);
  });
}
