/**
 * Persistence for the "button hidden" flag. Scope is origin-wide (plus appId),
 * never pathname, never wallet address or DID.
 *
 * Same pattern as permissionPromptSuppression.ts: storage access is guarded,
 * and when storage is blocked or throws, the flag lasts for the page only.
 */

export const HIDE_KEY_PREFIX = "tinycloud:ui:button-hidden:v1:";
export const FALLBACK_APP_ID = "_page";

export interface HideScope {
  readonly origin: string;
  readonly appId: string;
}

export interface ButtonHideStore {
  read(scope: HideScope): boolean;
  write(scope: HideScope, hidden: boolean): void;
}

export function hideStorageKey(scope: HideScope): string {
  return `${HIDE_KEY_PREFIX}${encodeURIComponent(scope.origin)}:${encodeURIComponent(scope.appId)}`;
}

/** config.ui.appId, then manifest.app_id, then the origin-wide constant. */
export function resolveUiAppId(configured: string | undefined, manifestAppId: string | undefined): string {
  if (configured !== undefined && configured.trim() !== "") return configured;
  if (manifestAppId !== undefined && manifestAppId.trim() !== "") return manifestAppId;
  return FALLBACK_APP_ID;
}

/**
 * `storage` is resolved per call so a blocked localStorage getter is caught on
 * every access, not only at construction.
 */
export function createButtonHideStore(storage: () => Storage | undefined): ButtonHideStore {
  const memory = new Map<string, string>();

  return {
    read(scope) {
      const key = hideStorageKey(scope);
      try {
        const stored = storage()?.getItem(key);
        if (stored === "1") return true;
      } catch {
        // Blocked storage: fall through to the in-memory value.
      }
      return memory.get(key) === "1";
    },
    write(scope, hidden) {
      const key = hideStorageKey(scope);
      if (hidden) memory.set(key, "1");
      else memory.delete(key);
      try {
        const target = storage();
        if (hidden) target?.setItem(key, "1");
        else target?.removeItem(key);
      } catch {
        // Blocked or full storage: the in-memory value still applies for this page.
      }
    },
  };
}

/** Default storage: window.localStorage, or undefined when access throws. */
export function defaultLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
