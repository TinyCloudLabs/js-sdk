/**
 * Named-key client: key admin, descriptor reads, `ensureKey` and key-scoped
 * encrypt / decrypt.
 *
 * Rules enforced here:
 * - Everything is dark unless the node's `/info` `features` contains
 *   `encryption-named-keys-v1`. Without it no key ability, key URN or `keyPath`
 *   is sent to the node; the call throws `NAMED_KEYS_UNSUPPORTED` first.
 * - Every invocation carries exactly ONE capability whose `with` is the EXACT
 *   key URN (a parsed `kind: "key"`; a prefix or bare network is never a
 *   target) and whose `can` is the one ability the call needs.
 * - Admin bodies are hashed and serialized with the same canonical JSON used
 *   by the network-admin invocation (`canonicalHashHex` / `canonicalize`).
 * - Envelope v2 carries `keyPath` and is wrapped to the KEY's public key. It is
 *   decrypted only through `POST /invoke` with a single decrypt capability on
 *   that key. v1 envelopes (no `keyPath`) go to the root-key path unchanged.
 *   A key and the root, or two keys, are never mixed in one invocation.
 * - `key.delete` is not offered. The create body carries `deletable`, which is
 *   `true` exactly when the path starts with `apps/`; the node refuses it with
 *   `deletable_unavailable` while app-key deletion is not enabled there.
 */

import {
  base64Decode,
  base64Encode,
  canonicalHashHex,
  canonicalize,
  type Json,
} from "./canonical";
import { parseNetworkId } from "./networkId";
import { generateRandomReceiverKey } from "./receiverKey";
import { openWrappedKey, verifyDecryptResponse } from "./response";
import {
  formatKeyResource,
  KEY_BLOCK_ABILITY,
  KEY_CREATE_ABILITY,
  KEY_UNBLOCK_ABILITY,
  nodeSupportsNamedKeys,
  parseEncryptionResource,
  type ParsedKeyResource,
} from "./resource";
import {
  DECRYPT_ACTION,
  DECRYPT_FACT_TYPE,
  DEFAULT_ENCRYPTION_ALG,
  type DecryptInvocationFact,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type InlineEncryptedEnvelope,
} from "./types";

export const KEY_ADMIN_FACT_TYPE = "tinycloud.encryption.key-admin/v1" as const;
export const KEY_DESCRIBE_FACT_TYPE =
  "tinycloud.encryption.key-describe/v1" as const;
export const NAMED_KEY_ENVELOPE_VERSION = 2 as const;

export type NamedKeyErrorCode =
  | "NAMED_KEYS_UNSUPPORTED"
  | "INVALID_KEY_TARGET"
  | "INVALID_ENVELOPE"
  | "INVALID_RESPONSE"
  | "KEY_BLOCKED"
  | "KEY_NOT_FOUND"
  | "KEY_EXISTS"
  | "NETWORK_NOT_FOUND"
  | "NETWORK_NOT_ACTIVE"
  | "KEY_LIMIT_EXCEEDED"
  | "DELETABLE_UNAVAILABLE"
  /** The key is not deletable (a deterministic key answers 409 `key_not_deletable`). */
  | "KEY_NOT_DELETABLE"
  | "KEY_PATH_INVALID"
  | "KEY_UNWRAP_FAILED"
  /** Key is in a state other than active/blocked; `rawState` holds the node's string. */
  | "KEY_UNAVAILABLE"
  /** `ensureKey` found a key that is not deterministic. */
  | "KEY_KIND_MISMATCH"
  | "DECRYPT_FAILED"
  | "NODE_ERROR"
  /** The node rejected `receiverPublicKey` (400, invocation not consumed). */
  | "RECEIVER_KEY_INVALID"
  /** The node object lacks an invocation hook the node-sdk wiring needs. */
  | "NODE_HOOK_MISSING";

/** Longest untrusted value echoed into an error message. */
const MAX_ECHO_CHARS = 120;

/** Escape every code point outside printable ASCII as `\u{XXXX}`. */
function escapeNonPrintable(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x20 && cp <= 0x7e ? ch : `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}`;
  }
  return out;
}

