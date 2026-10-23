import {
  CaveatedDelegationUnsupportedError,
  hasNonEmptyCaveat,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

/** Throws `CaveatedDelegationUnsupportedError` for entries that carry a non-empty caveat. */
export function refuseCaveatedEntries(entries: readonly PermissionEntry[]): void {
  const caveated = entries.filter((entry) => hasNonEmptyCaveat(entry.caveats));
  if (caveated.length > 0) throw new CaveatedDelegationUnsupportedError(caveated);
}

/** `refuseCaveatedEntries` over the permissions of the given manifest(s); tolerates absent input. */
export function refuseCaveatedManifests(manifests: Manifest | readonly Manifest[] | undefined): void {
  refuseCaveatedEntries([manifests ?? []].flat().flatMap((manifest) => manifest.permissions ?? []));
}
