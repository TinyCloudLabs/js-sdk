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
import type { ServiceSession, EncryptionCrypto } from "@tinycloud/sdk-services";
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

interface NodeSigningInternals {
  readonly _serviceGraph: { assertActive(): void };
  readonly _serviceContext?: { session: ServiceSession | null };
  readonly config?: { keyWrapV2?: boolean; requireKeyWrapV2?: boolean };
  signRawNetworkAuthorization(input: {
    targetNode: string;
    networkId: string;
    action: string;
    facts: object;
  }, binding?: { graph: { assertActive(): void }; session: ServiceSession }): Promise<{ authorization: string; invocationCid: string }>;
  createEncryptionCrypto(): EncryptionCrypto;
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
  const internals = node as unknown as Partial<NodeSigningInternals>;
  for (const hook of ["signRawNetworkAuthorization", "createEncryptionCrypto"] as const) {
    if (typeof internals[hook] !== "function") {
      throw new NamedKeyError(
        "NODE_HOOK_MISSING",
        `TinyCloudNode.${hook} is not available; named keys cannot sign invocations`,
      );
    }
  }
  const signer = internals as NodeSigningInternals;
  const host = node.hosts[0];
  if (host === undefined) throw new Error("TinyCloud node host has not been resolved");
  const config: NamedKeyClientConfig = {
    keyWrapV2: options.keyWrapV2 ?? signer.config?.keyWrapV2 ?? false,
    requireKeyWrapV2: options.requireKeyWrapV2 ?? signer.config?.requireKeyWrapV2 ?? false,
    host,
    crypto: signer.createEncryptionCrypto(),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    defaultNetworkId: () => options.networkId ?? node.getDefaultEncryptionNetworkId(),
    captureOperation: () => {
      const graph = signer._serviceGraph;
      graph.assertActive();
      const session = signer._serviceContext?.session ?? node.session;
      let networkId = options.networkId;
      let encryption: TinyCloudNode["encryption"] | undefined;
      return {
        ...config,
        captureOperation: undefined,
        assertActive: () => graph.assertActive(),
        defaultNetworkId: () => {
          graph.assertActive();
          // Calls that need a default resolve it synchronously at entry. Explicit
          // networks and envelope-only decrypts never consult the node default.
          return networkId ??= node.getDefaultEncryptionNetworkId();
        },
        signInvocation: (input) => {
          graph.assertActive();
          if (!session) throw new Error("Not signed in. Call signIn() first.");
          return signer.signRawNetworkAuthorization({
            targetNode: input.targetNode,
            networkId: input.resource,
            action: input.action,
            facts: input.facts,
          }, { graph, session });
        },
        decryptRoot: async (envelope) => {
          graph.assertActive();
          if (!session) throw new Error("Not signed in. Call signIn() first.");
          encryption ??= node.encryption;
          const result = await encryption.decryptEnvelope(envelope, { proofs: [session.delegationCid] });
          graph.assertActive();
          return result;
        },
      };
    },
    // Public entry points replace these hooks with a captured operation first.
    signInvocation: () => { throw new Error("Named-key operation was not captured"); },
  };
  return new NamedKeyClient(config);
}
