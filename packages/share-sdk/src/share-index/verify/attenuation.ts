import { canonicalize } from "@tinycloud/share-envelope";
import { canonicalAddressSpelling } from "../agent-record.js";

/**
 * Attenuation containment (design C4): every (resource, ability) of the child
 * must be granted by the parent on the same resource or on a parent resource
 * under the segment-prefix rule `child == parent || child.startsWith(parent
 * + "/")` (a parent already ending in `/` is a prefix itself), as
 * `unified.ts:1225-1233` applies it. EVM address spelling is ignored. A
 * parent ability whose caveats are all empty objects is unrestricted;
 * otherwise the child's caveats must be identical. Fail-closed.
 */
export type Attenuation = Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;

function resourceCovers(parent: string, child: string): boolean {
  const p = canonicalAddressSpelling(parent);
  const c = canonicalAddressSpelling(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function unrestricted(caveats: readonly unknown[]): boolean {
  return caveats.every((caveat) => caveat !== null && typeof caveat === "object" && !Array.isArray(caveat) && Object.keys(caveat).length === 0);
}

export function attenuationCovers(parent: Attenuation, child: Attenuation): boolean {
  const childEntries = Object.entries(child);
  if (childEntries.length === 0) return false;
  return childEntries.every(([childResource, abilities]) =>
    Object.entries(abilities).every(([ability, childCaveats]) =>
      Object.entries(parent).some(([parentResource, parentAbilities]) => {
        const parentCaveats = Object.prototype.hasOwnProperty.call(parentAbilities, ability) ? parentAbilities[ability] : undefined;
        if (parentCaveats === undefined || !resourceCovers(parentResource, childResource)) return false;
        return unrestricted(parentCaveats) || canonicalize(parentCaveats) === canonicalize(childCaveats);
      })));
}

/** Whether the attenuation grants `ability` on exactly `resource` (spelling-insensitive). */
export function grantsExactly(attenuation: Attenuation, resource: string, ability: string): boolean {
  const target = canonicalAddressSpelling(resource);
  return Object.entries(attenuation).some(([key, abilities]) => canonicalAddressSpelling(key) === target && Object.prototype.hasOwnProperty.call(abilities, ability));
}