/**
 * Render an untrusted value (resource, path, node-supplied state, parser or
 * signer text) for an error message: capped at 120 characters, then every
 * character outside printable ASCII escaped, so bidi, zero-width and other
 * format or control characters can never reach a terminal or log through a
 * message. Raw values live only in non-message fields (`input`, `rawState`,
 * `kind`, `detail`, `cause`).
 */
export function safeEcho(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  const chars = Array.from(text);
  const clipped = chars.length > MAX_ECHO_CHARS ? `${chars.slice(0, MAX_ECHO_CHARS).join("")}...` : text;
  return escapeNonPrintable(clipped);
}

export interface NamedKeyErrorInit {
  status?: number;
  /** The node's `<code>` prefix, when it sent one. */
  nodeCode?: string;
  /** The node's `<detail>` text. Raw: never in `message`. */
  detail?: string;
  /** Raw state string (KEY_UNAVAILABLE). Raw: never in `message`. */
  rawState?: string;
  kind?: string;
  /** The rejected caller input (resource or path), unescaped. Raw: never in `message`. */
  input?: string;
  cause?: unknown;
}

export class NamedKeyError extends Error {
  readonly code: NamedKeyErrorCode;
  readonly status?: number;
  readonly nodeCode?: string;
  readonly detail?: string;
  readonly rawState?: string;
  readonly kind?: string;
  readonly input?: string;

