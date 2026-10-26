/** Match OpenKey's app-key host binding for a SIWE domain. */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function appKeyHostBinding(domain: string, appId: string): boolean {
  if (!APP_ID.test(appId)) return false;
  if (domain.endsWith(":")) return false;
  let url: URL;
  try {
    url = new URL(`https://${domain}`);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  const host = url.hostname;
  if (host.startsWith("[") || host.endsWith(".") || IPV4.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2 || labels[labels.length - 1] === "localhost") return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  const reversed = labels.reverse().join(".");
  return appId === reversed || appId.startsWith(`${reversed}.`);
}

/**
 * Whether sign-in at `origin` can be granted named-key abilities for the app
 * whose manifest `keys_app_id` (or `app_id`) is `keysAppId`.
 *
 * "Bound" means the key app id equals the reversed host of the origin, or
 * extends it with further dot-separated labels: `tinycloud.chat` binds
 * `chat.tinycloud.tinychat` and `chat.tinycloud.tinychat.worker`. Origins with
 * no registrable host (`localhost`, `tauri.localhost`, IP addresses) or with
 * lookalike hosts (`evil-tinycloud.chat`, `tinycloud.chat.evil.com`) are not
 * bound. `origin` is a URL, an origin string such as `https://tinycloud.chat`,
 * or a bare SIWE domain such as `tinycloud.chat`; the host (including any
 * non-default port, which makes the origin unbound) is what is checked.
 *
 * This is the check `NodeUserAuthorization` applies when it decides whether a
 * manifest's `keys` rows are granted at sign-in. A bound origin still needs a
 * node that lists `encryption-named-keys-v1` in `/info` to actually receive
 * the row.
 */
export function isAppKeyHostBound(keysAppId: string, origin: string | URL): boolean {
  if (typeof origin === "string" && !origin.includes("://")) {
    return appKeyHostBinding(origin, keysAppId);
  }
  let url: URL;
  try {
    url = typeof origin === "string" ? new URL(origin) : origin;
  } catch {
    return false;
  }
  return appKeyHostBinding(url.host, keysAppId);
}
