import { toChecksumAddress } from "./did";
import { refuse } from "./errors";

export const PRESENTATION_STATEMENT = "Present a TinyCloud held credential";
export const SD_HASH_RESOURCE_PREFIX = "urn:tinycloud:sd-hash:";

export interface StrictSiwe {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  resources: string[];
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Exact RFC 3339 `date-time` to epoch milliseconds, or null. Every field is range-checked and the
 * date must be real (no Feb 31, hour 24 or second 60), so `Date.parse`'s leniency never decides.
 */
export function parseRfc3339(value: string): number | null {
  const m = RFC3339.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // unlike Date.UTC, years 0-99 are not remapped to 19xx
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offsetMinutes = 0;
  if (m[8] !== undefined) {
    const oh = Number(m[9]), om = Number(m[10]);
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (m[8] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0").slice(0, 3));
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime() - offsetMinutes * 60_000;
}
const AUDIENCE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::([1-9][0-9]{0,4}))?$/;

/** An audience is a bare RFC 3986 authority: lowercase host[:port], no scheme, userinfo, path, or default port 443. */
export function assertValidAudience(audience: string): void {
  const match = AUDIENCE.exec(audience);
  if (!match || (match[1] !== undefined && (Number(match[1]) > 65535 || match[1] === "443"))) {
    refuse("bad-config", "audience must be a lowercase host[:port] authority without a default port");
  }
}

/** Strict EIP-4361 parse in the exact layout this profile accepts. Anything else is refused. */
export function parseStrictSiwe(message: string): StrictSiwe {
  const bad = (why: string): never => refuse("bad-siwe", why);
  const lines = message.split("\n");
  const head = /^(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? "");
  if (!head) bad("header line");
  const address = lines[1] ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) bad("address");
  if (toChecksumAddress(address) !== address) bad("address must be EIP-55 checksummed");
  if (lines[2] !== "") bad("layout");
  const statement = lines[3];
  if (statement === undefined || statement === "") bad("statement");
  if (lines[4] !== "") bad("layout");
  let index = 5;
  const field = (name: string, optional = false): string | undefined => {
    const line = lines[index];
    const prefix = `${name}: `;
    if (line === undefined || !line.startsWith(prefix)) {
      if (optional) return undefined;
      return bad(`missing ${name}`);
    }
    index += 1;
    const value = line.slice(prefix.length);
    if (value === "") bad(`empty ${name}`);
    return value;
  };
  const uri = field("URI")!;
  const version = field("Version")!;
  const chainId = field("Chain ID")!;
  const nonce = field("Nonce")!;
  const issuedAt = field("Issued At")!;
  const expirationTime = field("Expiration Time", true);
  const notBefore = field("Not Before", true);
  if (lines[index]?.startsWith("Request ID: ")) bad("Request ID is not accepted");
  const resources: string[] = [];
  if (lines[index] === "Resources:") {
    index += 1;
    while (lines[index] !== undefined && lines[index]!.startsWith("- ")) { resources.push(lines[index]!.slice(2)); index += 1; }
  }
  if (index !== lines.length) bad("trailing content");
  if (!/^[0-9]+$/.test(chainId)) bad("chain id");
  if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) bad("nonce must be alphanumeric");
  for (const [name, value] of [["Issued At", issuedAt], ["Expiration Time", expirationTime], ["Not Before", notBefore]] as const) {
    if (value !== undefined && parseRfc3339(value) === null) bad(`${name} is not RFC 3339`);
  }
  return { domain: head![1]!, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime, notBefore, resources };
}
