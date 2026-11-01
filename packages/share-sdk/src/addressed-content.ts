import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalize, fromBase64Url, type UnifiedContentSource } from "@tinycloud/share-envelope";

/**
 * Path-bound addressed content (TC-2242). An addressed share encrypts its content under ONE named key,
 * `share/<shareId>` on the owner's default encryption network, and registers that key's wrapped-key digest. The node
 * refuses a new registration without both (`content-source-key-path-required`, `content-source-key-digest-required`) and
 * opens only that one key, never the network. This module is the single place that derives the path, validates the
 * network, serializes the stored envelope and computes the digests, so no consumer hand-writes any of them.
 *
 * Call sequence: `planPathBoundShare` (before anything is written) -> the caller holds the plan's `requiredPermissions`
 * -> `encryptAddressedShareContent` (or the caller's own `keys.createKey` + `keys.encrypt`) -> upload `storedBytes` ->
 * `bindPathBoundContentSource` -> `publishAddressedShare`.
 */

export type AddressedContentSourceErrorCode =
  | "share-id-invalid"
  | "network-invalid"
  | "network-not-checksummed"
  | "key-path-required"
  | "key-path-mismatch"
  | "digest-invalid"
  | "key-not-authorized"
  | "key-receipt-mismatch"
  | "envelope-invalid"
  | "stored-bytes-mismatch";

/** A path-bound source could not be planned, built or accepted. Match on `code`, not the message or `instanceof`. */
export class AddressedContentSourceError extends TypeError {
  readonly code: AddressedContentSourceErrorCode;
  constructor(code: AddressedContentSourceErrorCode, message: string) {
    super(message);
    this.name = "AddressedContentSourceError";
    this.code = code;
  }
}

/** The content source of an addressed share: a `UnifiedContentSource` that is bound to its one key. */
export type PathBoundContentSource = UnifiedContentSource & {
  readonly encryptionKeyPath: string;
  readonly encryptedSymmetricKeyDigestHex: string;
};

/** The shape of a `PermissionEntry` (`@tinycloud/sdk-core`): hand it to `requestPermissions` or a manifest as is. */
export interface PathBoundPermissionEntry {
  service: "tinycloud.encryption";
  path: string;
  actions: string[];
}

