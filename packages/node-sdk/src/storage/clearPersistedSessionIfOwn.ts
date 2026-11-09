import type { ISessionStorage } from "@tinycloud/sdk-core";

/**
 * Clear the stored session for `address`, unless it provably belongs to a different session than
 * `ownSignature` (a newer sign-in saved for the same address). A stored session that cannot be read
 * or compared is cleared: sign-out never keeps authority it cannot check.
 */
export async function clearPersistedSessionIfOwn(
  storage: ISessionStorage,
  address: string,
  ownSignature: string | undefined,
): Promise<void> {
  if (ownSignature !== undefined) {
    try {
      const stored = await storage.load(address);
      if (stored !== null && stored.signature !== ownSignature) return;
    } catch {
      // Unreadable: fall through and clear.
    }
  }
  await storage.clear(address);
}
