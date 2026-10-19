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

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
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
    if (value !== undefined && (!RFC3339.test(value) || Number.isNaN(Date.parse(value)))) bad(`${name} is not RFC 3339`);
  }
  return { domain: head![1]!, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime, notBefore, resources };
}
