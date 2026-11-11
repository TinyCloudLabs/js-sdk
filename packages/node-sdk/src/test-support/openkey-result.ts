// Test-only helpers for simulating an OpenKey approval that returns a signed message the SDK did not prepare.
// Nothing here talks to OpenKey: the signature is made with a local signer.

import {
  extractRecapAttenuations,
  parseCanonicalRecapResource,
} from "@tinycloud/sdk-core";
import type { OpenKeyAuthorizationResultV1 } from "../authorization/NodeUserAuthorization";

interface MessageSigner {
  signMessage(message: string): Promise<string>;
  getAddress(): Promise<string>;
}

/** Canonical four-part OpenKey action ids for every non-required capability in a SIWE. */
export function selectedActionKeysFor(siwe: string): string[] {
  const out: string[] = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    for (const ability of Object.keys(actions)) {
      if (ability === "tinycloud.capabilities/read" || ability === "capabilities/read") continue;
      const slash = ability.indexOf("/");
      out.push(`${slash > 0 ? ability.slice(0, slash) : ""}\0${space}\0${path}\0${ability}`);
    }
  }
  return out;
}

/** The effective grants a SIWE encodes, grouped by resource and service. */
export function permissionsFor(siwe: string): OpenKeyAuthorizationResultV1["permissions"] {
  const out: OpenKeyAuthorizationResultV1["permissions"] = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const byService = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const slash = ability.indexOf("/");
      const service = slash > 0 ? ability.slice(0, slash) : "";
      byService.set(service, [...(byService.get(service) ?? []), ability]);
    }
    for (const [service, abilities] of byService) out.push({ service, space, path, actions: abilities });
  }
  return out;
}

/** A SIWE with its `Expiration Time` replaced, the way OpenKey regenerates it when the user changes the expiry. */
export function withExpiration(siwe: string, expirationTime: string): string {
  const next = siwe.replace(/^Expiration Time: .*$/m, `Expiration Time: ${expirationTime}`);
  if (next === siwe && !siwe.includes(`Expiration Time: ${expirationTime}`)) {
    throw new Error("prepared SIWE has no Expiration Time line to replace");
  }
  return next;
}

/** The rich result OpenKey returns for `signedMessage`, signed by `signer`. */
export async function richResultFor(
  signer: MessageSigner,
  signedMessage: string,
): Promise<OpenKeyAuthorizationResultV1> {
  return {
    protocolVersion: 1,
    address: await signer.getAddress(),
    signature: await signer.signMessage(signedMessage),
    signedMessage,
    selectedActionKeys: selectedActionKeysFor(signedMessage),
    permissions: permissionsFor(signedMessage),
  };
}