  constructor(code: NamedKeyErrorCode, message: string, init: NamedKeyErrorInit = {}) {
    // Backstop: whatever a call site interpolated, the message is printable ASCII.
    super(escapeNonPrintable(message), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "NamedKeyError";
    this.code = code;
    if (init.status !== undefined) this.status = init.status;
    if (init.nodeCode !== undefined) this.nodeCode = init.nodeCode;
    if (init.detail !== undefined) this.detail = init.detail;
    if (init.rawState !== undefined) this.rawState = init.rawState;
    if (init.kind !== undefined) this.kind = init.kind;
    if (init.input !== undefined) this.input = init.input;
  }
}

/**
 * Null-prototype tables: a node body such as `constructor: x` or `__proto__: x`
 * must never match an inherited property.
 */
const NODE_CODE_MAP: Readonly<Record<string, NamedKeyErrorCode>> = Object.assign(
  Object.create(null) as Record<string, NamedKeyErrorCode>,
  {
    key_blocked: "KEY_BLOCKED",
    key_not_found: "KEY_NOT_FOUND",
    key_exists: "KEY_EXISTS",
    network_not_found: "NETWORK_NOT_FOUND",
    network_not_active: "NETWORK_NOT_ACTIVE",
    key_limit_exceeded: "KEY_LIMIT_EXCEEDED",
    deletable_unavailable: "DELETABLE_UNAVAILABLE",
    key_not_deletable: "KEY_NOT_DELETABLE",
    key_path_invalid: "KEY_PATH_INVALID",
    key_unwrap_failed: "KEY_UNWRAP_FAILED",
    receiver_key_invalid: "RECEIVER_KEY_INVALID",
  } satisfies Record<string, NamedKeyErrorCode>,
);

/**
 * A deleted key answers `key_deleted`. It maps to the generic "unavailable"
 * error carrying the raw code.
 */
const UNAVAILABLE_NODE_CODES: Readonly<Record<string, true>> = Object.assign(
  Object.create(null) as Record<string, true>,
  { key_deleted: true as const },
);

const NODE_ERROR_RE = /^([a-z][a-z0-9_]*):\s?([\s\S]*)$/;

/** Longest node error code kept in `nodeCode` and echoed into a message. */
const MAX_NODE_CODE_CHARS = 64;

/** Map a node plain-text `<code>: <detail>` error response to a typed error. */
export function mapNodeKeyError(
  status: number,
  text: string,
  context: string,
): NamedKeyError {
  const match = NODE_ERROR_RE.exec(text.trim());
  const nodeCode = match?.[1]?.slice(0, MAX_NODE_CODE_CHARS);
  const detail = match?.[2]?.trim();
  const base = {
    status,
    ...(nodeCode === undefined ? {} : { nodeCode }),
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
  };
  if (nodeCode !== undefined) {
    const mapped = NODE_CODE_MAP[nodeCode];
    if (mapped !== undefined) {
      return new NamedKeyError(mapped, `${context}: ${nodeCode}`, base);
    }
    if (UNAVAILABLE_NODE_CODES[nodeCode] === true) {
      return new NamedKeyError("KEY_UNAVAILABLE", `${context}: key unavailable (${nodeCode})`, {
        ...base,
        rawState: nodeCode,
      });
    }
  }
  return new NamedKeyError("NODE_ERROR", `${context}: node responded ${status}`, base);
}

export interface PublicKeyDescriptor {
  networkId: string;
  keyPath: string;
  alg: string;
  keyVersion: number;
  publicEncryptionKey: string;
}

export interface KeyDescriptor extends PublicKeyDescriptor {
  /** Raw node state string (`active`, `blocked`, ...). */
  state: string;
  /** `deterministic` outside `apps/`, `deletable` under it; kept as a string so unknown kinds surface. */
  kind: string;
  createdAt?: string;
  updatedAt?: string;
}

/** v2 inline envelope: v1 fields plus `keyPath`, wrapped to the key's public key. */
export interface NamedKeyEnvelope extends Omit<InlineEncryptedEnvelope, "v"> {
  v: typeof NAMED_KEY_ENVELOPE_VERSION;
  keyPath: string;
}

export interface NamedKeyInvocationInput {
  targetNode: string;
  /** The EXACT key URN. This is the single capability's `with`. */
  resource: string;
  /** The single capability's `can`. */
  action: string;
  facts: Record<string, unknown>;
}

export interface NamedKeyClientConfig {
  host: string;
  crypto: EncryptionCrypto;
  fetch: typeof fetch;
  /** Network used when a call does not name one. */
  defaultNetworkId: () => string;
  /** Mint one single-capability invocation and return the Authorization header value. */
  signInvocation: (
    input: NamedKeyInvocationInput,
  ) => Promise<{ authorization: string; invocationCid: string }>;
  /**
   * Decrypt a v1 (root key, bare network capability) envelope exactly as the
   * existing network decrypt path does.
   */
  decryptRoot?: (
    envelope: InlineEncryptedEnvelope,
  ) => Promise<
    | { ok: true; data: Uint8Array }
    | { ok: false; error: { message: string } }
  >;
}

export interface KeyCallOptions {
  /** Full network id URN. Defaults to the client's default network. */
  networkId?: string;
}

export interface KeyEncryptOptions extends KeyCallOptions {
  aad?: Uint8Array;
  metadata?: Record<string, string>;
}

export type DecryptManyResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: NamedKeyError };

/** Accept only a parsed `kind: "key"`; a prefix or bare network is never a target. */
export function requireKeyTarget(resource: string): ParsedKeyResource {
  let parsed;
  try {
    parsed = parseEncryptionResource(resource);
  } catch (error) {
    throw new NamedKeyError(
      "INVALID_KEY_TARGET",
      `not a valid encryption key resource: ${safeEcho(error instanceof Error ? error.message : error)}`,
      { cause: error, input: resource },
    );
  }
  if (parsed.kind !== "key") {
    throw new NamedKeyError(
      "INVALID_KEY_TARGET",
      `a ${parsed.kind} resource cannot be an invocation target; an exact key is required`,
      { input: resource },
    );
  }
  return parsed;
}

/** `{type, targetNode, networkId, keyPath, action, bodyHash}` for key admin routes. */
export function buildKeyAdminFacts(input: {
  crypto: EncryptionCrypto;
  targetNode: string;
  keyResource: string;
  action: string;
  body: Json;
}): Record<string, unknown> {
  const key = requireKeyTarget(input.keyResource);
  return {
    type: KEY_ADMIN_FACT_TYPE,
    targetNode: input.targetNode,
    networkId: key.networkId,
    keyPath: key.path,
    action: input.action,
    bodyHash: canonicalHashHex(input.crypto.sha256, input.body),
  };
}

