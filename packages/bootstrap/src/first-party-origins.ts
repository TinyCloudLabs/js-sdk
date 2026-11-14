/**
 * First-party app origins, shared with OpenKey's first-party-origins.ts.
 * Reference: TinyCloudLabs/openkey@3e7bd5fc4328080028827f15a94555754e1f775d,
 * apps/api/src/services/first-party-origins.ts. Update both contracts together;
 * the contract test names the OpenKey entries this public list omits.
 * Match the actual page origin, never a caller-supplied SIWE domain.
 */
export const FIRST_PARTY_ORIGINS: ReadonlySet<string> = new Set([
  "https://tinycloud.chat",
  "https://home.tinycloud.xyz",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://share.tinycloud.xyz",
  "https://secrets.tinycloud.xyz",
]);

export const FIRST_PARTY_PAGES_SUBDOMAINS: readonly string[] = [
  "tinychat-4jq", "share-2fz", "tinycloud-secrets", "openkey-tinycloud-demo",
];
const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const pages = FIRST_PARTY_PAGES_SUBDOMAINS.map((name) =>
  new RegExp(`^https://(?:${label}\\.)?${name}\\.pages\\.dev$`),
);

export function isFirstPartyOrigin(origin: unknown): boolean {
  return typeof origin === "string" &&
    (FIRST_PARTY_ORIGINS.has(origin) || pages.some((pattern) => pattern.test(origin)));
}
