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
