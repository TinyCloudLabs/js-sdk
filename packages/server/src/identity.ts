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

// Message heuristics for untyped errors only. A 401/403 counts as a status
// only in the contexts the SDK's own messages put it: after `: ` (`…key "k":
// 403 - text`, `…with server: 403 text`, `…failed: 401`), after `HTTP `, inside
// `(403)`, or leading the message (`403 Unauthorized Action: …`); and only
// when followed by whitespace, `)` or the end. Paths, ids, ports, byte counts
// and `expected 401, got 500` are not statuses. An explicit status decides
// before the session-wording pattern, so a 403 whose body reads
// `Unauthorized Action: …` never triggers a refresh.
const HTTP_AUTH_STATUS_PATTERN = /(?:^|\bHTTP\s+|:\s|\()(401|403)(?=[\s)]|$)/;
const SESSION_ERROR_PATTERN =
  /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b/i;

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
  const message = error instanceof Error ? error.message : String(error);
  const status = HTTP_AUTH_STATUS_PATTERN.exec(message)?.[1];
  if (status !== undefined) {
    return status === "401";
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
