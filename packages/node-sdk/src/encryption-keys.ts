/**
 * Named encryption keys for a signed-in {@link TinyCloudNode}.
 *
 * Lives on its own subpath (`@tinycloud/node-sdk/encryption-keys`) so the
 * default root bundle does not carry it. Everything is dark unless the node's
 * `/info` `features` lists `encryption-named-keys-v1`; see the client in
 * `@tinycloud/sdk-services/encryption/named-keys` for the rules.
 *
 * The client signs through the node's existing raw-resource invocation path
 * (the same one network admin and decrypt use) and reuses its encryption
 * crypto, so both are reached through a narrow structural view of the node.
 */

import {
  NamedKeyClient,
  NamedKeyError,
  type NamedKeyClientConfig,
} from "@tinycloud/sdk-services/encryption/named-keys";
import { DECRYPT_ACTION } from "@tinycloud/sdk-services";
import type { EncryptionCrypto } from "@tinycloud/sdk-services";
import { KEY_CREATE_ABILITY } from "@tinycloud/sdk-services/encryption/resource";
import type { NamedKeyEnvelope } from "@tinycloud/sdk-services/encryption/named-keys";
import {
  verifyExactAppKeyProof,
  type ExactAppKeyProof,
  type ExactAppKeyRequest,
} from "./exact-app-key-proof.js";
import type { TinyCloudNode } from "./TinyCloudNode";

export {
  NamedKeyClient,
  NamedKeyError,
  buildKeyAdminFacts,
  buildKeyDescribeFacts,
  type DecryptManyResult,
  type KeyCallOptions,
  type KeyDescriptor,
  type KeyEncryptOptions,
  type NamedKeyEnvelope,
  type NamedKeyErrorCode,
  type PublicKeyDescriptor,
} from "@tinycloud/sdk-services/encryption/named-keys";

export {
  EXACT_APP_KEY_MAX_LIFETIME_MS,
  buildExactAppKeyProof,
  prepareExactAppKeyRequest,
  verifyExactAppKeyProof,
  type ExactAppKeyApproval,
  type ExactAppKeyProof,
  type ExactAppKeyRequest,
  type PreparedExactAppKeyRequest,
} from "./exact-app-key-proof.js";

interface NodeSigningInternals {
  readonly config?: { keyWrapV2?: boolean; requireKeyWrapV2?: boolean };
  signRawNetworkAuthorization(input: {
    targetNode: string;
    networkId: string;
    action: string;
    facts: object;
  }, binding?: NamedKeySessionBinding): Promise<{ authorization: string; invocationCid: string }>;
  createEncryptionCrypto(): EncryptionCrypto;
  /** Registry route for the network, mapped to the TEE origin and identity-checked there. */
  encryptionDestination(networkId: string): Promise<{ url: string; nodeDid: string }>;
}

/**
 * @internal A delegated session the client signs with exactly (TC-3284), as
 * `TinyCloudNode.signRawNetworkAuthorization`'s binding.
 */
export interface NamedKeySessionBinding {
  graph: { assertActive(): void };
  session: { delegationCid: string };
  exactSession: true;
}

export interface CreateNamedKeyClientOptions {
  /** Write TCW2 named-key wraps. Disabled by default. */
  keyWrapV2?: boolean;
  /** Require TCW2 incoming network-key wraps. Disabled by default. */
  requireKeyWrapV2?: boolean;
  /** Network used when a call does not name one. Defaults to the node's default network. */
  networkId?: string;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
  /**
   * @internal Sign every call with exactly this delegated session, never the
   * node's own; the network root key is refused. Used by a delegated vault.
   */
  binding?: NamedKeySessionBinding;
}

/**
 * Build a named-key client bound to a signed-in node.
 *
 * `signInvocation` passes the EXACT key URN as the invocation's single
 * resource (the signer's `networkId` argument is the capability `with`); the
 * real network id travels in the facts.
 */
export function createNamedKeyClient(
  node: TinyCloudNode,
  options: CreateNamedKeyClientOptions = {},
): NamedKeyClient {
  const signer = namedKeyHooks(node);
  const resolvedHost = node.hosts[0];
  if (resolvedHost === undefined) throw new Error("TinyCloud node host has not been resolved");
  // Key calls carry public keys and key admin, so each network's calls go to
  // its own registry route on the node's TEE-terminated origin, after the
  // same identity check as other encryption calls, and never follow a
  // redirect elsewhere (TC-2923).
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  // Bun's `typeof fetch` also declares `preconnect`, a connection hint with no effect on requests.
  const fetchWithoutRedirects = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => baseFetch(input, { ...init, redirect: "error" }),
    { preconnect: () => {} },
  ) as typeof fetch;
  const config: NamedKeyClientConfig = {
    keyWrapV2: options.keyWrapV2 ?? signer.config?.keyWrapV2 ?? false,
    requireKeyWrapV2: options.requireKeyWrapV2 ?? signer.config?.requireKeyWrapV2 ?? false,
    // Not used for requests: `resolveNode` supplies every call's origin. Importing the
    // sdk-core root for a mapping here would pull it into the lazy encryption-keys chunk.
    host: resolvedHost,
    resolveNode: async (networkId) => {
      const { url, nodeDid } = await signer.encryptionDestination(networkId);
      return { url, nodeDid };
    },
    crypto: signer.createEncryptionCrypto(),
    fetch: fetchWithoutRedirects,
    defaultNetworkId: () => options.networkId ?? node.getDefaultEncryptionNetworkId(),
    signInvocation: (input) =>
      signer.signRawNetworkAuthorization({
        targetNode: input.targetNode,
        networkId: input.resource,
        action: input.action,
        facts: input.facts,
      }, options.binding),
    decryptRoot: (envelope) => {
      const delegationCid = node.session?.delegationCid;
      if (options.binding !== undefined || delegationCid === undefined) {
        return Promise.reject(new Error(options.binding === undefined
          ? "Not signed in. Call signIn() first."
          : "A delegated named-key client never opens the network root key"));
      }
      return node.encryption.decryptEnvelope(envelope, { proofs: [delegationCid] });
    },
  };
  return new NamedKeyClient(config);
}