/** `{type, targetNode, networkId, keyPath}`; no body hash. */
export function buildKeyDescribeFacts(input: {
  targetNode: string;
  keyResource: string;
}): Record<string, unknown> {
  const key = requireKeyTarget(input.keyResource);
  return {
    type: KEY_DESCRIBE_FACT_TYPE,
    targetNode: input.targetNode,
    networkId: key.networkId,
    keyPath: key.path,
  };
}

const DESCRIBE_ABILITIES: Record<string, true> = {
  [DECRYPT_ACTION]: true,
  [KEY_CREATE_ABILITY]: true,
  [KEY_BLOCK_ABILITY]: true,
  [KEY_UNBLOCK_ABILITY]: true,
};

function invalidResponse(what: string): NamedKeyError {
  return new NamedKeyError("INVALID_RESPONSE", `node returned an invalid ${what}`);
}

function parsePublicDescriptor(
  raw: unknown,
  networkId: string,
  keyPath: string,
): PublicKeyDescriptor {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (
    typeof value.alg !== "string" ||
    typeof value.keyVersion !== "number" ||
    !Number.isInteger(value.keyVersion) ||
    typeof value.publicEncryptionKey !== "string" ||
    value.publicEncryptionKey.length === 0
  ) {
    throw invalidResponse("key descriptor");
  }
  if (value.networkId !== networkId || value.keyPath !== keyPath) {
    throw new NamedKeyError(
      "INVALID_RESPONSE",
      "node returned a descriptor for a different network or key",
    );
  }
  return {
    networkId,
    keyPath,
    alg: value.alg,
    keyVersion: value.keyVersion,
    publicEncryptionKey: value.publicEncryptionKey,
  };
}

function parseFullDescriptor(
  value: unknown,
  networkId: string,
  keyPath: string,
): KeyDescriptor {
  const base = parsePublicDescriptor(value, networkId, keyPath);
  const record = value as Record<string, unknown>;
  if (typeof record.state !== "string" || typeof record.kind !== "string") {
    throw invalidResponse("key descriptor (state/kind missing)");
  }
  return {
    ...base,
    state: record.state,
    kind: record.kind,
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
  };
}

/** Success only for `state: "active"` AND the expected `kind`. */
function assertEnsuredDescriptor(descriptor: KeyDescriptor, expectedKind: string): KeyDescriptor {
  if (descriptor.state === "blocked") {
    throw new NamedKeyError("KEY_BLOCKED", `key ${safeEcho(descriptor.keyPath)} is blocked`, {
      rawState: descriptor.state,
    });
  }
  if (descriptor.state !== "active") {
    throw new NamedKeyError(
      "KEY_UNAVAILABLE",
      `key ${safeEcho(descriptor.keyPath)} is unavailable (state ${safeEcho(descriptor.state)})`,
      { rawState: descriptor.state },
    );
  }
  if (descriptor.kind !== expectedKind) {
    throw new NamedKeyError(
      "KEY_KIND_MISMATCH",
      `key ${safeEcho(descriptor.keyPath)} exists with kind ${safeEcho(descriptor.kind)}, not ${expectedKind}`,
      { kind: descriptor.kind },
    );
  }
  return descriptor;
}

/** Keys under `apps/` are the deletable keys; everything else is deterministic. */
function isAppKeyPath(path: string): boolean {
  return path.startsWith("apps/");
}

const REQUIRED_ENVELOPE_STRINGS = [
  "alg",
  "encryptedSymmetricKey",
  "encryptedSymmetricKeyHash",
  "ciphertext",
] as const;

export class NamedKeyClient {
  /** One `/info` read per client: the node DID once the feature is confirmed. */
  private nodeId?: Promise<string>;

  constructor(private readonly config: NamedKeyClientConfig) {}

  private networkFor(options?: KeyCallOptions): string {
    return options?.networkId ?? this.config.defaultNetworkId();
  }

