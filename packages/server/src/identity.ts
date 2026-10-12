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
// 1. Double-quoted strings and standalone single-quoted names are dropped
//    (escape-aware). Apostrophes next to Unicode letters, numbers, combining
//    marks, or underscores are word characters, not quote delimiters.
// 2. The first number in 400-599 in one of the SDK's diagnostic positions is
//    the status:
//      - `: NNN` followed by whitespace or the end — KV `…key "k": 403 - text`,
//        hooks `…webhook: 401 hook ticket expired`, `…with server: 403`,
//        `…failed: 401`
//      - `HTTP NNN`, `returned NNN`, `rejected (NNN)`
//      - a trailing `(NNN)` or `(NNN).`
//    Only a 401 refreshes, so a real 502 or 403 is never overridden by a `401`
//    later in its body.
// 3. With no status, session wording on the unstripped message decides.
const NAME_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}_]/u;

/** Strip standalone quoted names without retrying failed scans of the same quote type. */
export function stripQuotedNames(message: string): string {
  let parts: string[] | undefined;
  let literalStart = 0;
  let noDoubleClose = false;
  let noSingleClose = false;
  let blockedUntilDouble = -1;
  let blockedUntilSingle = -1;
  for (let i = 0; i < message.length; i += 1) {
    const quote = message[i];
    const double = quote === '"';
    if (!double && quote !== "'") continue;
    if (double ? noDoubleClose || i < blockedUntilDouble : noSingleClose || i < blockedUntilSingle) continue;
    if (!double && i > 0) {
      const previousCodeUnit = message.charCodeAt(i - 1);
      const previous = previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff &&
        i > 1 && message.charCodeAt(i - 2) >= 0xd800 && message.charCodeAt(i - 2) <= 0xdbff
        ? message.slice(i - 2, i)
        : message[i - 1]!;
      if (NAME_CHARACTER_PATTERN.test(previous)) continue;
    }

    let end = i + 1;
    let blockedByLineBreak = false;
    while (end < message.length) {
      if (message[end] === "\\") {
        const next = message[end + 1];
        if (next === "\n" || next === "\r" || next === "\u2028" || next === "\u2029") {
          blockedByLineBreak = true;
          break;
        }
        end += 2;
      } else if (message[end] === quote &&
        (double || end + 1 === message.length ||
          !NAME_CHARACTER_PATTERN.test(String.fromCodePoint(message.codePointAt(end + 1)!)))) {
        break;
      } else {
        end += 1;
      }
    }
    if (blockedByLineBreak) {
      // `\\.` cannot consume a line terminator without /s. Earlier starts
      // hit this slash too; starts after it may still close.
      if (double) blockedUntilDouble = end;
      else blockedUntilSingle = end;
      continue;
    }
    if (end >= message.length) {
      // Escape pairing in the remaining suffix is unchanged for later starts,
      // so none of this quote type can close after a full scan to the end.
      if (double) noDoubleClose = true;
      else noSingleClose = true;
      if (noDoubleClose && noSingleClose) break;
      continue;
    }
    (parts ??= []).push(message.slice(literalStart, i), '""');
    i = end;
    literalStart = end + 1;
  }
  if (!parts) return message;
  parts.push(message.slice(literalStart));
  return parts.join("");
}

const DIAGNOSTIC_STATUS_PATTERN =
  /:\s(\d{3})(?=\s|$)|\bHTTP\s(\d{3})\b|\breturned\s(\d{3})\b|\brejected\s\((\d{3})\)|\((\d{3})\)\.?$/gi;
const SESSION_ERROR_PATTERN =
  /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b/i;

/** The first HTTP error status in a diagnostic position, ignoring quoted strings. */
function diagnosticStatusOf(message: string): number | undefined {
  const unquoted = stripQuotedNames(message);
  for (const match of unquoted.matchAll(DIAGNOSTIC_STATUS_PATTERN)) {
    const status = Number(match.slice(1).find((group) => group !== undefined));
    if (status >= 400 && status <= 599) return status;
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
  const message = error instanceof Error ? error.message : String(error);
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