function namedKeyHooks(node: TinyCloudNode): NodeSigningInternals {
  const internals = node as unknown as Partial<NodeSigningInternals>;
  for (const hook of ["signRawNetworkAuthorization", "createEncryptionCrypto", "encryptionDestination"] as const) {
    if (typeof internals[hook] !== "function") {
      throw new NamedKeyError(
        "NODE_HOOK_MISSING",
        `TinyCloudNode.${hook} is not available; named keys cannot sign invocations`,
      );
    }
  }
  return internals as NodeSigningInternals;
}

/** The only operations an approved exact app key allows. */
export interface ExactAppKeyClient {
  readonly expiresAt: string;
  encrypt(plaintext: Uint8Array, aad?: Uint8Array): Promise<NamedKeyEnvelope>;
  decrypt(envelope: NamedKeyEnvelope): Promise<Uint8Array>;
}

/** A raw app-key permit never signs in to a storage space or installs a session. */
export async function openExactAppKeyClient(
  node: TinyCloudNode,
  request: ExactAppKeyRequest,
  proof: ExactAppKeyProof,
): Promise<ExactAppKeyClient> {
  const verified = verifyExactAppKeyProof(request, proof);
  if (!verified.ok) throw new Error(`The saved app-key proof is not usable (${verified.reason}).`);
  const { resource, networkId, expiresAt, sessionDid } = verified;
  const path = request.path;
  const session = {
    delegationCid: proof.delegationCid,
    delegationHeader: { Authorization: proof.delegationHeader.Authorization },
    verificationMethod: sessionDid,
    jwk: structuredClone(request.sessionKey),
    spaceId: proof.spaceId, // Required by WASM serialization, not a signed space.
  };
  const signer = namedKeyHooks(node);
  const destination = await signer.encryptionDestination(networkId);
  const end = Date.parse(expiresAt);
  const assertActive = () => {
    if (Date.now() >= end) throw new Error("The app-key approval has expired.");
  };
  assertActive();
  const response = await fetch(`${destination.url}/delegate`, {
    method: "POST",
    headers: session.delegationHeader,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The node refused this app-key approval (HTTP ${response.status}).`);
  }
  const ack = await response.json() as { cid?: unknown; activated?: unknown; skipped?: unknown } | null;
  if (ack === null || typeof ack !== "object" || ack.cid !== session.delegationCid || !Array.isArray(ack.activated) ||
    ack.activated.length !== 0 || !Array.isArray(ack.skipped) || ack.skipped.length !== 0) {
    throw new Error("The node did not acknowledge the exact app-key approval.");
  }
  assertActive();
  const client = new NamedKeyClient({
    host: destination.url,
    defaultNetworkId: () => networkId,
    resolveNode: async (id) => {
      if (id !== networkId) throw new Error("The app-key approval does not cover that network.");
      return destination;
    },
    keyWrapV2: true,
    crypto: signer.createEncryptionCrypto(),
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, { ...init, redirect: "error" }),
      { preconnect: () => {} },
    ) as typeof fetch,
    signInvocation: (input) => {
      if (input.resource !== resource || input.targetNode !== destination.nodeDid ||
        (input.action !== KEY_CREATE_ABILITY && input.action !== DECRYPT_ACTION)) {
        throw new Error("The app-key approval does not cover that operation.");
      }
      return signer.signRawNetworkAuthorization({
        targetNode: destination.nodeDid, networkId: resource, action: input.action, facts: input.facts,
      }, { graph: { assertActive }, session, exactSession: true });
    },
  });
  return {
    expiresAt,
    async encrypt(plaintext: Uint8Array, aad?: Uint8Array) {
      assertActive();
      return client.encrypt(path, plaintext, { ensureKey: true, ...(aad === undefined ? {} : { aad }) });
    },
    async decrypt(envelope: NamedKeyEnvelope) {
      assertActive();
      if (envelope.v !== 2 || envelope.networkId !== networkId || envelope.keyPath !== path) {
        throw new NamedKeyError("INVALID_ENVELOPE", "This envelope does not use the approved app key.");
      }
      return client.decrypt(envelope);
    },
  };
}
