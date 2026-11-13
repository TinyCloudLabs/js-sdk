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
 * Call sequence: `planPathBoundShare` (before anything is written) -> `encryptAddressedShareContent` (or the caller's own
 * `keys.encrypt`, which encrypts to the key's public key) -> upload `storedBytes` -> `bindPathBoundContentSource` ->
 * `publishAddressedShare`. The node records the share's key when the policy is registered; nothing creates it beforehand.
 */

export type AddressedContentSourceErrorCode =
  | "share-id-invalid"
  | "network-invalid"
  | "network-not-checksummed"
  | "key-path-required"
  | "key-path-mismatch"
  | "digest-invalid"
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

/**
 * The content source of an addressed share: a `UnifiedContentSource` that is bound to its one key. **Build it ONLY with
 * `bindPathBoundContentSource`.** The publisher can check the path, the digest's FORMAT and the network, but it cannot verify that the digest is the
 * raw-byte digest of the wrapped key (a hand-written literal that registers `encryptedSymmetricKeyHash`, the canonical hash of the base64 text, type-checks
 * and publishes, and no recipient or node will ever open it). No runtime brand is used, because two copies of this package must interoperate.
 */
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

// ONE share-id grammar, used by the plan, the key helper, the size bound and the publisher: the INTERSECTION of the node's key-path segment grammar
// (key_id.rs valid_segment: first byte a lowercase letter or digit, then lowercase letters, digits, `.`, `_`, `-`; at most 64 bytes) and the
// publisher's own id alphabet (no `.`). 16 is this SDK's minimum length. An id outside it is refused before anything is encrypted.
const SHARE_ID = /^[a-z0-9][a-z0-9_-]{15,63}$/;
const NETWORK = /^urn:tinycloud:encryption:(.+):default$/;
const OWNER_PKH = /^did:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;
const OWNER_KEY = /^did:key:[A-Za-z0-9]+$/;
const ENVELOPE_FIELDS = ["v", "networkId", "keyPath", "alg", "keyVersion", "encryptedSymmetricKey", "encryptedSymmetricKeyHash", "ciphertext", "aad", "metadata"];
const ENVELOPE_ALG = "x25519-aes256gcm/v1";
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
    throw new AddressedContentSourceError("share-id-invalid", "addressed share id is invalid: 16 to 64 characters from lowercase letters, digits, '_' and '-', starting with a letter or digit (a lowercase UUID, hyphens included, is valid)");
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
  const pkh = typeof did === "string" ? OWNER_PKH.exec(did) : null;
  const normalized = pkh === null ? did : `did:pkh:eip155:${pkh[1]}:${checksumAddress(pkh[2]!)}`;
  const network = `urn:tinycloud:encryption:${String(normalized)}:default`;
  if (typeof normalized !== "string" || !(pkh !== null || OWNER_KEY.test(normalized))) {
    throw new AddressedContentSourceError("network-invalid", "owner does not name an encryption network");
  }
  return network;
}

/**
 * The strict form of the owner's default encryption network: `urn:tinycloud:encryption:<owner>:default` with `<owner>` either
 * `did:pkh:eip155:<chain, no leading zero>:<0x + 40 hex, EIP-55 checksummed>` or `did:key:<alphanumeric, no `:`>`. Anything else (another
 * network name, an extra `:` segment, a lower-cased or `0X` address, another DID method) is refused with a specific code.
 */
export function assertEncryptionNetwork(network: unknown): string {
  const match = typeof network === "string" ? NETWORK.exec(network) : null;
  if (match === null) {
    throw new AddressedContentSourceError("network-invalid", "encryption network must be the owner's default network: urn:tinycloud:encryption:<did>:default");
  }
  const owner = match[1]!;
  const pkh = OWNER_PKH.exec(owner);
  if (pkh !== null) {
    if (pkh[2] !== checksumAddress(pkh[2]!)) {
      throw new AddressedContentSourceError("network-not-checksummed", "encryption network address must be EIP-55 checksummed; use defaultEncryptionNetworkForOwner(ownerDid)");
    }
  } else if (!OWNER_KEY.test(owner)) {
    throw new AddressedContentSourceError("network-invalid", "encryption network owner must be a did:pkh:eip155 address or a did:key");
  }
  return network as string;
}

