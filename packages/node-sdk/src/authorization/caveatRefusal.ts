import {
  CaveatedDelegationUnsupportedError,
  recapCaveatsEqual,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

/**
 * Throws `CaveatedDelegationUnsupportedError` for permission entries, or the
 * permissions of manifests, that carry a caveat. Only absent, `[]` and `[{}]`
 * pass; `null` and malformed caveats fail closed.
 */
export function refuseCaveated(
  input: Manifest | readonly (Manifest | PermissionEntry)[] | undefined,
): void {
  const caveated = [input ?? []]
    .flat()
    .flatMap((item) => [item as PermissionEntry, ...((item as Manifest).permissions ?? [])])
    .filter(({ caveats }) => {
      try {
        return caveats === null || !recapCaveatsEqual(caveats, undefined);
      } catch {
        return true;
      }
    });
  if (caveated.length) throw new CaveatedDelegationUnsupportedError(caveated);
}