  private keyUrn(networkId: string, path: string): string {
    try {
      return formatKeyResource(networkId, path);
    } catch (error) {
      throw new NamedKeyError(
        "INVALID_KEY_TARGET",
        safeEcho(error instanceof Error ? error.message : error),
        { cause: error, input: `${networkId}/${path}` },
      );
    }
  }

  /**
   * Require the named-keys feature and return the node DID. The first call
   * reads `/info`; a positive answer is cached for the life of this client, so
   * later calls make no `/info` request. A node without the feature is NOT
   * cached: the typed `NAMED_KEYS_UNSUPPORTED` error is thrown and the next
   * call re-reads (so a retry sees an upgraded node). No key request is made
   * before the gate passes.
   */
  private requireNode(): Promise<string> {
    if (this.nodeId === undefined) {
      const pending = this.readNodeInfo();
      this.nodeId = pending;
      pending.catch(() => {
        if (this.nodeId === pending) this.nodeId = undefined;
      });
    }
    return this.nodeId;
  }

  /** Clear the cached `/info` answer; the next call reads it again. */
  refreshNodeInfo(): void {
    this.nodeId = undefined;
  }

  private async readNodeInfo(): Promise<string> {
    const response = await this.config.fetch(`${this.config.host}/info`);
    if (!response.ok) {
      throw mapNodeKeyError(response.status, await safeText(response), "failed to read node info");
    }
    const info = (await response.json()) as { nodeId?: unknown; features?: unknown };
    if (!nodeSupportsNamedKeys(info)) {
      throw new NamedKeyError(
        "NAMED_KEYS_UNSUPPORTED",
        "this node does not support named encryption keys",
      );
    }
    if (typeof info.nodeId !== "string" || info.nodeId.length === 0) {
      throw invalidResponse("/info response (nodeId missing)");
    }
    return info.nodeId;
  }

  private keysUrl(networkId: string, path: string): string {
    // The network id is validated by `keyUrn` (strict grammar) before any URL is
    // built; every character it can hold (`A-Za-z0-9._:-`) is an RFC 3986 pchar
    // and the node refuses `%`, so it goes into the path raw. keyPath segments
    // are raw too: the grammar excludes `%`.
    return `${this.config.host}/encryption/networks/${networkId}/keys/${path}`;
  }

  /** Public GET: the key's public key. Derive-only (no 404) outside `apps/`; under `apps/` the node answers 404. */
  async getPublicKey(path: string, options?: KeyCallOptions): Promise<PublicKeyDescriptor> {
    const networkId = this.networkFor(options);
    this.keyUrn(networkId, path);
    await this.requireNode();
    const response = await this.config.fetch(this.keysUrl(networkId, path), { method: "GET" });
    if (!response.ok) {
      throw mapNodeKeyError(response.status, await safeText(response), "failed to read key");
    }
    return parsePublicDescriptor(await response.json(), networkId, path);
  }

  /**
   * Authenticated GET: the full descriptor, or `null` on `key_not_found`.
   * `ability` is the one capability the invocation carries (default decrypt).
   */
  async describeKey(
    path: string,
    options?: KeyCallOptions & { ability?: string },
  ): Promise<KeyDescriptor | null> {
    const networkId = this.networkFor(options);
    const body = await this.describeBody(path, options);
    return body === null ? null : parseFullDescriptor(body, networkId, path);
  }

  /** Public fields of an authenticated describe (decrypt ability); `key_not_found` throws. */
  private async describePublic(path: string, options?: KeyCallOptions): Promise<PublicKeyDescriptor> {
    const networkId = this.networkFor(options);
    const body = await this.describeBody(path, options);
    if (body === null) {
      throw new NamedKeyError("KEY_NOT_FOUND", `key ${safeEcho(path)} does not exist`, { status: 404 });
    }
    return parsePublicDescriptor(body, networkId, path);
  }

