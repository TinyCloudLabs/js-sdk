import {
  CaveatedDelegationUnsupportedError,
  recapCaveatsEqual,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

// Only an absent value is unconstrained; null and malformed caveats (non-array or
// non-plain entries) fail closed.
function carriesCaveat(caveats: PermissionEntry["caveats"]): boolean {
  if (caveats === null) return true;
  try {
    return !recapCaveatsEqual(caveats, undefined);
  } catch {
    return true;
  }
}

/** Throws `CaveatedDelegationUnsupportedError` for entries that carry a caveat. */
export function refuseCaveatedEntries(entries: readonly PermissionEntry[]): void {
  const caveated = entries.filter((entry) => carriesCaveat(entry.caveats));
  if (caveated.length > 0) throw new CaveatedDelegationUnsupportedError(caveated);
}

/** `refuseCaveatedEntries` over the permissions of the given manifest(s); tolerates absent input. */
export function refuseCaveatedManifests(manifests: Manifest | readonly Manifest[] | undefined): void {
  refuseCaveatedEntries([manifests ?? []].flat().flatMap((manifest) => manifest.permissions ?? []));
}
