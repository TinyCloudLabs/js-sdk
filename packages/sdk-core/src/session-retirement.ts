import type { ISessionStorage } from "./storage";

type InvalidateOwnSession = (address: string, expectedSignature: string) => void | Promise<void>;
const ownedStorage = new WeakMap<ISessionStorage, InvalidateOwnSession>();

/** @internal SDK-owned instances only; not a consumer/provider extension point or trust boundary. */
export function registerOwnedSessionStorage(storage: ISessionStorage, invalidate: InvalidateOwnSession): void {
  ownedStorage.set(storage, invalidate);
}

/**
 * @internal Starts owned invalidation synchronously. Undefined means this core instance has no registration:
 * callers must use the existing legacy adapter contract, without claiming durable suppression.
 */
export function invalidateOwnSession(
  storage: ISessionStorage,
  address: string,
  expectedSignature: string,
): Promise<void> | undefined {
  const invalidate = ownedStorage.get(storage);
  if (invalidate === undefined) return undefined;
  try {
    return Promise.resolve(invalidate(address, expectedSignature));
  } catch (error) {
    return Promise.reject(error);
  }
}