  /** The authenticated GET response body, or `null` on `key_not_found`. */
  private async describeBody(
    path: string,
    options?: KeyCallOptions & { ability?: string },
  ): Promise<unknown> {
    const networkId = this.networkFor(options);
    const keyResource = this.keyUrn(networkId, path);
    const ability = options?.ability ?? DECRYPT_ACTION;
    if (DESCRIBE_ABILITIES[ability] !== true) {
      throw new NamedKeyError("INVALID_KEY_TARGET", `${safeEcho(ability)} cannot describe a key`, { input: ability });
    }
    const targetNode = await this.requireNode();
    const signed = await this.config.signInvocation({
      targetNode,
      resource: keyResource,
      action: ability,
      facts: buildKeyDescribeFacts({ targetNode, keyResource }),
    });
    const response = await this.config.fetch(this.keysUrl(networkId, path), {
      method: "GET",
      headers: { Authorization: signed.authorization },
    });
    if (response.status === 404) {
      const error = mapNodeKeyError(404, await safeText(response), "failed to describe key");
      if (error.code === "KEY_NOT_FOUND") return null;
      throw error;
    }
    if (!response.ok) {
      throw mapNodeKeyError(response.status, await safeText(response), "failed to describe key");
    }
    return response.json();
  }

  private async admin(
    route: "keys" | "key-actions/block" | "key-actions/unblock",
    action: string,
    path: string,
    options?: KeyCallOptions,
  ): Promise<KeyDescriptor> {
    const networkId = this.networkFor(options);
    const keyResource = this.keyUrn(networkId, path);
    const body: Json =
      route === "keys" ? { keyPath: path, deletable: isAppKeyPath(path) } : { keyPath: path };
    const targetNode = await this.requireNode();
    const signed = await this.config.signInvocation({
      targetNode,
      resource: keyResource,
      action,
      facts: buildKeyAdminFacts({
        crypto: this.config.crypto,
        targetNode,
        keyResource,
        action,
        body,
      }),
    });
    const response = await this.config.fetch(
      `${this.config.host}/encryption/networks/${networkId}/${route}`,
      {
        method: "POST",
        headers: {
          Authorization: signed.authorization,
          "Content-Type": "application/json",
        },
        body: canonicalize(body),
      },
    );
    if (!response.ok) {
      throw mapNodeKeyError(response.status, await safeText(response), `failed to ${action}`);
    }
    return parseFullDescriptor(unwrapDescriptor(await response.json()), networkId, path);
  }

  /** `key.create`: `deletable` is `true` exactly under `apps/`, else a deterministic key. */
  createKey(path: string, options?: KeyCallOptions): Promise<KeyDescriptor> {
    return this.admin("keys", KEY_CREATE_ABILITY, path, options);
  }

  blockKey(path: string, options?: KeyCallOptions): Promise<KeyDescriptor> {
    return this.admin("key-actions/block", KEY_BLOCK_ABILITY, path, options);
  }

  unblockKey(path: string, options?: KeyCallOptions): Promise<KeyDescriptor> {
    return this.admin("key-actions/unblock", KEY_UNBLOCK_ABILITY, path, options);
  }

  /**
   * Make sure a key exists and is usable: authenticated GET; on
   * `key_not_found` create it; on 409 `key_exists` read it again. Succeeds only
   * for `state: "active"` and the kind the path implies: `deletable` under
   * `apps/`, `deterministic` elsewhere.
   */
  async ensureKey(path: string, options?: KeyCallOptions): Promise<KeyDescriptor> {
    const describe = () =>
      this.describeKey(path, { ...options, ability: KEY_CREATE_ABILITY });
    let descriptor = await describe();
    if (descriptor === null) {
      try {
        descriptor = await this.createKey(path, options);
      } catch (error) {
        if (!(error instanceof NamedKeyError) || error.code !== "KEY_EXISTS") throw error;
        descriptor = await describe();
        if (descriptor === null) {
          throw new NamedKeyError(
            "KEY_NOT_FOUND",
            `key ${safeEcho(path)} reported as existing but could not be read back`,
          );
        }
      }
    }
    return assertEnsuredDescriptor(descriptor, isAppKeyPath(path) ? "deletable" : "deterministic");
  }

