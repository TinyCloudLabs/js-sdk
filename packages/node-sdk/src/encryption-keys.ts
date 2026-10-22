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
import type { EncryptionCrypto } from "@tinycloud/sdk-services";
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
  signRawNetworkAuthorization(input: {
    targetNode: string;
    networkId: string;
    action: string;
    facts: object;
  }): Promise<{ authorization: string; invocationCid: string }>;
  createEncryptionCrypto(): EncryptionCrypto;
}

export interface CreateNamedKeyClientOptions {
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
    host,
    crypto: signer.createEncryptionCrypto(),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    defaultNetworkId: () => options.networkId ?? node.getDefaultEncryptionNetworkId(),
    signInvocation: (input) =>
      signer.signRawNetworkAuthorization({
        targetNode: input.targetNode,
        networkId: input.resource,
        action: input.action,
        facts: input.facts,
      }),
    decryptRoot: (envelope) => {
      const delegationCid = node.session?.delegationCid;
      if (delegationCid === undefined) {
        return Promise.reject(new Error("Not signed in. Call signIn() first."));
      }
      return node.encryption.decryptEnvelope(envelope, { proofs: [delegationCid] });
    },
  };
  return new NamedKeyClient(config);
}
