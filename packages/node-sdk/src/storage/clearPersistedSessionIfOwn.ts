import type { ISessionStorage } from "@tinycloud/sdk-core";
import { invalidateOwnSession } from "@tinycloud/sdk-core";

/**
 * Clear only the leaving session. Ownership-read failures reject: an unreadable record
 * is not permission to delete a replacement. Legacy adapters provide no atomic suppression guarantee.
 */
export async function clearPersistedSessionIfOwn(
  storage: ISessionStorage,
  address: string,
  ownSignature: string | undefined,
): Promise<void> {
  if (ownSignature !== undefined) {
    const owned = invalidateOwnSession(storage, address, ownSignature);
    if (owned !== undefined) return owned;
    const stored = await storage.load(address);
    if (stored !== null && stored.signature !== ownSignature) return;
  }
  await storage.clear(address);
}