const assertNetwork = assertEncryptionNetwork;

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

/** Strict base64 (padded, standard alphabet, zero trailing pad bits), as the recipient decodes; throws `envelope-invalid`. */
function decodeBase64(value: string): Uint8Array {
  try {
    return fromBase64Url(value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
  } catch {
    throw new AddressedContentSourceError("envelope-invalid", "envelope field is not strict base64");
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
  /** The owner session must hold these for the node to register the policy: decrypt on this exact share key. */
  readonly registrationPermissions: PathBoundPermissionEntry[];
  /** Options for `keys.encrypt(plan.keyPath, plaintext, plan.encryptOptions({ metadata }))`. */
  encryptOptions(extra?: { readonly metadata?: Readonly<Record<string, string>> }): { networkId: string; metadata?: Record<string, string> };
}

/**
 * The manifest entries that let one session register every share's policy: `decrypt` on the default network's `<network>/share/` prefix.
 * Needs no share id, so an app builds its sign-in manifest before any share exists. Put the result in `manifest.permissions`.
 */
export function pathBoundSessionPermissions(input: { readonly encryptionNetwork: string }): PathBoundPermissionEntry[] {
  const encryptionNetwork = assertNetwork(input.encryptionNetwork);
  return [{ service: "tinycloud.encryption", path: `${encryptionNetwork}/share/`, actions: ["tinycloud.encryption/decrypt"] }];
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
    registrationPermissions: [{ service: "tinycloud.encryption", path: keyResource, actions: ["tinycloud.encryption/decrypt"] }],
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
  // Mirror what the recipient checks before it opens the content (recipient.ts parseV3InlineEncryptedEnvelope), so a share it would refuse is
  // refused here, before it is uploaded or registered.
  const record = envelope as unknown as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ENVELOPE_FIELDS.includes(key)) || record.alg !== ENVELOPE_ALG) {
    throw new AddressedContentSourceError("envelope-invalid", "envelope has a field or algorithm the recipient does not accept");
  }
  if (typeof record.ciphertext !== "string" || !BASE64.test(record.ciphertext) || decodeBase64(record.ciphertext).length < 28) {
    throw new AddressedContentSourceError("envelope-invalid", "envelope ciphertext is not strict base64 of at least 28 bytes");
  }
  if (record.aad !== undefined && (typeof record.aad !== "string" || !BASE64.test(record.aad))) {
    throw new AddressedContentSourceError("envelope-invalid", "envelope aad is not strict base64");
  }
  if (record.metadata !== undefined && (record.metadata === null || typeof record.metadata !== "object" || Array.isArray(record.metadata) ||
      Object.values(record.metadata as Record<string, unknown>).some((entry) => typeof entry !== "string"))) {
    throw new AddressedContentSourceError("envelope-invalid", "envelope metadata must be an object of strings");
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
  encrypt(path: string, plaintext: Uint8Array, options: { networkId: string; metadata?: Record<string, string> }): Promise<PathBoundEnvelope>;
}

/** What `encryptAddressedShareContent` returns: the envelope and the exact bytes to upload. */
export interface EncryptedAddressedContent {
  readonly envelope: PathBoundEnvelope;
  readonly storedBytes: Uint8Array;
  readonly byteLength: number;
}

/**
 * Encrypt the content under the share's named key. `keys.encrypt` wraps to the key's public key, which the node serves without
 * authentication; the key needs no record yet (the node records it when the share policy is registered).
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
  const envelope = await keys.encrypt(plan.keyPath, input.plaintext, plan.encryptOptions(input.metadata === undefined ? undefined : { metadata: input.metadata }));
  assertEnvelope(plan, envelope);
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
  assertEncryptionNetwork(source.encryptionNetwork);
}
