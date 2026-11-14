/**
 * First-party app origins, shared with OpenKey's first-party-origins.ts.
 * Reference: TinyCloudLabs/openkey@c4bceb3e5eaf65704f384ff0d0dfade0b75b97b4,
 * apps/api/src/services/first-party-origins.ts. Update both contracts together;
 * the contract test names the entries the two lists do not share.
 * Match the actual page origin, never a caller-supplied SIWE domain.
 */
export const FIRST_PARTY_ORIGINS: ReadonlySet<string> = new Set([
  "https://tinycloud.chat",
  "https://home.tinycloud.xyz",
  "https://tinycloud.one",
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