// The node's key-path grammar for the `share/<id>` segment (key_id.rs valid_segment): first byte a lowercase letter or digit, then lowercase
// letters, digits, `.`, `_`, `-`; at most 64 bytes. 16 is this SDK's own minimum share id length.
const SHARE_ID = /^[a-z0-9][a-z0-9._-]{15,63}$/;
const NETWORK = /^urn:tinycloud:encryption:(did:[^/\s]+):default$/;
const PKH_EIP155 = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const textEncoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** EIP-55 mixed-case form of an Ethereum address (the node's key and prefix resources require it). */
function checksumAddress(address: string): string {
  const lower = address.toLowerCase().slice(2);
  const hash = keccak_256(textEncoder.encode(lower));
  let out = "0x";
  for (let index = 0; index < lower.length; index++) {
    const nibble = (hash[index >> 1]! >> (index % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? lower[index]!.toUpperCase() : lower[index]!;
  }
  return out;
}

/** The key path every addressed share is encrypted under: `share/<shareId>`. */
export function pathBoundKeyPath(shareId: string): string {
  if (typeof shareId !== "string" || !SHARE_ID.test(shareId)) {
    throw new AddressedContentSourceError("share-id-invalid", "addressed share id is invalid: 16 to 64 characters, lowercase letters, digits, '.', '_' or '-', starting with a letter or digit (a lowercase UUID, hyphens included, is valid)");
  }
  return `share/${shareId}`;
}

/**
 * The owner's default encryption network URN with the EIP-55 checksummed address, which is the only spelling the node
 * accepts for key and prefix resources. Pure. Accepts the owner DID (`did:pkh:eip155:<chain>:<address>`, any case), or just the
 * owner's address (a string `0x...`, or `{ address, chainId? }`; chain id defaults to 1), so a caller never writes the spelling.
 */
export function defaultEncryptionNetworkForOwner(owner: string | { readonly address: string; readonly chainId?: number }): string {
  let did: unknown = owner;
  const address = typeof owner === "string" ? (/^0x[0-9a-fA-F]{40}$/.test(owner) ? owner : undefined) : owner?.address;
  if (address !== undefined) {
    const chainId = typeof owner === "string" ? 1 : owner.chainId ?? 1;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isSafeInteger(chainId) || chainId < 1) {
      throw new AddressedContentSourceError("network-invalid", "owner address is not an Ethereum address");
    }
    did = `did:pkh:eip155:${chainId}:${address}`;
  }
  const pkh = typeof did === "string" ? PKH_EIP155.exec(did) : null;
  const normalized = pkh === null ? did : `did:pkh:eip155:${pkh[1]}:${checksumAddress(pkh[2]!)}`;
  const network = `urn:tinycloud:encryption:${String(normalized)}:default`;
  if (typeof normalized !== "string" || !NETWORK.test(network)) {
    throw new AddressedContentSourceError("network-invalid", "owner does not name an encryption network");
  }
  return network;
}

function assertNetwork(network: unknown): string {
  const match = typeof network === "string" ? NETWORK.exec(network) : null;
  if (match === null) {
    throw new AddressedContentSourceError("network-invalid", "encryption network must be the owner's default network: urn:tinycloud:encryption:<did>:default");
  }
  const pkh = PKH_EIP155.exec(match[1]!);
  if (pkh !== null && pkh[2] !== checksumAddress(pkh[2]!)) {
    throw new AddressedContentSourceError("network-not-checksummed", "encryption network address must be EIP-55 checksummed; use defaultEncryptionNetworkForOwner(ownerDid)");
  }
  return network as string;
}

function decodeWrappedKey(encryptedSymmetricKey: unknown): Uint8Array {
  if (typeof encryptedSymmetricKey !== "string" || !BASE64.test(encryptedSymmetricKey)) {
    throw new AddressedContentSourceError("envelope-invalid", "wrapped content key is not strict base64");
  }
  try {
    // The shared strict decoder also rejects nonzero trailing pad bits.
    return fromBase64Url(encryptedSymmetricKey.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
  } catch {
    throw new AddressedContentSourceError("envelope-invalid", "wrapped content key is not strict base64");
  }
}

/** The digest a path-bound source registers: SHA-256 of the DECODED wrapped-key bytes (the node and the recipient compare exactly this). */
export function wrappedKeyDigestHex(encryptedSymmetricKey: string): string {
  return hex(sha256(decodeWrappedKey(encryptedSymmetricKey)));
}

function canonicalKeyHashHex(encryptedSymmetricKey: string): string {
  return hex(sha256(textEncoder.encode(canonicalize(encryptedSymmetricKey))));
}

/** What a consumer needs to encrypt, upload and bind one addressed share's content. */
export interface PathBoundSharePlan {
  readonly shareId: string;
  readonly encryptionNetwork: string;
  /** `share/<shareId>`: the named key the content is encrypted under. */
  readonly keyPath: string;
  /** `<network>/share/<shareId>`: the one decrypt resource the share grants. */
  readonly keyResource: string;
  /** The owner session must hold these before the key is created: `key.create` on exactly this share's key. */
  readonly requiredPermissions: PathBoundPermissionEntry[];
  /** The owner session must hold these for the node to register the policy: decrypt under `<network>/share/`. */
  readonly registrationPermissions: PathBoundPermissionEntry[];
  /** Options for `keys.encrypt(plan.keyPath, plaintext, plan.encryptOptions({ metadata }))`. */
  encryptOptions(extra?: { readonly metadata?: Readonly<Record<string, string>> }): { networkId: string; metadata?: Record<string, string> };
}

/** Validate the share id and network and derive the key path and the permissions the share needs. Writes and signs nothing. */
export function planPathBoundShare(input: { readonly shareId: string; readonly encryptionNetwork: string }): PathBoundSharePlan {
  const keyPath = pathBoundKeyPath(input.shareId);
  const encryptionNetwork = assertNetwork(input.encryptionNetwork);
  const keyResource = `${encryptionNetwork}/${keyPath}`;
  return {
    shareId: input.shareId,
    encryptionNetwork,
    keyPath,
    keyResource,
    requiredPermissions: [{ service: "tinycloud.encryption", path: keyResource, actions: ["tinycloud.encryption/key.create"] }],
    registrationPermissions: [{ service: "tinycloud.encryption", path: `${encryptionNetwork}/share/`, actions: ["tinycloud.encryption/decrypt"] }],
    encryptOptions: (extra) => ({ networkId: encryptionNetwork, ...(extra?.metadata === undefined ? {} : { metadata: { ...extra.metadata } }) }),
  };
}

/** The v2 envelope a named key's `encrypt` returns: the fields this module reads. Every other field it returns (ciphertext, alg, aad, metadata) is kept in the stored bytes. */
export interface PathBoundEnvelope {
  readonly v: number;
  readonly networkId: string;
  readonly keyPath: string;
  readonly keyVersion: number;
  readonly encryptedSymmetricKey: string;
  readonly encryptedSymmetricKeyHash: string;
}

/** The exact bytes to upload: the canonical JSON of the v2 envelope. Nothing else is stored. */
export function pathBoundStoredBytes(envelope: PathBoundEnvelope): Uint8Array {
  return textEncoder.encode(canonicalize(envelope as unknown as Record<string, unknown>));
}

function assertEnvelope(plan: PathBoundSharePlan, envelope: PathBoundEnvelope): void {
  if (envelope === null || typeof envelope !== "object" || envelope.v !== 2) {
    throw new AddressedContentSourceError("envelope-invalid", "path-bound content must be a v2 named-key envelope (encrypt with keys.encrypt, not encryptToNetwork)");
  }
  if (envelope.networkId !== plan.encryptionNetwork || envelope.keyPath !== plan.keyPath) {
    throw new AddressedContentSourceError("key-path-mismatch", "envelope network or key path does not match the share's plan");
  }
  if (!Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) {
    throw new AddressedContentSourceError("envelope-invalid", "envelope key version is invalid");
  }
  wrappedKeyDigestHex(envelope.encryptedSymmetricKey);
  if (envelope.encryptedSymmetricKeyHash !== canonicalKeyHashHex(envelope.encryptedSymmetricKey)) {
    throw new AddressedContentSourceError("envelope-invalid", "envelope key hash does not match its wrapped key");
  }
}

/**
 * The content source for an encrypted and uploaded share. `envelope` is what `keys.encrypt` returned, `storedBytes` the
 * exact bytes uploaded (`pathBoundStoredBytes(envelope)`), `kvResource` where they now live (`<space>/kv/<path>`).
 * Derives the path, the raw-byte wrapped-key digest, the ciphertext digest and the key version; nothing is taken on trust.
 */
export function bindPathBoundContentSource(input: {
  readonly plan: PathBoundSharePlan;
  readonly envelope: PathBoundEnvelope;
  readonly storedBytes: Uint8Array;
  readonly kvResource: string;
  readonly selector: "exact" | "prefix";
}): PathBoundContentSource {
  const { plan, envelope } = input;
  assertEnvelope(plan, envelope);
  const expected = pathBoundStoredBytes(envelope);
  if (input.storedBytes.length !== expected.length || input.storedBytes.some((byte, index) => byte !== expected[index])) {
    throw new AddressedContentSourceError("stored-bytes-mismatch", "uploaded bytes are not the canonical v2 envelope; upload pathBoundStoredBytes(envelope)");
  }
  return {
    shareId: plan.shareId,
    kvResource: input.kvResource,
    selector: input.selector,
    encryptionNetwork: plan.encryptionNetwork,
    encryptionKeyPath: plan.keyPath,
    encryptedSymmetricKeyDigestHex: wrappedKeyDigestHex(envelope.encryptedSymmetricKey),
    keyVersion: envelope.keyVersion,
    mode: "immutable",
    initialCiphertextDigestHex: hex(sha256(expected)),
  };
}

/** The part of a named-key client (`NamedKeyClient`, web `tcw.keys`, node `node.keys`) this module calls. */
export interface AddressedShareKeyClient {
  createKey(path: string, options: { networkId: string }): Promise<{ readonly networkId: string; readonly keyPath: string; readonly state?: string; readonly keyVersion?: number }>;
  encrypt(path: string, plaintext: Uint8Array, options: { networkId: string; metadata?: Record<string, string> }): Promise<PathBoundEnvelope>;
}

/** What `encryptAddressedShareContent` returns: the envelope and the exact bytes to upload. */
export interface EncryptedAddressedContent {
  readonly envelope: PathBoundEnvelope;
  readonly storedBytes: Uint8Array;
  readonly byteLength: number;
}

function isUnauthorized(error: unknown): boolean {
  const value = error as { readonly status?: unknown; readonly code?: unknown } | null;
  return value !== null && typeof value === "object" && (value.status === 401 || value.status === 403 || value.code === "PERMISSION_DENIED" || value.code === "AUTH_UNAUTHORIZED");
}

/**
 * Create the share's named key and encrypt the content under it. Built from the same steps a consumer may run itself
 * (`keys.createKey`, `keys.encrypt`, then `bindPathBoundContentSource`). The key-create capability in
 * `plan.requiredPermissions` must already be held; an unauthorized answer is reported as `key-not-authorized` naming it.
 */
export async function encryptAddressedShareContent(input: {
  readonly plan: PathBoundSharePlan;
  readonly keys: AddressedShareKeyClient;
  readonly plaintext: Uint8Array;
  readonly metadata?: Readonly<Record<string, string>>;
}): Promise<EncryptedAddressedContent> {
  const { plan, keys } = input;
  // Read before encrypting: the caller owns the buffer and may zero it (`fill(0)`) as soon as this returns; it is never retained or transferred.
  const byteLength = input.plaintext.byteLength;
  let receipt;
  try {
    receipt = await keys.createKey(plan.keyPath, { networkId: plan.encryptionNetwork });
  } catch (error) {
    if (isUnauthorized(error)) {
      const status = (error as { readonly status?: unknown }).status;
      throw new AddressedContentSourceError(
        "key-not-authorized",
        `the owner session does not hold tinycloud.encryption/key.create on ${plan.keyResource} (the node answers "Unauthorized Action: ${plan.keyResource} / tinycloud.encryption/key.create"); request plan.requiredPermissions (requestPermissions) before creating the key` +
          (status === 403 ? "; if the owner signs in through OpenKey, the request must come from a first-party TinyCloud origin" : ""),
      );
    }
    throw error;
  }
  if (receipt.networkId !== plan.encryptionNetwork || receipt.keyPath !== plan.keyPath || (receipt.state !== undefined && receipt.state !== "active")) {
    throw new AddressedContentSourceError("key-receipt-mismatch", "the created key does not match this share");
  }
  const envelope = await keys.encrypt(plan.keyPath, input.plaintext, plan.encryptOptions(input.metadata === undefined ? undefined : { metadata: input.metadata }));
  assertEnvelope(plan, envelope);
  if (receipt.keyVersion !== undefined && envelope.keyVersion !== receipt.keyVersion) {
    throw new AddressedContentSourceError("key-receipt-mismatch", "the envelope key version does not match the created key");
  }
  const storedBytes = pathBoundStoredBytes(envelope);
  return { envelope, storedBytes, byteLength };
}

/**
 * The publisher's gate: a content source must be bound to its own share's key, with a registered wrapped-key digest,
 * before anything is signed, registered or written. There is no network-scope fallback.
 */
export function assertPathBoundContentSource(source: Partial<UnifiedContentSource> | undefined, shareId: string): asserts source is PathBoundContentSource {
  if (source === undefined || source === null || typeof source !== "object") {
    throw new AddressedContentSourceError("key-path-required", "addressed content source is missing");
  }
  if (source.encryptionKeyPath === undefined) {
    throw new AddressedContentSourceError("key-path-required", "addressed content source must name its key (encryptionKeyPath: share/<shareId>); a network-wide source is not accepted");
  }
  if (source.encryptionKeyPath !== pathBoundKeyPath(shareId)) {
    throw new AddressedContentSourceError("key-path-mismatch", "addressed content source key path must be share/<shareId> of this share");
  }
  if (typeof source.encryptedSymmetricKeyDigestHex !== "string" || !HEX_DIGEST.test(source.encryptedSymmetricKeyDigestHex)) {
    throw new AddressedContentSourceError("digest-invalid", "addressed content source needs encryptedSymmetricKeyDigestHex: 64 lowercase hex characters");
  }
  if (typeof source.encryptionNetwork !== "string" || !NETWORK.test(source.encryptionNetwork)) {
    throw new AddressedContentSourceError("network-invalid", "addressed content source network must be the owner's default network");
  }
}
