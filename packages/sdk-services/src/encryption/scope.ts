import { makePkhSpaceId, pkhDid } from "@tinycloud/bootstrap";
import { base64Decode, base64Encode, hexEncode } from "./canonical";
import { parseNetworkId } from "./networkId";
import type { EncryptionCrypto, InlineEncryptedEnvelope } from "./types";

const PKH_OWNER = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/;
const PKH_SPACE = /^tinycloud:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40}):([A-Za-z0-9_-]+)$/;
const NAMED_SECRET_PATH = /^vault\/secrets\/(?:[A-Z][A-Z0-9_]*|scoped\/[a-z0-9-]+\/[A-Z][A-Z0-9_]*)$/;
const SCOPE_TAG = /^[0-9a-f]{64}$/;
const RESOURCE = /^(urn:tinycloud:encryption:did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:[a-z0-9][a-z0-9-]*)\/kv\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ScopedDecryptLocator {
  spaceId: string;
  path: string;
}

export interface ParsedScopedDecryptResource extends ScopedDecryptLocator {
  networkId: string;
}

/** Normalize an owner-owned space before signed requests or KV storage. */
export function canonicalScopedSpaceId(
  networkId: string,
  spaceId: string,
): { networkId: string; spaceId: string } {
  const parsed = parseNetworkId(networkId);
  const owner = PKH_OWNER.exec(parsed.ownerDid);
  const space = PKH_SPACE.exec(spaceId);
  if (!owner || !space) {
    throw new Error("Scoped decrypt requires an owner-owned space");
  }
  const chainId = Number(owner[1]);
  const spaceChainId = Number(space[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(spaceChainId) || spaceChainId !== chainId) {
    throw new Error("Scoped decrypt space and network chain IDs differ");
  }
  const ownerDid = pkhDid(owner[2]!, chainId);
  const canonicalSpaceId = makePkhSpaceId(space[2]!, spaceChainId, space[3]!);
  if (!canonicalSpaceId.startsWith(`tinycloud:${ownerDid.slice(4)}:`)) {
    throw new Error("Scoped decrypt space is not owned by the encryption network owner");
  }
  return {
    networkId: `urn:tinycloud:encryption:${ownerDid}:${parsed.name}`,
    spaceId: canonicalSpaceId,
  };
}

export function canonicalScopedDecryptLocator(
  networkId: string,
  locator: ScopedDecryptLocator,
): ParsedScopedDecryptResource {
  if (!NAMED_SECRET_PATH.test(locator.path)) throw new Error("Scoped decrypt requires an exact named-secret key");
  return { ...canonicalScopedSpaceId(networkId, locator.spaceId), path: locator.path };
}

export function buildScopedDecryptResource(networkId: string, locator: ScopedDecryptLocator): string {
  const canonical = canonicalScopedDecryptLocator(networkId, locator);
  const space = base64Encode(encoder.encode(canonical.spaceId)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const path = base64Encode(encoder.encode(canonical.path)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${canonical.networkId}/kv/${space}/${path}`;
}

/** Do not accept alternate encodings of the same authority-bearing resource. */
export function parseScopedDecryptResource(resource: string): ParsedScopedDecryptResource {
  const match = RESOURCE.exec(resource);
  if (!match) throw new Error("Invalid scoped decrypt resource");
  const decode = (segment: string): string => {
    if (segment.length % 4 === 1) throw new Error("Invalid scoped decrypt base64url");
    const standard = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const bytes = base64Decode(standard);
    const decoded = decoder.decode(bytes);
    if (base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== segment) {
      throw new Error("Noncanonical scoped decrypt base64url");
    }
    return decoded;
  };
  const locator = { spaceId: decode(match[2]!), path: decode(match[3]!) };
  const canonical = canonicalScopedDecryptLocator(match[1]!, locator);
  if (canonical.networkId !== match[1] || canonical.spaceId !== locator.spaceId) {
    throw new Error("Noncanonical scoped decrypt owner or space");
  }
  return canonical;
}

/**
 * Typed containment for raw encryption resources. A legacy bare root covers
 * exact children on its network; a scoped grant covers only itself.
 */
export function decryptResourceContains(granted: string, requested: string): boolean {
  try {
    const grantedScope = granted.includes("/kv/") ? parseScopedDecryptResource(granted) : undefined;
    const requestedScope = requested.includes("/kv/") ? parseScopedDecryptResource(requested) : undefined;
    if (grantedScope !== undefined) {
      return requestedScope !== undefined && granted === requested;
    }
    const root = canonicalBareNetworkResource(granted);
    return requestedScope === undefined
      ? root === canonicalBareNetworkResource(requested)
      : root === requestedScope.networkId;
  } catch {
    return false;
  }
}

function canonicalBareNetworkResource(resource: string): string {
  const parsed = parseNetworkId(resource);
  const owner = PKH_OWNER.exec(parsed.ownerDid);
  if (owner === null) return parsed.networkId;
  const chainId = Number(owner[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid network owner chain ID");
  return `urn:tinycloud:encryption:${pkhDid(owner[2]!, chainId)}:${parsed.name}`;
}


/** HMAC-SHA256 over the exact stored ciphertext string and server locator. */
export function computeScopeTag(
  crypto: Pick<EncryptionCrypto, "sha256">,
  symmetricKey: Uint8Array,
  envelope: Pick<InlineEncryptedEnvelope, "networkId" | "alg" | "keyVersion" | "ciphertext">,
  locator: ScopedDecryptLocator,
): string {
  if (symmetricKey.length !== 32) throw new Error("Scoped decrypt key must be 32 bytes");
  const canonical = canonicalScopedDecryptLocator(envelope.networkId, locator);
  if (canonical.networkId !== envelope.networkId) throw new Error("Noncanonical scoped network ID");
  const message = encoder.encode(
    `tinycloud.decrypt-scope/v1\n${envelope.networkId}\n${canonical.spaceId}\n${canonical.path}\n${envelope.alg}\n${envelope.keyVersion}\n${envelope.ciphertext}`,
  );
  const innerPad = new Uint8Array(64 + message.length);
  const outerPad = new Uint8Array(96);
  for (let i = 0; i < 64; i++) {
    const byte = symmetricKey[i] ?? 0;
    innerPad[i] = byte ^ 0x36;
    outerPad[i] = byte ^ 0x5c;
  }
  innerPad.set(message, 64);
  outerPad.set(crypto.sha256(innerPad), 64);
  return hexEncode(crypto.sha256(outerPad));
}

export function scopeTagMatches(expected: string | undefined, actual: string): boolean {
  if (expected === undefined || !SCOPE_TAG.test(expected) || actual.length !== 64) return false;
  let mismatch = 0;
  for (let i = 0; i < 64; i++) mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}

export function isNamedSecretPath(path: string): boolean {
  return NAMED_SECRET_PATH.test(path);
}
