import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode, type Manifest, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { authorizationVerdictOf } from "@tinycloud/sdk-core";

const DEFAULT_HOST = "https://node.tinycloud.xyz";

export interface DstackKeyClient {
  getKey(path: string, purpose: string): Promise<{ key: Uint8Array }>;
}

export interface DeriveDstackPrivateKeyOptions {
  client: DstackKeyClient;
  path: string;
  purpose: string;
}

export async function deriveDstackPrivateKey(
  options: DeriveDstackPrivateKeyOptions,
): Promise<Hex> {
  const res = await options.client.getKey(options.path, options.purpose);
  if (!(res.key instanceof Uint8Array) || res.key.length === 0) {
    throw new Error("dstack getKey returned no key material");
  }
  return keccak256(res.key);
}

export function serverDidForPrivateKey(privateKey: string): string {
  const account = privateKeyToAccount(privateKey as Hex);
  return `did:pkh:eip155:1:${account.address}`;
}

export interface CreateServerIdentityOptions {
  privateKey: string;
  host?: string;
  prefix?: string;
  manifest?: Manifest | Manifest[];
  autoCreateSpace?: boolean;
  enablePublicSpace?: boolean;
  includeAccountRegistryPermissions?: boolean;
  nodeConfig?: Omit<
    TinyCloudNodeConfig,
    | "privateKey"
    | "host"
    | "prefix"
    | "manifest"
    | "autoCreateSpace"
    | "enablePublicSpace"
    | "includeAccountRegistryPermissions"
  >;
}

export interface ServerIdentity {
  node: TinyCloudNode;
  did: string;
  host: string;
  privateKey: string;
}

export async function createServerIdentity(
  options: CreateServerIdentityOptions,
): Promise<ServerIdentity> {
  const host = options.host ?? DEFAULT_HOST;
  const node = new TinyCloudNode({
    ...options.nodeConfig,
    privateKey: options.privateKey,
    host,
    prefix: options.prefix,
    manifest: options.manifest,
    autoCreateSpace: options.autoCreateSpace ?? false,
    enablePublicSpace: options.enablePublicSpace ?? false,
    includeAccountRegistryPermissions: options.includeAccountRegistryPermissions ?? false,
  });

  await node.signIn();

  return {
    node,
    did: node.did,
    host,
    privateKey: options.privateKey,
  };
}

// Message heuristics, for untyped errors only.
//
// Quoted text (`"…"`) is dropped first: the SDK quotes caller-chosen names such
// as KV keys (`Failed to put key "report(401)": 403 - …`), and a number inside
// one is never the status.
//
// A status is then a number only in the positions the SDK's own messages use:
//   - `: NNN -` and a trailing `: NNN`   (`…key "k": 403 - text`, `…failed: 401`)
//   - `server: NNN`                      (`…delegation with server: 403 text`)
//   - `HTTP NNN`, `returned NNN`         (`…delegation import returned 401`)
//   - `rejected (NNN)` and a trailing `(NNN)` or `(NNN).`
//   - a leading `NNN` followed by a word other than `bytes`, or alone
// The first such number in 100-599 decides, whatever its value: only a 401
// refreshes, so a real 502 is not overridden by a `401` quoted in its body.
// Paths, ids, ports, byte counts and `expected 401, got 500` are not statuses.
// Session wording decides only when no status is found.
const QUOTED_TEXT_PATTERN = /"[^"]*"/g;
const DIAGNOSTIC_STATUS_PATTERN =
  /^(\d{3})(?:\s+(?!bytes\b)[a-z]|$)|:\s(\d{3})(?:\s-|$)|\bserver:\s(\d{3})\b|\bHTTP\s(\d{3})\b|\breturned\s(\d{3})\b|\brejected\s\((\d{3})\)|\((\d{3})\)\.?$/gi;
const SESSION_ERROR_PATTERN =
  /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b/i;

/** The first HTTP status in a diagnostic position of `message` (quotes dropped). */
function diagnosticStatusOf(message: string): number | undefined {
  for (const match of message.matchAll(DIAGNOSTIC_STATUS_PATTERN)) {
    const status = Number(match.slice(1).find((group) => group !== undefined));
    if (status >= 100 && status <= 599) return status;
  }
  return undefined;
}

/**
 * Whether re-signing in can fix `error`. Typed errors (HTTP `status`,
 * `statusCode` or `meta.status`, or `AUTH_UNAUTHORIZED`, including through the
 * `cause` chain) decide from their structure: only a 401 refreshes, so a 403
 * never does whatever its body says. Untyped errors fall back to the message.
 */
export function isTinyCloudSessionError(error: unknown): boolean {
  const verdict = authorizationVerdictOf(error);
  if (verdict !== undefined) {
    return verdict === "unauthenticated";
  }
  const message = (error instanceof Error ? error.message : String(error))
    .replace(QUOTED_TEXT_PATTERN, '""');
  const status = diagnosticStatusOf(message);
  if (status !== undefined) {
    return status === 401;
  }
  return SESSION_ERROR_PATTERN.test(message);
}

/**
 * Run `fn`, re-signing in and retrying once when it fails with a session
 * error (see {@link isTinyCloudSessionError}). To keep the typed status when
 * unwrapping a `Result`, throw the `ServiceError` itself or an `Error` whose
 * `cause` is the `ServiceError`.
 */
export async function withSessionRefresh<T>(
  node: TinyCloudNode,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isTinyCloudSessionError(error)) {
      await node.signIn();
      return fn();
    }
    throw error;
  }
}