  /** Encrypt to a named key: envelope v2, symmetric key wrapped to the key's public key. */
  async encrypt(
    path: string,
    plaintext: Uint8Array,
    options?: KeyEncryptOptions,
  ): Promise<NamedKeyEnvelope> {
    // The node answers a public GET under `apps/` with 404 `key_not_found`, so
    // an app key's public key is read through the authenticated describe.
    const descriptor = isAppKeyPath(path)
      ? await this.describePublic(path, options)
      : await this.getPublicKey(path, options);
    const { crypto } = this.config;
    const symmetricKey = crypto.randomBytes(32);
    const ciphertext = crypto.authEncrypt(symmetricKey, plaintext, options?.aad);
    const wrapped = crypto.sealToNetworkKey(
      base64Decode(descriptor.publicEncryptionKey),
      symmetricKey,
    );
    const encryptedSymmetricKey = base64Encode(wrapped);
    return {
      v: NAMED_KEY_ENVELOPE_VERSION,
      networkId: descriptor.networkId,
      keyPath: descriptor.keyPath,
      alg: descriptor.alg ?? DEFAULT_ENCRYPTION_ALG,
      keyVersion: descriptor.keyVersion,
      encryptedSymmetricKey,
      encryptedSymmetricKeyHash: canonicalHashHex(crypto.sha256, encryptedSymmetricKey),
      ciphertext: base64Encode(ciphertext),
      ...(options?.aad !== undefined ? { aad: base64Encode(options.aad) } : {}),
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    };
  }

  /**
   * Decrypt one envelope. v1 (no `keyPath`) uses the root-key path exactly as
   * before; v2 uses one decrypt capability on the exact key via `/invoke`.
   */
  async decrypt(envelope: InlineEncryptedEnvelope | NamedKeyEnvelope): Promise<Uint8Array> {
    const candidate = (typeof envelope === "object" && envelope !== null ? envelope : {}) as unknown as Record<string, unknown>;
    if (candidate.v === 1 && candidate.keyPath === undefined) {
      return this.decryptRoot(candidate as unknown as InlineEncryptedEnvelope);
    }
    if (candidate.v === NAMED_KEY_ENVELOPE_VERSION && typeof candidate.keyPath === "string") {
      return this.decryptKey(this.validateKeyEnvelope(candidate));
    }
    throw new NamedKeyError(
      "INVALID_ENVELOPE",
      "envelope must be v1 without keyPath or v2 with keyPath",
    );
  }

  /**
   * Decrypt a batch. Each envelope is its own invocation with its own single
   * capability, so v1 and v2 (or two different keys) are never combined.
   */
  async decryptMany(
    envelopes: ReadonlyArray<InlineEncryptedEnvelope | NamedKeyEnvelope>,
  ): Promise<DecryptManyResult[]> {
    const results: DecryptManyResult[] = [];
    for (const envelope of envelopes) {
      try {
        results.push({ ok: true, data: await this.decrypt(envelope) });
      } catch (error) {
        results.push({
          ok: false,
          error:
            error instanceof NamedKeyError
              ? error
              : new NamedKeyError("DECRYPT_FAILED", "decrypt failed", { cause: error }),
        });
      }
    }
    return results;
  }

  private async decryptRoot(envelope: InlineEncryptedEnvelope): Promise<Uint8Array> {
    if (this.config.decryptRoot === undefined) {
      throw new NamedKeyError("DECRYPT_FAILED", "no root-key decrypt path is configured");
    }
    const result = await this.config.decryptRoot(envelope);
    if (!result.ok) {
      throw new NamedKeyError("DECRYPT_FAILED", safeEcho(result.error.message), { cause: result.error });
    }
    return result.data;
  }

