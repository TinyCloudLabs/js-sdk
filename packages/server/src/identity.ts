import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode, type Manifest, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";

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

const SESSION_ERROR_PATTERN =
  /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b|\b401\b(?![\d-])/i;

export function isTinyCloudSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SESSION_ERROR_PATTERN.test(message);
}

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
