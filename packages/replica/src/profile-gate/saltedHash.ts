/**
 * `SaltedHash` (CONTRACT.md §1 "Identifiers"): lowercase hex HMAC-SHA-256,
 * keyed with the base64url-decoded per-incarnation salt, over the UTF-8
 * material. The one implementation every salted replica id uses — browser
 * partition ids and identity-key hashes, and the gate's principal hash on
 * both platforms. WebCrypto, so it runs in pages, workers, Node and Bun; it
 * is async, so callers derive ids before opening any IndexedDB transaction.
 */
import type { SaltedHash } from "@tinycloud/sdk-services/kv/replication";

function base64UrlBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError("The replica gate salt is not base64url.");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(globalThis.atob(padded), (char) => char.charCodeAt(0));
}

export const saltedHash: SaltedHash = async (salt, material) => {
  const key = await globalThis.crypto.subtle.importKey("raw", base64UrlBytes(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material)));
  let hex = "";
  for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
  return hex;
};