  private validateKeyEnvelope(e: Record<string, unknown>): NamedKeyEnvelope {
    for (const field of REQUIRED_ENVELOPE_STRINGS) {
      if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
        throw new NamedKeyError("INVALID_ENVELOPE", `envelope.${field} must be a non-empty string`);
      }
    }
    if (typeof e.keyVersion !== "number" || !Number.isInteger(e.keyVersion)) {
      throw new NamedKeyError("INVALID_ENVELOPE", "envelope.keyVersion must be an integer");
    }
    if (typeof e.networkId !== "string") {
      throw new NamedKeyError("INVALID_ENVELOPE", "envelope.networkId must be a string");
    }
    try {
      parseNetworkId(e.networkId);
    } catch (error) {
      throw new NamedKeyError("INVALID_ENVELOPE", "envelope.networkId is malformed", { cause: error });
    }
    const expectedHash = canonicalHashHex(
      this.config.crypto.sha256,
      e.encryptedSymmetricKey as string,
    );
    if (expectedHash !== e.encryptedSymmetricKeyHash) {
      throw new NamedKeyError(
        "INVALID_ENVELOPE",
        "envelope.encryptedSymmetricKeyHash does not match encryptedSymmetricKey",
      );
    }
    return e as unknown as NamedKeyEnvelope;
  }

  private async decryptKey(envelope: NamedKeyEnvelope): Promise<Uint8Array> {
    const { crypto } = this.config;
    const keyResource = this.keyUrn(envelope.networkId, envelope.keyPath);
    const targetNode = await this.requireNode();

    const receiverKey = generateRandomReceiverKey({ crypto });
    const receiverPublicKey = base64Encode(receiverKey.publicKey);
    const receiverPublicKeyHash = canonicalHashHex(crypto.sha256, receiverPublicKey);
    const body: DecryptRequestBody & { keyPath: string } = {
      type: DECRYPT_FACT_TYPE,
      targetNode,
      networkId: envelope.networkId,
      keyPath: envelope.keyPath,
      alg: envelope.alg,
      keyVersion: envelope.keyVersion,
      encryptedSymmetricKey: envelope.encryptedSymmetricKey,
      encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
      receiverPublicKey,
      receiverPublicKeyHash,
    };
    const canonicalBody = canonicalize(body as unknown as Json);
    const facts: DecryptInvocationFact & { keyPath: string } = {
      type: DECRYPT_FACT_TYPE,
      targetNode,
      networkId: envelope.networkId,
      keyPath: envelope.keyPath,
      bodyHash: canonicalHashHex(crypto.sha256, body as unknown as Json),
      encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
      receiverPublicKeyHash,
      alg: envelope.alg,
      keyVersion: envelope.keyVersion,
    };
    const signed = await this.config.signInvocation({
      targetNode,
      resource: keyResource,
      action: DECRYPT_ACTION,
      facts: facts as unknown as Record<string, unknown>,
    });
    const response = await this.config.fetch(`${this.config.host}/invoke`, {
      method: "POST",
      headers: {
        Authorization: signed.authorization,
        "Content-Type": "application/json",
      },
      body: canonicalBody,
    });
    if (!response.ok) {
      throw mapNodeKeyError(response.status, await safeText(response), "failed to decrypt");
    }
    const verified = verifyDecryptResponse({
      crypto,
      request: body,
      facts,
      invocationCid: signed.invocationCid,
      requestBodyHash: facts.bodyHash,
      response: (await response.json()) as DecryptResponseBody,
    });
    if (!verified.ok) {
      throw new NamedKeyError("INVALID_RESPONSE", safeEcho(verified.error.message), { cause: verified.error });
    }
    const symmetricKey = openWrappedKey(crypto, receiverKey.privateKey, verified.data);
    try {
      return crypto.authDecrypt(
        symmetricKey,
        base64Decode(envelope.ciphertext),
        envelope.aad !== undefined ? base64Decode(envelope.aad) : undefined,
      );
    } catch (error) {
      throw new NamedKeyError("DECRYPT_FAILED", "local decryption failed", { cause: error });
    }
  }
}

function unwrapDescriptor(body: unknown): unknown {
  const outer = (typeof body === "object" && body !== null ? body : {}) as { descriptor?: unknown };
  return typeof outer.descriptor === "object" && outer.descriptor !== null ? outer.descriptor : body;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

