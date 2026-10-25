/**
 * Where the owner frees up space or upgrades their plan. Mirrors
 * `STORAGE_MANAGE_URL` in sdk-services `src/storage/status.ts`. Owned here so
 * the UI module does not import a runtime value from sdk-core, which would
 * pull the whole client into the lazy-loaded UI bundle.
 */
export const STORAGE_MANAGE_URL = "https://account.tinycloud.xyz/storage";
