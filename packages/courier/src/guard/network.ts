import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** WHATWG URL parsing canonicalises short, decimal, octal and hex IPv4 forms. Numeric hosts are refused conservatively. */
export function blockedDestination(value: string): boolean {
  const input = value.trim().replace(/^["']|["',;)]$/g, '');
  if (/^(?:\[?::1\]?|\[?::ffff:)/i.test(input)) return true;
  let url: URL;
  try { url = new URL(input.includes('://') ? input : `http://${input}`); } catch { return /(?:localhost|\b127\.|\b0x7f|\[::)/i.test(input); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  return url.port === '6767' || url.port === '6768' || host === 'localhost' || host.endsWith('.localhost') ||
    isIP(host) !== 0 || /^[0-9]+$/.test(host) || /(?:^|[.-])(?:127|0x7f[0-9a-f]*)(?:[.-]|$)/i.test(host) || /\.(nip|sslip)\.io$/.test(host);
}

/** Literal addresses inside argv and interpreted HTTP/net client code, including headers and --resolve. */
export function networkTextRefusal(text: string): boolean {
  if (/\/dev\/(tcp|udp)\//i.test(text)) return true;
  const networkCode = /\b(curl|wget|net|http|https|fetch|connect|urlopen|requests?|socket)\b/.test(text);
  const tokens = text.split(/[\s"'`,(){};=]+/).filter(Boolean);
  for (const token of tokens) {
    if (isIP(token.replace(/^\[|\]$/g, '')) !== 0) return true;
    if (networkCode && /^(?:[0-9]{7,}|0x[0-9a-f]+)$/i.test(token) && blockedDestination(token)) return true;
    if (/^https?:\/\//i.test(token) && blockedDestination(token)) return true;
    if (/(?:localhost|\[?::|^127\.|^0177\.|^0x7f|^2130706433|^0\.0\.0\.0)/i.test(token) && blockedDestination(token)) return true;
    if (/(?:^|:)676[78](?:\/|$)/.test(token)) return true;
  }
  return /\b(?:connect|urlopen|request|fetch)\b/.test(text) && /\b676[78]\b/.test(text);
}

export type ResolveHost = (host: string) => Promise<string[]>;
const resolveHost: ResolveHost = async host => (await lookup(host, { all: true, verbatim: true })).map(r => r.address);

/** DNS check before the tool executes. Errors fail closed. */
export async function dnsRefusal(text: string, resolve: ResolveHost = resolveHost): Promise<boolean> {
  const hosts = new Set<string>();
  for (const token of text.match(/(?:https?:\/\/)[^\s"'`,)]+|\b[a-z0-9.-]+:\d+(?:\/[^\s"']*)?/gi) ?? []) {
    try { hosts.add(new URL(token.includes('://') ? token : `http://${token}`).hostname); } catch { return true; }
  }
  if (/\b(curl|wget|http|https|httpie|xh|xhs|aria2c|fetch|urlopen|connect)\b/.test(text)) {
    for (const host of text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []) hosts.add(host);
  }
  if (hosts.size > 20) return true;
  for (const host of hosts) {
    if (blockedDestination(host)) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const addresses = await Promise.race([resolve(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('DNS timeout')), 1500); })]);
      if (!addresses.length || addresses.some(a => {
        const ip = a.replace(/^::ffff:/i, '');
        return /^(127\.|0\.)/.test(ip) || ip === '::1' || ip === '::' || /^::ffff:7f/i.test(a);
      })) return true;
    } catch { return true; } finally { clearTimeout(timer); }
  }
  return false;
}
