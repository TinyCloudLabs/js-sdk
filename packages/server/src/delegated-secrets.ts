import {
  TinyCloudNode,
  deserializeDelegation,
  type InlineEncryptedEnvelope,
  type PortableDelegation,
  type SecretScopeOptions,
} from "@tinycloud/node-sdk";
import { resolveSecretPath } from "@tinycloud/sdk-core";
import type { CreateServerIdentityOptions } from "./identity.js";
import { createServerIdentity } from "./identity.js";

type KvLike = {
  get<T = unknown>(
    key: string,
    options: { raw: true; prefix: string },
  ): Promise<{ ok: true; data: T | unknown } | { ok: false; error?: { message?: string } }>;
};

type DelegatedAccessLike = {
  kv: KvLike;
  delegation: Pick<PortableDelegation, "cid">;
  restorable?: { delegationCid?: string };
};

type DecryptResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: { code?: string; message: string } };

type EncryptionLike = {
  decryptEnvelope(
    envelope: InlineEncryptedEnvelope,
    capabilityProof: { proofs: string[] },
  ): Promise<DecryptResult>;
};

type TinyCloudNodeLike = {
  signIn(): Promise<unknown>;
  useDelegation(delegation: PortableDelegation): Promise<DelegatedAccessLike>;
  encryption: EncryptionLike;
};

export type DelegationInput = PortableDelegation | string;

export interface ServerDelegateClient {
  getSecret(name: string, options?: SecretScopeOptions): Promise<string>;
}

export interface CreateServerDelegateClientOptions {
  privateKey: string;
  host?: string;
  delegation: DelegationInput;
  prefix?: string;
  nodeConfig?: CreateServerIdentityOptions["nodeConfig"];
  node?: TinyCloudNodeLike;
  nodeFactory?: (options: CreateServerIdentityOptions) => Promise<TinyCloudNodeLike>;
}

export function createServerDelegateClient(
  options: CreateServerDelegateClientOptions,
): ServerDelegateClient {
  const delegation = parseDelegation(options.delegation);
  let nodePromise: Promise<TinyCloudNodeLike> | undefined;

  async function getNode(): Promise<TinyCloudNodeLike> {
    if (!nodePromise) {
      if (options.node) {
        nodePromise = Promise.resolve(options.node);
        return options.node;
      }
      const identityOptions: CreateServerIdentityOptions = {
        privateKey: options.privateKey,
        host: options.host,
        prefix: options.prefix,
        enablePublicSpace: false,
        includeAccountRegistryPermissions: false,
        nodeConfig: options.nodeConfig,
      };
      const created = options.nodeFactory
        ? options.nodeFactory(identityOptions)
        : createServerIdentity(identityOptions).then(
            (identity) => identity.node as unknown as TinyCloudNodeLike,
          );
      nodePromise = created;
      return created;
    }
    return nodePromise;
  }

  return {
    async getSecret(name: string, secretOptions?: SecretScopeOptions): Promise<string> {
      const node = await getNode();
      return readDelegatedSecret(node, delegation, name, secretOptions);
    },
  };
}

export async function readDelegatedSecret(
  node: TinyCloudNodeLike | TinyCloudNode,
  delegation: PortableDelegation,
  name: string,
  options?: SecretScopeOptions,
): Promise<string> {
  const secretKey = resolveSecretPath(name, options).permissionPaths.vault;

  const access = await node.useDelegation(delegation);
  const result = await access.kv.get<unknown>(secretKey, { raw: true, prefix: "" });
  if (!result.ok) {
    const message = result.error?.message ?? `failed to read ${secretKey}`;
    throw new Error(`delegated secret ${name} KV get failed: ${message}`);
  }

  const envelope = parseEncryptedEnvelope(
    (result.data as { data?: unknown } | undefined)?.data,
    name,
  );
  const proofCid = access.restorable?.delegationCid ?? access.delegation.cid;
  if (!proofCid) {
    throw new Error(`delegated secret ${name} has no decrypt proof`);
  }

  const decrypted = await node.encryption.decryptEnvelope(envelope, { proofs: [proofCid] });
  if (!decrypted.ok) {
    throw new Error(`delegated secret ${name} decrypt failed: ${decrypted.error.message}`);
  }

  return parseSecretPayload(decrypted.data, name);
}

export function parseDelegation(delegation: DelegationInput): PortableDelegation {
  return typeof delegation === "string" ? deserializeDelegation(delegation) : delegation;
}

export function parseEncryptedEnvelope(
  rawEnvelope: unknown,
  name = "secret",
): InlineEncryptedEnvelope {
  const parsed = typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).v !== "number" ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).networkId !== "string" ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).ciphertext !== "string" ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).encryptedSymmetricKey !== "string"
  ) {
    throw new Error(`delegated secret ${name} did not contain an encrypted envelope`);
  }
  return parsed as InlineEncryptedEnvelope;
}

export function parseSecretPayload(plaintext: Uint8Array, name = "secret"): string {
  let parsed: { value?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { value?: unknown };
  } catch {
    throw new Error(`delegated secret ${name} did not contain valid JSON`);
  }
  if (typeof parsed.value !== "string") {
    throw new Error(`delegated secret ${name} did not contain a string value`);
  }
  return parsed.value;
}
