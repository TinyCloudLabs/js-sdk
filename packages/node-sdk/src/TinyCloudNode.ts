/**
 * TinyCloudNode - High-level API for Node.js users.
 *
 * Each user has their own TinyCloudNode instance with their own key.
 * This class provides a simplified interface for:
 * - Signing in and managing sessions
 * - Key-value storage operations on own space
 * - Creating and using delegations
 *
 * @example
 * ```typescript
 * const alice = new TinyCloudNode({
 *   privateKey: process.env.ALICE_PRIVATE_KEY,
 *   host: "https://node.tinycloud.xyz",
 *   prefix: "myapp",
 * });
 *
 * await alice.signIn();
 * await alice.kv.put("greeting", "Hello, world!");
 *
 * // Delegate access to Bob
 * const delegation = await alice.createDelegation({
 *   path: "shared/",
 *   actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
 *   delegateDID: bob.did,
 * });
 *
 * // Bob uses the delegation
 * const access = await bob.useDelegation(delegation);
 * const data = await access.kv.get("shared/data");
 * ```
 */

import {
  TinyCloud,
  TinyCloudSession,
  activateSessionWithHost,
  KVService,
  IKVService,
  SQLService,
  ISQLService,
  DuckDbService,
  IDuckDbService,
  HooksService,
  DataVaultService,
  IDataVaultService,
  EncryptionService,
  DecryptTransportResponseError,
  SecretsService,
  ISecretsService,
  IEncryptionService,
  IHooksService,
  createVaultCrypto,
  ServiceSession,
  ServiceContext,
  type TelemetryConfig,
  ISessionStorage,
  ISigner,
  type InvokeAnyFunction,
  type InvokeFunction,
  type FetchFunction,
  INotificationHandler,
  SilentNotificationHandler,
  IENSResolver,
  IWasmBindings,
  ISessionManager,
  type WasmRecapEntry,
  ISpaceCreationHandler,
  SignInOptions,
  // v2 services
  DelegationManager,
  SpaceService,
  ISpaceService,
  ISpace,
  CapabilityKeyRegistry,
  ICapabilityKeyRegistry,
  SharingService,
  ISharingService,
  // v2 types
  SiweConfig,
  Delegation,
  DelegationStatus,
  DelegationRevocationReceipt,
  CreateDelegationParams,
  KeyInfo,
  JWK,
  DelegationResult,
  CreateDelegationWasmParams,
  CreateDelegationWasmResult,
  type DelegatedResource,
  UnsupportedFeatureError,
  makePublicSpaceId,
  ACCOUNT_REGISTRY_SPACE,
  BOOTSTRAP_SESSION_REQUESTS,
  SECRET_RECORDS_SCHEMA,
  SECRETS_SPACE,
  TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
  bootstrapSteps,
  type BootstrapSpaceName,
  type BootstrapStep,
  type ComposedManifestRequest,
  type ResolvedDelegate,
  // Capability-chain delegation
  type PermissionEntry,
  ENCRYPTION_PERMISSION_SERVICE,
  CaveatedDelegationUnsupportedError,
  PermissionNotInManifestError,
  SessionExpiredError,
  canonicalizeRecapCaveats,
  recapCaveatsEqual,
  expandPermissionEntries as expandPermissionEntriesCore,
  isCapabilitySubset,
  parseRecapCapabilities,
  // Manifest-driven sign-in
  type Manifest,
  type AbilitiesMap,
  resourceCapabilitiesToAbilitiesMap,
  SERVICE_LONG_TO_SHORT,
  SERVICE_SHORT_TO_LONG,
  KV,
  SQL,
  DUCKDB,
  ENCRYPTION,
  EXPIRY,
  canonicalHashHex,
  canonicalizeEncryptionJson,
  verifyDidKeyEd25519Signature,
  canonicalizeAddress,
  pkhDid,
  resolveTinyCloudHosts,
  principalDidEquals,
  parseNetworkId,
  resolveSecretPath,
  type BuildDecryptInvocationInput,
  type BuiltDecryptInvocation,
  type CanonicalJson,
  type DecryptResponseBody,
  type DecryptTransport,
  type EncryptionCrypto,
  type NetworkDescriptor,
} from "@tinycloud/sdk-core";
import {
  parsePermissionHint,
  type PermissionHint,
} from "@tinycloud/sdk-services";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import type { SignStrategy } from "./authorization/strategies";
import { AccountService } from "./account/AccountService";
import { FileSessionStorage } from "./storage/FileSessionStorage";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { PortableDelegation } from "./delegation";
import { DelegatedAccess } from "./DelegatedAccess";
import { WasmKeyProvider } from "./keys/WasmKeyProvider";
import {
  legacyParamsToPermissionEntries,
  resolveExpiryMs,
  extractSiweExpiration,
} from "./delegateToHelpers";
import { NodeSecretsService } from "./NodeSecretsService";

/** Default TinyCloud host */
const DEFAULT_HOST = "https://node.tinycloud.xyz";
const DEFAULT_ENCRYPTION_NETWORK_NAME = "default";
const NETWORK_CREATE_ACTION = ENCRYPTION.NETWORK_CREATE;
const DECRYPT_ACTION = ENCRYPTION.DECRYPT;
const NETWORK_ADMIN_TYPE = "tinycloud.encryption.network-admin/v1";

/** Input for {@link TinyCloudNode.readSecret}. The target space is required. */
export interface SecretReadInput {
  /** Explicit full space URI or an owned-space name. */
  space: string;
  /** Env-style secret name. */
  name: string;
  /** Optional logical secret scope. */
  scope?: string;
}

/** Safe, validated capability hint returned when the node denies one read phase. */
export interface SecretPermissionHint {
  readonly service: "tinycloud.kv" | "tinycloud.encryption";
  readonly space?: string;
  readonly path: string;
  readonly actions: readonly string[];
}

/**
 * Safe classified result for an explicit-space secret read.
 *
 * Failure variants contain no raw node response, envelope, plaintext, keys,
 * tokens, or delegation data.
 */
export type SecretReadResult =
  | { status: "ok"; value: string }
  | { status: "not_found" }
  | { status: "permission_required"; hint: SecretPermissionHint }
  | { status: "node_unreachable" }
  | { status: "read_failed" }
  | { status: "corrupt_envelope" }
  | { status: "decrypt_failed" }
  | { status: "invalid_payload" };

function isSecretPayload(
  value: unknown,
): value is { value: string; createdAt: string; updatedAt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof (value as { value?: unknown }).value === "string" &&
    "createdAt" in value &&
    typeof (value as { createdAt?: unknown }).createdAt === "string" &&
    "updatedAt" in value &&
    typeof (value as { updatedAt?: unknown }).updatedAt === "string"
  );
}

/**
 * Full actions the session key's root delegation grants over a space. Used for
 * both the primary space and any additional (e.g. public) spaces registered in
 * {@link TinyCloudNode.initializeV2Services}. URNs come from the canonical
 * capability registry in `@tinycloud/bootstrap` (TC-112).
 */
const ROOT_DELEGATION_ACTIONS: string[] = [
  KV.PUT,
  KV.GET,
  KV.DEL,
  KV.LIST,
  KV.METADATA,
  SQL.READ,
  SQL.WRITE,
  SQL.ADMIN,
  SQL.ALL,
  DUCKDB.READ,
  DUCKDB.WRITE,
  DUCKDB.ADMIN,
  DUCKDB.DESCRIBE,
  DUCKDB.EXPORT,
  DUCKDB.IMPORT,
  DUCKDB.ALL,
];

/**
 * Default lifetime of a SIWE session when {@link TinyCloudNodeConfig.sessionExpirationMs}
 * is not set. Sourced from the shared SESSION tier so all sign-in code
 * paths land on the same number — see `@tinycloud/sdk-core/expiry.ts`
 * for the tier rationale.
 */
const DEFAULT_SESSION_EXPIRATION_MS = EXPIRY.SESSION_MS;

export interface CreateOwnerDelegationParams {
  readonly delegateDid: string;
  readonly spaceId: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly expiresAt: Date;
}

export function decodeAuthorizationBytes(authorization: string): Uint8Array {
  const encoded = authorization.replace(/^Bearer /i, "");
  const match = /^([A-Za-z0-9_-]+)(={1,2})?$/.exec(encoded);
  const unpadded = match?.[1];
  const paddingLength = match?.[2]?.length ?? 0;
  const remainder = unpadded === undefined ? 1 : unpadded.length % 4;
  const expectedPaddingLength = remainder === 2 ? 2 : remainder === 3 ? 1 : 0;
  if (
    unpadded === undefined ||
    remainder === 1 ||
    (paddingLength !== 0 && paddingLength !== expectedPaddingLength)
  ) {
    throw new Error("Delegation Authorization is not canonical base64url DAG-CBOR");
  }
  const decoded = Uint8Array.from(Buffer.from(unpadded, "base64url"));
  if (Buffer.from(decoded).toString("base64url") !== unpadded) {
    throw new Error("Delegation Authorization is not canonical base64url DAG-CBOR");
  }
  return decoded;
}

export interface OwnerDelegationReceipt {
  readonly delegation: Delegation;
  /** Exact signed DAG-CBOR bytes submitted in the Authorization header. */
  readonly signedDagCbor: Uint8Array;
  /** Locally derived by the node WASM implementation; this is delegation identity. */
  readonly delegationCid: string;
  readonly nodeReceipt: {
    /** Raw /delegate response CID: a commit-event id, not delegation identity. */
    readonly commitEventCid?: string;
    readonly activated: readonly string[];
    readonly skipped: readonly string[];
  };
}

function isOpenKeyAutoSignStrategy(strategy: SignStrategy | undefined): boolean {
  return (strategy as { openKeyAutoSign?: unknown } | undefined)?.openKeyAutoSign === true;
}

/**
 * Returns true when the signer is an external/interactive signer (browser
 * wallet, EIP-1193 provider, etc.) that will open a UI prompt for every
 * `signMessage()` call.
 *
 * Detection: the config provides a `signer` but NOT a `privateKey`, and the
 * `signStrategy` is neither the OpenKey auto-sign callback nor the auto-sign
 * strategy backed by a local key. In practice:
 * - `privateKey` present → local PrivateKeySigner → non-interactive
 * - `signStrategy.openKeyAutoSign === true` → OpenKey /api/delegate/sign → non-interactive
 * - `signer` only, no `privateKey`, no OpenKey strategy → interactive (browser wallet)
 */
function isInteractiveSigner(config: TinyCloudNodeConfig): boolean {
  if (config.privateKey) {
    // Local key: always non-interactive.
    return false;
  }
  if (isOpenKeyAutoSignStrategy(config.signStrategy)) {
    // OpenKey auto-sign path: non-interactive.
    return false;
  }
  // External signer with no auto-sign strategy. Treat as interactive.
  return config.signer !== undefined;
}

function didPrincipalMatches(actual: string, expected: string): boolean {
  try {
    return principalDidEquals(actual, expected);
  } catch {
    return actual === expected;
  }
}

function clonePersistedSessionJwk(jwk: unknown): object {
  if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new Error("Persisted session has an invalid private Ed25519 session key.");
  }

  try {
    const serialized = JSON.stringify(jwk);
    const cloned = serialized === undefined ? undefined : JSON.parse(serialized);
    if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
      throw new Error("invalid JWK object");
    }
    return cloned;
  } catch {
    throw new Error("Persisted session has an invalid private Ed25519 session key.");
  }
}

function cloneRecapCaveats(
  caveats: readonly Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  if (!caveats) return [];
  const cloneJson = (value: unknown): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw new Error("ReCap caveats must contain only JSON values.");
    }
    if (Array.isArray(value)) return value.map(cloneJson);
    if (typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("ReCap caveats must contain only JSON values.");
      }
      const copy: Record<string, unknown> = Object.create(null);
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        copy[key] = cloneJson(nested);
      }
      return copy;
    }
    throw new Error("ReCap caveats must contain only JSON values.");
  };
  try {
    return JSON.parse(JSON.stringify(caveats.map(cloneJson))) as Record<string, unknown>[];
  } catch {
    throw new Error("Verified persisted session ReCap contains invalid caveats.");
  }
}

/** One replaceable set of services bound to a single host/session authority. */
class ServiceGraphLifetime {
  private readonly abortController = new AbortController();
  private readonly contexts = new Set<ServiceContext>();
  private retired = false;

  constructor(
    private readonly invokeFn: InvokeFunction,
    private readonly invokeAnyFn: InvokeAnyFunction,
    private readonly fetchFn: FetchFunction,
  ) {}

  readonly invoke: InvokeFunction = (session, service, path, action, facts) => {
    this.assertActive();
    return this.invokeFn(session, service, path, action, facts);
  };

  readonly invokeAny: InvokeAnyFunction = (session, entries, facts) => {
    this.assertActive();
    return this.invokeAnyFn(session, entries, facts);
  };

  readonly fetch: FetchFunction = (url, init) => {
    this.assertActive();
    return this.fetchFn(url, {
      ...init,
      signal: this.combineSignals(init?.signal),
    });
  };

  track(context: ServiceContext): ServiceContext {
    this.assertActive();
    this.contexts.add(context);
    return context;
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.abortController.abort();
    try {
      for (const context of this.contexts) {
        try {
          const retire = (context as ServiceContext & { retire?: () => void }).retire;
          if (retire) retire.call(context);
          else context.abort();
        } catch (error) {
          // Graph replacement is committed before retirement. A custom
          // service's best-effort cleanup must not roll that replacement back
          // or leave later contexts active.
          console.error("Error retiring service graph context:", error);
        }
      }
    } finally {
      this.contexts.clear();
    }
  }

  assertActive(): void {
    if (this.retired) {
      throw new Error("Service graph has been retired by session replacement.");
    }
  }

  private combineSignals(signal?: AbortSignal): AbortSignal {
    if (!signal) return this.abortController.signal;
    const combined = new AbortController();
    const abort = () => combined.abort();
    if (signal.aborted || this.abortController.signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
      this.abortController.signal.addEventListener("abort", abort, { once: true });
    }
    return combined.signal;
  }
}

export class UnsupportedSessionRestoreError extends Error {
  readonly code = "RESTORE_SESSION_KEY_REPLACEMENT_UNSUPPORTED" as const;

  constructor(reason = "it cannot replace and enumerate every live session signer") {
    super(`Persisted session restore is unsupported by this WASM binding because ${reason}.`);
    this.name = "UnsupportedSessionRestoreError";
  }
}

function canonicalRestoredVerificationMethod(
  canonicalVerificationMethod: string,
  persistedVerificationMethod: unknown,
): string | undefined {
  if (typeof persistedVerificationMethod !== "string") return undefined;
  const principal = canonicalVerificationMethod.split("#", 1)[0];
  return persistedVerificationMethod === principal ||
    persistedVerificationMethod === canonicalVerificationMethod
    ? canonicalVerificationMethod
    : undefined;
}

function persistedExpiry(value: unknown): Date {
  if (typeof value !== "string") {
    throw new Error("Persisted session without a SIWE expiration must include expiresAt.");
  }
  const expiry = new Date(value);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new Error("Persisted session expiry is invalid or expired.");
  }
  return expiry;
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function sharingActionsToAbilities(path: string, actions: string[]): AbilitiesMap | undefined {
  const abilities: AbilitiesMap = {};

  for (const action of actions) {
    const slash = action.indexOf("/");
    if (slash === -1) return undefined;

    const shortService = SERVICE_LONG_TO_SHORT[action.slice(0, slash)];
    if (shortService === undefined) return undefined;

    abilities[shortService] ??= {};
    abilities[shortService][path] ??= [];
    abilities[shortService][path].push(action);
  }

  return Object.keys(abilities).length > 0 ? abilities : undefined;
}

/**
 * Configuration for TinyCloudNode.
 * All fields are optional - TinyCloudNode can work with zero configuration.
 */
export interface TinyCloudNodeConfig {
  /** Hex-encoded private key (with or without 0x prefix). Optional - only needed for wallet mode and signIn() */
  privateKey?: string;
  /** Custom signer implementation. If provided, takes precedence over privateKey. */
  signer?: ISigner;
  /** Strategy for root signature requests. Defaults to auto-sign for local keys. */
  signStrategy?: SignStrategy;
  /** Explicit TinyCloud server URL. When omitted, signIn resolves the user's host. */
  host?: string;
  /** TinyCloud location registry URL. Default: https://registry.tinycloud.xyz. */
  tinycloudRegistryUrl?: string | null;
  /** Fallback TinyCloud hosts. Default: hosted TinyCloud node. */
  tinycloudFallbackHosts?: string[] | null;
  /** Probe for a locally-running TinyCloud node before registry/fallback resolution. Default: true. */
  autoDiscoverLocalNode?: boolean;
  /** Local loopback node URL to probe. Default: http://127.0.0.1:8000. */
  localNodeUrl?: string;
  /** Known `*.local.tinycloud.link` subdomain name, probed directly. */
  localLinkName?: string;
  /** Expected local node DID. A locally-discovered node whose DID differs is rejected. */
  expectedNodeDid?: string;
  /** Space prefix for this user's space. Optional - only needed for signIn() */
  prefix?: string;
  /** Domain for SIWE messages (default: derived from host) */
  domain?: string;
  /** Session expiration time in milliseconds (default: 1 hour) */
  sessionExpirationMs?: number;
  /** Whether to automatically create space if it doesn't exist (default: false) */
  autoCreateSpace?: boolean;
  /** Custom session storage implementation (default: MemorySessionStorage) */
  sessionStorage?: ISessionStorage;
  /** Whether to include public space capabilities in the session (default: true).
   * When true, signIn() automatically includes capabilities for the user's public space,
   * accessible via spaces.get('public').kv */
  enablePublicSpace?: boolean;
  /** Custom WASM bindings (default: @tinycloud/node-sdk-wasm). Used by browser wrapper. */
  wasmBindings?: IWasmBindings;
  /** Notification handler for sign-in/sign-out/error events (default: SilentNotificationHandler) */
  notificationHandler?: INotificationHandler;
  /** ENS resolver for resolving .eth names in delegation methods */
  ensResolver?: IENSResolver;
  /** Custom space creation handler (default: auto-approve when autoCreateSpace is true) */
  spaceCreationHandler?: ISpaceCreationHandler;
  /**
   * SIWE nonce override. If omitted, the WASM layer generates a random nonce.
   * If `siweConfig.nonce` is also provided, `siweConfig.nonce` wins.
   */
  nonce?: string;
  /** Optional SIWE configuration overrides (e.g., nonce for server-provided nonces) */
  siweConfig?: SiweConfig;
  /**
   * App manifest driving the SIWE recap at sign-in.
   *
   * When set, `signIn()` resolves the manifest, unions the app's own
   * permissions with every manifest-declared delegation's permissions,
   * and uses that union as the session's granted capabilities — NOT
   * the legacy `defaultActions` table. This is what makes
   * `delegateTo(manifestDeclaredDid, permissions)` work without a
   * wallet prompt: the session key's recap already covers the
   * delegation target's needs at sign-in time.
   *
   * When omitted, `signIn()` falls back to `defaultActions` for
   * backwards compatibility with callers that pre-date the manifest
   * flow.
   */
  manifest?: Manifest | Manifest[];
  /** Pre-composed manifest request. Takes precedence over `manifest`. */
  capabilityRequest?: ComposedManifestRequest;
  /** Include implicit account registry permissions when composing `manifest`. Default true. */
  includeAccountRegistryPermissions?: boolean;
  /** Run canonical first-account bootstrap when fresh account state is detected. Default true. */
  autoBootstrapAccount?: boolean;
  /** Default-off service telemetry. */
  telemetry?: TelemetryConfig;
}

/**
 * Options for {@link TinyCloudNode.delegateTo}.
 *
 * `expiry` accepts either an ms-format duration string (e.g. `"7d"`, `"1h"`)
 * or a raw number of milliseconds. When omitted, the default is 1 hour.
 *
 * `forceWalletSign` bypasses the derivability check and sends the
 * delegation through the legacy wallet-signed SIWE path, which always
 * triggers a wallet prompt. Used for testing, for explicit wallet
 * confirmation flows, and by the legacy `createDelegation` fallback.
 */
export interface DelegateToOptions {
  /** Override expiry. ms-format string ("7d", "1h") or raw milliseconds. */
  expiry?: string | number;
  /** Force the wallet-signed SIWE path even if the caps are derivable. Default false. */
  forceWalletSign?: boolean;
}

/**
 * Result of {@link TinyCloudNode.delegateTo}.
 *
 * `prompted` indicates whether a wallet prompt was shown — `true` for the
 * legacy wallet path (always), `false` for the session-key UCAN path (never).
 * Callers wiring single-prompt sign-in flows use this to assert that their
 * capability chain was derivable.
 */
export interface DelegateToResult {
  delegation: PortableDelegation;
  prompted: boolean;
}

/**
 * Options for runtime permission escalation.
 */
export interface RuntimePermissionGrantOptions {
  /** Override expiry. ms-format string ("7d", "1h") or raw milliseconds. */
  expiry?: string | number;
}

interface RuntimePermissionOperation {
  spaceId?: string;
  resource?: string;
  service: string;
  path: string;
  action: string;
  /** Exact signed ReCap attenuation for this action, if any. */
  caveats?: Record<string, unknown>[];
}

interface RuntimePermissionGrant {
  session: ServiceSession;
  delegation: PortableDelegation;
  operations: RuntimePermissionOperation[];
  expiresAt: Date;
  /**
   * Where this grant came from. Drives precedence in
   * {@link TinyCloudNode.findGrantForOperations} (a `"primary"` grant — the
   * synthetic representation of the base session's own recap — always
   * out-ranks other covering grants) and gates the public-surface guardrails
   * that must never surface the synthetic primary grant. Optional so existing
   * test constructors and older call sites remain valid.
   */
  provenance?: "primary" | "bootstrap" | "delegated" | "runtime";
}

type CanonicalizableEncryptionJson = CanonicalJson;
type NetworkInvocationFact = object;

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triplet = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    if (i + 1 < bytes.length) output += alphabet[(triplet >> 6) & 63];
    if (i + 2 < bytes.length) output += alphabet[triplet & 63];
  }
  return output;
}

function base64UrlDecode(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new Error("invalid base64url input");
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

async function signJwtInputWithJwk(
  signingInput: string,
  jwk: object,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(signingInput);
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error("WebCrypto subtle API is unavailable");
    }
    const key = await subtle.importKey(
      "jwk",
      jwk as any,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, bytes));
  } catch {
    const nodeCrypto = await import("node:crypto");
    const key = nodeCrypto.createPrivateKey({ key: jwk as any, format: "jwk" });
    return new Uint8Array(nodeCrypto.sign(null, Buffer.from(bytes), key));
  }
}

async function rewriteInvocationAudience(
  authorization: string,
  audience: string,
  jwk: object,
): Promise<string> {
  const [headerPart, payloadPart] = authorization.split(".");
  if (!headerPart || !payloadPart) {
    throw new Error("invalid invocation authorization");
  }
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  payload.aud = audience;
  const signingInput = `${base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  )}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const signature = await signJwtInputWithJwk(signingInput, jwk);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function authorizationHeader(headers: Record<string, string> | [string, string][]): string {
  if (Array.isArray(headers)) {
    const entry = headers.find(([name]) => name.toLowerCase() === "authorization");
    if (!entry) {
      throw new Error("network invocation did not include an Authorization header");
    }
    return entry[1];
  }
  const value = headers.Authorization ?? headers.authorization;
  if (!value) {
    throw new Error("network invocation did not include an Authorization header");
  }
  return value;
}

/**
 * High-level TinyCloud API for Node.js environments.
 *
 * Each user creates their own TinyCloudNode instance with their private key.
 * The instance manages the user's session and provides access to their space.
 */
/** @internal */
export interface NodeDefaults {
  createWasmBindings: () => IWasmBindings;
  createSigner: (privateKey: string, chainId?: number) => ISigner;
}

export class TinyCloudNode {
  /** @internal Registered by importing @tinycloud/node-sdk (not /core) */
  private static nodeDefaults?: NodeDefaults;

  /** @internal Register Node.js-specific defaults (NodeWasmBindings, PrivateKeySigner) */
  static registerNodeDefaults(defaults: NodeDefaults): void {
    TinyCloudNode.nodeDefaults = defaults;
  }

  private config: TinyCloudNodeConfig;
  private readonly explicitHost?: string;
  private signer: ISigner | null = null;
  private auth: NodeUserAuthorization | null = null;
  private tc: TinyCloud | null = null;
  private _address?: string;
  private _chainId: number = 1;
  private wasmBindings: IWasmBindings;
  private sessionManager: ISessionManager;
  private _serviceGraph!: ServiceGraphLifetime;
  private _serviceContext?: ServiceContext;
  private _kv?: KVService;
  private _sql?: SQLService;
  private _duckdb?: DuckDbService;
  private _hooks?: HooksService;
  private _vault?: DataVaultService;
  private _encryption?: EncryptionService;
  private _baseVaults = new Map<string, DataVaultService>();
  private _baseSecrets = new Map<string, ISecretsService>();
  private _secrets = new Map<string, ISecretsService>();
  private _account?: AccountService;
  /** Cached public KV with proper delegation (set by ensurePublicSpace) */
  private _publicKV?: KVService;

  /** Session key ID - always available */
  private sessionKeyId: string;
  /** Session key JWK as object - always available */
  private sessionKeyJwk: object;

  /** Notification handler for user-facing events */
  private notificationHandler: INotificationHandler;

  // v2 services (initialized in constructor)
  private _capabilityRegistry: CapabilityKeyRegistry;
  private _keyProvider: WasmKeyProvider;
  private _sharingService: SharingService;
  // These are initialized after signIn()
  private _delegationManager?: DelegationManager;
  private _spaceService?: SpaceService;
  private runtimePermissionGrants: RuntimePermissionGrant[] = [];
  /**
   * Memoized `recapOperationsFromSession` result, keyed by the exact SIWE it
   * was parsed from. The primary session is stable for the life of a sign-in,
   * so this avoids re-parsing the recap on every registration.
   */
  private _recapOperationsCache?: { siwe: string; operations: RuntimePermissionOperation[] };

  /**
   * TinyCloudSession captured by {@link restoreSession} when there's no
   * auth-layer signer available (session-only mode used by OpenKey-backed
   * CLI restores, public-space replays, …). Read by
   * {@link currentTinyCloudSession} as a fallback for `auth.tinyCloudSession`.
   */
  private _restoredTcSession?: TinyCloudSession;

  /**
   * True when the last signIn() detected an interactive signer and skipped
   * client-side bootstrap. Apps can read this to know whether bootstrap was
   * deferred to the server (OpenKey) or requires a separate user action.
   */
  private _bootstrapSkipped = false;

  /**
   * Outcome of the last signIn()'s account-bootstrap attempt. `skipped` is
   * true when bootstrap did not complete (interactive signer, auto-sign
   * denied, or a bootstrap step failed); `reason` carries the cause so apps
   * can surface a "finish account setup" call-to-action.
   */
  private _bootstrapStatus: { skipped: boolean; reason?: string } = {
    skipped: false,
  };

  /** Whether the last signIn() skipped client-side bootstrap because the
   * signer is interactive (browser wallet / EIP-1193 provider). */
  get bootstrapSkipped(): boolean {
    return this._bootstrapSkipped;
  }

  /** Outcome of the last signIn()'s account-bootstrap attempt. */
  get bootstrapStatus(): { skipped: boolean; reason?: string } {
    return this._bootstrapStatus;
  }

  private get nodeFeatures(): string[] {
    return this.auth?.nodeFeatures ?? [];
  }

  /** SIWE domain — uses config override or defaults to app.tinycloud.xyz */
  private get siweDomain(): string {
    return this.config.domain ?? 'app.tinycloud.xyz';
  }

  private readonly invokeWithRuntimePermissions: InvokeFunction = (
    session,
    service,
    path,
    action,
    facts,
  ) => {
    const operation: RuntimePermissionOperation = {
      spaceId: session.spaceId,
      service: this.invocationServiceName(service),
      path,
      action,
    };
    const grant = this.findGrantForOperation(operation);
    const grantedOperation = grant?.operations.find((candidate) =>
      this.operationCovers(candidate, operation),
    );
    const invocationSession = !grant || grant.provenance === "primary"
      ? session
      : grant.session;

    // The legacy single-capability binding has no caveat parameter.  Calling
    // it for a restored caveated grant would silently broaden the authority,
    // so mint the equivalent one-entry aggregate invocation instead.
    if ((grantedOperation?.caveats?.length ?? 0) > 0) {
      if (!this.wasmBindings.invokeAny) {
        throw new Error("WASM binding does not support caveat-preserving invocation");
      }
      return this.wasmBindings.invokeAny(invocationSession, [{
        spaceId: invocationSession.spaceId,
        service,
        path,
        action,
        caveats: cloneRecapCaveats(grantedOperation!.caveats),
      }], facts);
    }

    return this.wasmBindings.invoke(invocationSession, service, path, action, facts);
  };

  private readonly invokeAnyWithRuntimePermissions: InvokeAnyFunction = (
    session,
    entries,
    facts,
  ) => {
    if (!this.wasmBindings.invokeAny) {
      throw new Error("WASM binding does not support invokeAny");
    }
    const operations = entries.flatMap((entry) => {
      const operation = this.operationFromInvokeAnyEntry(entry);
      return operation ? [operation] : [];
    });
    const grant = this.findGrantForOperations(operations);
    // When the primary grant wins, invoke with the PASSED session (its scoped
    // target `spaceId`), not the stored primary `ServiceSession` — see
    // `selectInvocationSession` for the wrong-space rationale (TC-111 follow-up).
    const invocationSession =
      !grant || grant.provenance === "primary" ? session : grant.session;
    const caveatPreservingEntries = grant
      ? entries.map((entry) => {
        const requested = this.operationFromInvokeAnyEntry(entry);
        const granted = requested && grant.operations.find((candidate) =>
          this.operationCovers(candidate, requested),
        );
        if (!granted?.caveats?.length) {
          return entry;
        }
        if (entry.caveats !== undefined &&
          !recapCaveatsEqual(entry.caveats, granted.caveats)) {
          throw new Error("Invocation caveats do not match signed ReCap authority.");
        }
        return { ...entry, caveats: cloneRecapCaveats(granted.caveats) };
      })
      : entries;
    return this.wasmBindings.invokeAny(invocationSession, caveatPreservingEntries, facts);
  };

  /**
   * Create a new TinyCloudNode instance.
   *
   * All configuration is optional. Without a privateKey, the instance operates
   * in "session-only" mode where it can receive delegations but cannot create
   * its own space via signIn().
   *
   * @param config - Configuration options (all optional)
   *
   * @example
   * ```typescript
   * // Session-only mode - can receive delegations
   * const bob = new TinyCloudNode();
   * console.log(bob.did); // did:key:z6Mk... - available immediately
   *
   * // Wallet mode - can create own space
   * const alice = new TinyCloudNode({
   *   privateKey: process.env.ALICE_PRIVATE_KEY,
   *   prefix: "myapp",
   * });
   * await alice.signIn();
   * ```
   */
  constructor(config: TinyCloudNodeConfig = {}) {
    this.explicitHost = config.host;

    // Store config with default host
    this.config = {
      ...config,
      host: config.host ?? DEFAULT_HOST,
    };

    // Initialize WASM bindings (uses registered Node defaults if not provided)
    if (config.wasmBindings) {
      this.wasmBindings = config.wasmBindings;
    } else if (TinyCloudNode.nodeDefaults) {
      this.wasmBindings = TinyCloudNode.nodeDefaults.createWasmBindings();
    } else {
      throw new Error(
        "wasmBindings must be provided in config. " +
        "Import from '@tinycloud/node-sdk' (not '/core') for automatic Node.js defaults."
      );
    }

    // Always create session manager and session key immediately
    this.sessionManager = this.wasmBindings.createSessionManager();

    // Try to use "default" key, create if it doesn't exist
    const defaultKeyId = "default";
    let jwkStr = this.sessionManager.jwk(defaultKeyId);
    if (jwkStr) {
      // Key already exists, reuse it
      this.sessionKeyId = defaultKeyId;
    } else {
      // Create new key
      this.sessionKeyId = this.sessionManager.createSessionKey(defaultKeyId);
      jwkStr = this.sessionManager.jwk(this.sessionKeyId);
    }

    if (!jwkStr) {
      throw new Error("Failed to get session key JWK");
    }
    this.sessionKeyJwk = JSON.parse(jwkStr);

    this._serviceGraph = this.createServiceGraphLifetime();

    // Initialize capability registry for all users (needed for tracking received delegations)
    this._capabilityRegistry = new CapabilityKeyRegistry();

    // Initialize KeyProvider for SharingService
    this._keyProvider = new WasmKeyProvider({
      sessionManager: this.sessionManager,
    });

    // Initialize notification handler
    this.notificationHandler = config.notificationHandler ?? new SilentNotificationHandler();

    // Initialize SharingService for receive-only access (no session required)
    // This allows session-only users to receive sharing links without signIn()
    // Full capabilities (generate) are added after signIn()
    const receiveOnlyGraph = this._serviceGraph;
    this._sharingService = new SharingService({
      hosts: [this.config.host!],
      // session: undefined - not needed for receive()
      invoke: receiveOnlyGraph.invoke,
      fetch: receiveOnlyGraph.fetch,
      assertActive: () => receiveOnlyGraph.assertActive(),
      keyProvider: this._keyProvider,
      registry: this._capabilityRegistry,
      createDelegationWasm: (params) => this.createDelegationWrapper(params),
      computeCid: (data, codec) => {
        if (!this.wasmBindings.computeCid) throw new Error("computeCid is unavailable");
        return this.wasmBindings.computeCid(data, codec);
      },
      // delegationManager: undefined - not needed for receive()
      createKVService: (config) => {
        // Use pathPrefix as the KV service prefix for sharing links
        // Strip trailing slash to match DelegatedAccess behavior
        const prefix = config.pathPrefix?.replace(/\/$/, '');
        const kvService = new KVService({ prefix });
        // Create a new service context for the KV service
        const kvContext = receiveOnlyGraph.track(new ServiceContext({
          invoke: config.invoke,
          fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
          hosts: config.hosts,
          telemetry: this.config.telemetry,
        }));
        kvContext.setSession(config.session);
        kvService.initialize(kvContext);
        return kvService;
      },
    });

    // Set up wallet/auth if signer or privateKey is provided
    if (config.signer) {
      this.signer = config.signer;
      this.setupAuth(config);
    } else if (config.privateKey) {
      if (!TinyCloudNode.nodeDefaults) {
        throw new Error(
          "privateKey requires PrivateKeySigner. Either provide a signer in config, " +
          "or import from '@tinycloud/node-sdk' (not '/core') for automatic Node.js defaults."
        );
      }
      this.signer = TinyCloudNode.nodeDefaults.createSigner(config.privateKey, this._chainId);
      this.setupAuth(config);
    }
  }

  /**
   * Set up authorization handler and TinyCloud instance.
   * @internal
   */
  private setupAuth(config: TinyCloudNodeConfig): void {
    const useBootstrapSignInRequest = this.shouldUseBootstrapSignInRequest(config);
    this.auth = new NodeUserAuthorization({
      signer: this.signer!,
      signStrategy: config.signStrategy ?? { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionManager: this.sessionManager,
      sessionStorage: config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: config.prefix,
      sessionExpirationMs: config.sessionExpirationMs ?? DEFAULT_SESSION_EXPIRATION_MS,
      tinycloudHosts: this.explicitHost ? [this.explicitHost] : undefined,
      tinycloudRegistryUrl: config.tinycloudRegistryUrl,
      tinycloudFallbackHosts: config.tinycloudFallbackHosts,
      autoDiscoverLocalNode: config.autoDiscoverLocalNode,
      localNodeUrl: config.localNodeUrl,
      localLinkName: config.localLinkName,
      expectedNodeDid: config.expectedNodeDid,
      autoCreateSpace: useBootstrapSignInRequest ? false : config.autoCreateSpace,
      enablePublicSpace: config.enablePublicSpace ?? true,
      spaceCreationHandler: useBootstrapSignInRequest
        ? undefined
        : config.spaceCreationHandler,
      nonce: config.nonce,
      siweConfig: config.siweConfig,
      manifest: useBootstrapSignInRequest ? undefined : config.manifest,
      capabilityRequest: useBootstrapSignInRequest
        ? BOOTSTRAP_SESSION_REQUESTS.default
        : config.capabilityRequest,
      includeAccountRegistryPermissions: useBootstrapSignInRequest
        ? false
        : config.includeAccountRegistryPermissions,
    });

    this.tc = new TinyCloud(this.auth, {
      invokeAny: this.invokeAnyWithRuntimePermissions,
      telemetry: config.telemetry,
    });
  }

  private shouldUseBootstrapSignInRequest(config: TinyCloudNodeConfig): boolean {
    return config.autoBootstrapAccount !== false &&
      config.manifest === undefined &&
      config.capabilityRequest === undefined &&
      (config.prefix ?? "default") === "default" &&
      isOpenKeyAutoSignStrategy(config.signStrategy);
  }

  private createServiceGraphLifetime(): ServiceGraphLifetime {
    return new ServiceGraphLifetime(
      this.invokeWithRuntimePermissions,
      this.invokeAnyWithRuntimePermissions,
      // Resolve fetch at request time. This keeps the graph-owned lifetime
      // signal while preserving the SDK's existing injectable global fetch
      // behavior (including adapters that install it after construction).
      (url, init) => globalThis.fetch(url, init),
    );
  }

  private syncResolvedHostFromAuth(): void {
    const host = this.auth?.hosts[0];
    if (host) {
      this.config.host = host;
    }
  }

  /**
   * Install or replace the manifest that drives the SIWE recap at
   * sign-in. Takes effect on the next `signIn()` call — the current
   * session (if any) is not touched. Wire this up from a higher
   * layer (e.g. TinyCloudWeb.setManifest) so the manifest is kept
   * in sync across the stack.
   */
  setManifest(manifest: Manifest | Manifest[] | undefined): void {
    if (!this.auth) {
      // Session-only mode has no auth handler, so there's nothing to
      // update. The caller almost certainly wanted wallet mode — fail
      // loudly rather than silently dropping the manifest.
      throw new Error(
        "setManifest requires wallet mode. Provide a signer or privateKey in the TinyCloudNode config.",
      );
    }
    this.config.manifest = manifest;
    this.config.capabilityRequest = undefined;
    this.auth.setManifest(manifest);
  }

  setCapabilityRequest(request: ComposedManifestRequest | undefined): void {
    if (!this.auth) {
      throw new Error(
        "setCapabilityRequest requires wallet mode. Provide a signer or privateKey in the TinyCloudNode config.",
      );
    }
    this.config.capabilityRequest = request;
    this.config.manifest = request?.manifests;
    this.auth.setCapabilityRequest(request);
  }

  /**
   * Return the manifest currently installed on the auth handler,
   * or `undefined` if none is set.
   */
  get manifest(): Manifest | Manifest[] | undefined {
    return this.auth?.manifest;
  }

  get capabilityRequest(): ComposedManifestRequest | undefined {
    return this.auth?.capabilityRequest;
  }

  get hosts(): string[] {
    const authHosts = this.auth?.hosts ?? [];
    return authHosts.length > 0 ? authHosts : [this.config.host!];
  }

  /**
   * Get the primary identity DID for this user.
   * - If wallet connected and signed in: returns PKH DID (did:pkh:eip155:{chainId}:{address})
   * - If session-only mode: returns session key DID (did:key:z6Mk...)
   *
   * Use this for delegations - it always returns the appropriate identity.
   */
  get did(): string {
    // If wallet is connected and signed in, return PKH (persistent identity)
    if (this._address) {
      return pkhDid(this._address, this._chainId);
    }
    // Session-only mode: return session key DID (ephemeral identity)
    return this.sessionManager.getDID(this.sessionKeyId);
  }

  /**
   * Get the session key DID. Always available.
   * Format: did:key:z6Mk...#z6Mk...
   *
   * Use this when you specifically need the session key, not the user identity.
   */
  get sessionDid(): string {
    return this.sessionManager.getDID(this.sessionKeyId);
  }

  /**
   * Return the current session's signed ReCap capabilities after the session
   * has been authenticated or restored. This is intentionally distinct from
   * installed runtime delegations: it reports base-session authority only.
   *
   * Invalid or unparseable signed ReCap material throws so callers fail closed
   * rather than treating a malformed session as unrestricted authority.
   */
  getVerifiedSessionCapabilities(): PermissionEntry[] {
    const session = this.currentTinyCloudSession();
    if (!session || !session.siwe) return [];
    return parseRecapCapabilities(
      (siwe: string) => this.parseRecapWithCaveats(siwe),
      session.siwe,
    ).map((entry) => entry.service === "tinycloud.encryption"
      ? {
        service: entry.service,
        path: entry.path,
        actions: [...entry.actions],
        ...(entry.caveats === undefined ? {} : { caveats: entry.caveats }),
      }
      : entry);
  }

  /**
   * Get the Ethereum address for this user.
   */
  get address(): string | undefined {
    return this.auth?.address() ?? this._address;
  }

  /**
   * Check if this instance is in session-only mode (no wallet).
   * In session-only mode, the instance can receive delegations but cannot
   * create its own space via signIn().
   */
  get isSessionOnly(): boolean {
    return this.signer === null;
  }

  /**
   * Get the space ID for this user.
   * Available after signIn().
   */
  get spaceId(): string | undefined {
    return this.auth?.tinyCloudSession?.spaceId;
  }

  /**
   * Get the account space ID for this wallet identity.
   * Available after wallet-backed sign-in or a restored session with address metadata.
   */
  get accountSpaceId(): string | undefined {
    if (!this._address) {
      return undefined;
    }
    return this.wasmBindings.makeSpaceId(this._address, this._chainId, ACCOUNT_REGISTRY_SPACE);
  }

  /**
   * Account-level application and delegation helpers.
   */
  get account(): AccountService {
    if (!this._account) {
      this._account = new AccountService({
        getDid: () => this.did,
        getHost: () => this.hosts[0] ?? this.config.host!,
        getPrimarySpaceId: () => this.spaceId,
        getAccountSpaceId: () => this.accountSpaceId,
        getSpaces: () => this.spaces,
        getDelegationManager: () => this.delegationManager,
        getAccountDb: () =>
          this.accountSpaceId
            ? this.sqlForSpace(this.accountSpaceId).db("account")
            : undefined,
        ensureAccountSpaceHosted: async () => {
          if (this.accountSpaceId && this.auth) {
            await this.ensureOwnedSpaceHostedById(this.accountSpaceId);
          }
        },
      });
    }
    return this._account;
  }

  /**
   * Get the current TinyCloud session.
   * Available after signIn().
   */
  get session(): TinyCloudSession | undefined {
    return this.auth?.tinyCloudSession;
  }

  /**
   * Get the currently active session in the shape callers can persist and later
   * pass back to {@link restoreSession}.
   */
  get restorableSession(): TinyCloudSession | undefined {
    return this.currentTinyCloudSession();
  }

  /**
   * Sign in and create a new session.
   * This creates the user's space if it doesn't exist.
   * Requires wallet mode (privateKey in config).
   *
   * @param options - Optional per-call SIWE overrides for this sign-in only
   */
  async signIn(options?: SignInOptions): Promise<void> {
    if (!this.signer || !this.tc) {
      throw new Error(
        "Cannot signIn() in session-only mode. Provide a privateKey in config to create your own space."
      );
    }

    // Ensure WASM is ready (critical for browser where WASM loads asynchronously)
    await this.wasmBindings.ensureInitialized?.();

    this._address = canonicalizeAddress(await this.signer.getAddress());
    this._chainId = await this.signer.getChainId();

    // Reset services so they get recreated with new session
    this._kv = undefined;
    this._sql = undefined;
    this._duckdb = undefined;
    this._hooks = undefined;
    this._vault = undefined;
    this._encryption = undefined;
    this._baseVaults.clear();
    this._baseSecrets.clear();
    this._secrets.clear();
    this._spaceService = undefined;
    this._serviceContext = undefined;
    this.runtimePermissionGrants = [];

    await this.tc.signIn(options);
    this.syncResolvedHostFromAuth();

    // Bind the replacement services to the runtime dependencies active for
    // this sign-in and permanently retire anything captured from the previous
    // session. The authorization flow above remains transactional: a rejected
    // sign-in leaves the existing graph untouched.
    const oldGraph = this._serviceGraph;
    this._serviceGraph = this.createServiceGraphLifetime();
    oldGraph.retire();
    this.tc.retireServices();

    // NodeUserAuthorization renames the constructor's "default" key when it
    // creates the signed-in session. Keep node-level key accessors in sync so
    // sessionDid and delegation flows use the active key instead of the old ID.
    const signedInSession = this.currentTinyCloudSession();
    if (signedInSession) {
      this.sessionKeyId = signedInSession.sessionKey;
      this.sessionKeyJwk = signedInSession.jwk;
    }

    // Initialize service context with session
    this.initializeServices();

    // Register the primary session's own recap as the highest-trust
    // (`provenance: "primary"`) runtime grant so it always wins invocation
    // selection over broader bootstrap/delegated grants (TC-111). Must run
    // after the primary session is established and after grants were cleared
    // above, so no dupes. `lastActivationSkippedSpaceIds` was already
    // populated by the auth layer's session activation inside `tc.signIn`
    // above, so the skipped-activation exclusion sees the real skip set here.
    const primarySession = this.currentTinyCloudSession();
    if (primarySession) {
      this.registerPrimarySessionGrant(primarySession);
    }

    const bootstrapped = await this.bootstrapAccountIfNeeded();

    await this.ensureRequestedEncryptionNetworks();

    if (
      !bootstrapped &&
      this.config.manifest === undefined &&
      this.config.capabilityRequest === undefined
    ) {
      await this.ensureOwnedSpaceHostedById(this.ownedSpaceId(SECRETS_SPACE));
    }

    if (!bootstrapped) {
      this.scheduleAccountRegistrySync();
    }

    this.notificationHandler.success("Successfully signed in");
  }

  private ownedSpaceId(name: string): string {
    if (!this._address) {
      throw new Error("Cannot resolve owned space before sign-in");
    }
    return this.wasmBindings.makeSpaceId(this._address, this._chainId, name);
  }

  private async bootstrapAccountIfNeeded(): Promise<boolean> {
    this._bootstrapSkipped = false;
    this._bootstrapStatus = { skipped: false };

    if (this.config.autoBootstrapAccount === false) {
      return false;
    }
    if (!this.auth || !this._address) {
      return false;
    }

    // Interactive signers (browser wallet / EIP-1193) prompt the user for
    // every signMessage() call. Running bootstrap through an interactive
    // signer would open 10+ sequential sign prompts. Skip client-side
    // bootstrap entirely: the server (OpenKey) handles bootstrap inside
    // POST /api/keys/{keyId}/sign before returning the first signature.
    if (isInteractiveSigner(this.config)) {
      console.debug(
        "[TinyCloudNode] bootstrap skipped: interactive signer detected. " +
        "Server-side bootstrap (OpenKey) is expected to have provisioned the account.",
      );
      this._bootstrapSkipped = true;
      this._bootstrapStatus = { skipped: true, reason: "interactive-signer" };
      return false;
    }

    const steps = bootstrapSteps(this._address, this._chainId);
    if (!(await this.isFreshBootstrapAccount(steps))) {
      return false;
    }

    try {
      await this.runAccountBootstrap(steps);
    } catch (err) {
      // Bootstrap is provisioning, not a precondition of the session the
      // user just signed: never fail signIn() because of it. Surface the
      // outcome instead so apps can offer a "finish account setup" action.
      const reason = err instanceof Error ? err.message : String(err);
      this._bootstrapSkipped = true;
      this._bootstrapStatus = { skipped: true, reason };
      this.notificationHandler.warning(
        `Account bootstrap did not complete: ${reason}`,
      );
      console.warn(`[TinyCloudNode] account bootstrap failed: ${reason}`);
      return false;
    }
    return true;
  }

  private async isFreshBootstrapAccount(steps: BootstrapStep[]): Promise<boolean> {
    const enshrinedSpaceIds = new Set<string>();
    for (const step of steps) {
      if (step.kind === "session") {
        enshrinedSpaceIds.add(step.spaceId);
      }
    }
    const skipped = (this.auth as NodeUserAuthorization).lastActivationSkippedSpaceIds;
    if (skipped.some((spaceId) => enshrinedSpaceIds.has(spaceId))) {
      return true;
    }

    try {
      const indexed = await this.account.index.spaces.list();
      if (indexed.ok && indexed.data.length === 0) {
        return true;
      }
    } catch {
      // A missing account index is expected before bootstrap; fall through to KV.
    }

    try {
      const spaces = await this.account.spaces.list();
      return spaces.ok && spaces.data.length === 0;
    } catch {
      return false;
    }
  }

  private async runAccountBootstrap(steps: BootstrapStep[]): Promise<void> {
    if (!this.auth || !this._address) {
      throw new Error("Account bootstrap requires an active wallet session");
    }

    const host = this.hosts[0] ?? this.config.host;
    if (!host) {
      throw new Error("Account bootstrap requires a TinyCloud host");
    }

    const auth = this.auth as NodeUserAuthorization;
    const sessions = new Map<BootstrapSpaceName, TinyCloudSession>();
    const rawAbilitiesBySpace = new Map<BootstrapSpaceName, Record<string, string[]>>();
    const primarySession = auth.tinyCloudSession;
    const defaultSpaceId = this.ownedSpaceId("default");
    const canReusePrimaryBootstrapSession =
      primarySession?.spaceId === defaultSpaceId &&
      auth.capabilityRequest === BOOTSTRAP_SESSION_REQUESTS.default;

    for (const step of steps) {
      if (step.kind !== "session") continue;
      if (step.space === "default" && canReusePrimaryBootstrapSession && primarySession) {
        sessions.set(step.space, primarySession);
        continue;
      }
      const rawAbilities = step.rawAbilities;
      if (rawAbilities) {
        rawAbilitiesBySpace.set(step.space, rawAbilities);
      }
      let session: TinyCloudSession;
      try {
        session = await auth.createBootstrapSession({
          spaceId: step.spaceId,
          capabilityRequest: step.request ?? BOOTSTRAP_SESSION_REQUESTS[step.space],
          rawAbilities,
        });
      } catch (err) {
        // Abort immediately — do not cascade into remaining bootstrap steps.
        // A single clear error is surfaced instead of one error per space.
        throw new Error(
          `Account bootstrap aborted: signature rejected for space "${step.space}". ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      sessions.set(step.space, session);
    }

    for (const step of steps) {
      if (step.kind !== "host") continue;
      const hosted = await auth.hostOwnedSpace(step.spaceId, "bootstrap-host");
      if (!hosted) {
        throw new Error(`Failed to host bootstrap space: ${step.spaceId}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    for (const step of steps) {
      if (step.kind !== "activate") continue;
      const session = sessions.get(step.space);
      if (!session) {
        throw new Error(`Missing bootstrap session for ${step.space}`);
      }
      const activated = await activateSessionWithHost(host, session.delegationHeader);
      if (!activated.success || activated.skipped?.includes(step.spaceId)) {
        throw new Error(
          `Failed to activate bootstrap session for ${step.spaceId}: ${
            activated.error ?? "space was skipped"
          }`,
        );
      }
      this.registerBootstrapRuntimeGrant(
        session,
        BOOTSTRAP_SESSION_REQUESTS[step.space],
        rawAbilitiesBySpace.get(step.space),
      );
    }

    for (const step of steps) {
      if (step.kind === "account-index-schema") {
        const ensured = await this.account.index.ensure();
        if (!ensured.ok) {
          throw new Error(`Failed to create account index schema: ${ensured.error.message}`);
        }
      }

      if (step.kind === "seed-spaces") {
        for (const space of step.spaces) {
          const registered = await this.account.spaces.register({
            spaceId: space.spaceId,
            name: space.name,
            ownerDid: this.did,
            type: "owned",
            permissions: ["*"],
            status: "active",
          });
          if (!registered.ok) {
            throw new Error(
              `Failed to seed account space ${space.spaceId}: ${registered.error.message}`,
            );
          }
        }
      }

      if (step.kind === "seed-applications") {
        const registered = await this.account.applications.register(
          step.manifests.length > 0
            ? [...step.manifests]
            : TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
        );
        if (!registered.ok) {
          throw new Error(`Failed to seed bootstrap applications: ${registered.error.message}`);
        }
      }

      if (step.kind === "encryption-network-create") {
        await this.ensureEncryptionNetwork(step.networkId);
      }

      if (step.kind === "secret-records-schema") {
        const db = this.sqlForSpace(step.spaceId).db(step.database);
        const migrated = await db.migrations.apply({
          namespace: "tinycloud.secrets.records",
          migrations: [
            {
              id: "001_initial",
              sql: [...SECRET_RECORDS_SCHEMA],
            },
          ],
        });
        if (!migrated.ok) {
          throw new Error(
            `Failed to create secret_records schema: ${migrated.error.message}`,
          );
        }
      }
    }
  }

  private registerBootstrapRuntimeGrant(
    session: TinyCloudSession,
    request: { resources: readonly { service: string; space: string; path: string; actions: readonly string[] }[] },
    rawAbilities?: Record<string, string[]>,
  ): void {
    const operations: RuntimePermissionOperation[] = [];
    for (const resource of request.resources) {
      const service = resource.service.startsWith("tinycloud.")
        ? this.shortServiceName(resource.service)
        : resource.service;
      const spaceId = resource.space.startsWith("tinycloud:")
        ? resource.space
        : this.ownedSpaceId(resource.space);
      for (const action of resource.actions) {
        operations.push({
          spaceId,
          service,
          path: resource.path,
          action,
        });
      }
    }
    for (const [resource, actions] of Object.entries(rawAbilities ?? {})) {
      for (const action of actions) {
        operations.push({
          resource,
          service: "encryption",
          path: resource,
          action,
        });
      }
    }

    const expiresAt = extractSiweExpiration(session.siwe) ?? this.getSessionExpiry();
    const actions = [...new Set(operations.map((operation) => operation.action))];
    this.runtimePermissionGrants.push({
      session: {
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: session.spaceId,
        verificationMethod: session.verificationMethod,
        jwk: session.jwk,
      },
      delegation: {
        cid: session.delegationCid,
        delegationHeader: session.delegationHeader,
        delegateDID: session.verificationMethod,
        delegatorDID: this.did,
        spaceId: session.spaceId,
        path: "",
        actions,
        expiry: expiresAt,
        allowSubDelegation: true,
        ownerAddress: session.address,
        chainId: session.chainId,
        host: this.config.host,
      },
      operations,
      expiresAt,
      provenance: "bootstrap",
    });
  }

  /**
   * Map the base session's OWN recap into runtime permission operations.
   *
   * Uses the RAW `parseRecapFromSiwe` binding — NOT `parseRecapCapabilities`,
   * whose `normalizeSpace` collapses `tinycloud:pkh:...:<owner>:<space>` to a
   * bare short name and would conflate two owners' identically-named spaces.
   * We must keep the full owner-scoped URI so a synthetic primary grant can
   * never cover an operation on a different owner's space.
   *
   * Mirrors {@link operationsFromDelegation}'s op shape: encryption network
   * entries (`urn:tinycloud:encryption:` paths) become `resource` ops; every
   * other entry becomes a `spaceId` op carrying the raw recap `space` URI.
   * One op per action.
   *
   * Returns `[]` for session-only / restored-without-siwe modes and for any
   * unparseable SIWE — the primary grant is simply not registered in that case.
   */
  private recapOperationsFromSession(
    session: TinyCloudSession,
  ): RuntimePermissionOperation[] {
    const siwe = session.siwe;
    if (!siwe) {
      return [];
    }
    if (this._recapOperationsCache?.siwe === siwe) {
      return this._recapOperationsCache.operations;
    }
    let operations: RuntimePermissionOperation[] = [];
    try {
      const entries = this.parseRecapWithCaveats(siwe);
      if (Array.isArray(entries)) {
        operations = entries.flatMap((entry) => {
          const service = this.invocationServiceName(entry.service);
          return entry.actions.map((action) => ({
            ...(this.isEncryptionNetworkOperation(service, entry.path)
              ? { resource: entry.path }
              : { spaceId: entry.space }),
            service,
            path: entry.path,
            action,
            caveats: cloneRecapCaveats(entry.caveats),
          }));
        });
      }
    } catch {
      operations = [];
    }
    this._recapOperationsCache = { siwe, operations };
    return operations;
  }

  /**
   * Register the base (primary) session's own recap as a synthetic runtime
   * grant tagged `provenance: "primary"` so it always out-ranks other covering
   * grants in {@link findGrantForOperations}. This closes the selection-design
   * hazard where a broad — possibly broken — bootstrap/delegated grant could
   * hijack an operation the primary session itself already authorized (TC-111).
   *
   * Two safety exclusions:
   *  - Ops whose space is in `lastActivationSkippedSpaceIds` are dropped: the
   *    node refused to activate those spaces this sign-in even though the recap
   *    claims them. Including them would let the synthetic primary out-rank a
   *    working grant and 401 (the "skipped-activation inverted hijack").
   *  - Encryption `resource` ops are kept as-is (space-independent).
   *
   * No-ops when nothing remains after exclusion. Callers (`signIn`,
   * `restoreSession`) clear `runtimePermissionGrants` first, so no dupes.
   */
  private registerPrimarySessionGrant(session: TinyCloudSession): void {
    const skipped = this.auth
      ? (this.auth as NodeUserAuthorization).lastActivationSkippedSpaceIds ?? []
      : [];
    const operations = this.recapOperationsFromSession(session).filter(
      (operation) =>
        operation.spaceId === undefined ||
        !skipped.some((spaceId) => this.spaceIdsEqual(spaceId, operation.spaceId!)),
    );
    if (operations.length === 0) {
      return;
    }

    const expiresAt = extractSiweExpiration(session.siwe) ?? this.getSessionExpiry();
    const actions = [...new Set(operations.map((operation) => operation.action))];
    this.runtimePermissionGrants.push({
      session: {
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: session.spaceId,
        verificationMethod: session.verificationMethod,
        jwk: session.jwk,
      },
      delegation: {
        cid: session.delegationCid,
        delegationHeader: session.delegationHeader,
        delegateDID: session.verificationMethod,
        delegatorDID: this.did,
        spaceId: session.spaceId,
        path: "",
        actions,
        expiry: expiresAt,
        allowSubDelegation: true,
        ownerAddress: session.address,
        chainId: session.chainId,
        host: this.config.host,
      },
      operations,
      expiresAt,
      provenance: "primary",
    });
  }

  private async writeManifestRegistryRecords(): Promise<void> {
    const request = this.capabilityRequest;
    if (!request || request.registryRecords.length === 0) {
      return;
    }
    if (!this.auth || !this.signer) {
      throw new Error("Manifest registry write requires wallet mode");
    }

    const accountSpaceId = this.ownedSpaceId(ACCOUNT_REGISTRY_SPACE);
    await this.ensureOwnedSpaceHostedById(accountSpaceId);

    const result = await this.account.applications.register(request.manifests);
    if (!result.ok) {
      throw new Error(
        `Failed to write manifest registry records: ${result.error.message}`,
      );
    }
  }

  private scheduleAccountRegistrySync(): void {
    void this.withAccountRegistryRetry(async () => {
      void this.account.index.ensure();
      await this.writeManifestRegistryRecords();

      if (this.currentSessionCanListSpaces()) {
        const spaces = await this.account.spaces.syncAccessible();
        if (!spaces.ok) {
          throw new Error(`Failed to sync account spaces: ${spaces.error.message}`);
        }
      }
      // Else: the current session carries a recap that does not grant
      // `tinycloud.space/list` (every manifest/recap session, and the default
      // non-manifest recap alike — its abilities table has no `space` service).
      // `syncAccessible()` depends on `tinycloud.space/list`, which such a
      // session does not hold — see {@link isOwnedSpaceRegistered} — so the
      // owned-space listing is a doomed request that 401s on the wire
      // (`Unauthorized Action: …/space/ tinycloud.space/list`). The account
      // spaces registry is instead maintained by bootstrap seeding +
      // `spaces.register()`, so we skip the invoke entirely rather than emit it.
    });
  }

  /**
   * Whether the current primary session may invoke `tinycloud.space/list`.
   *
   * A session with NO parseable recap (session-only / restored-without-siwe)
   * yields zero recap operations — we preserve today's behavior and let
   * `syncAccessible()` run. A session whose parseable recap has entries but
   * none granting `tinycloud.space/list` cannot list owned spaces; the guard
   * skips. Every wallet SIWE session in this stack carries a recap (manifest
   * sessions and the default non-manifest recap alike), and none grant
   * `space/list`, so all of them skip.
   *
   * Reuses the TC-111 {@link recapOperationsFromSession} primitive — no second
   * recap parser.
   */
  private currentSessionCanListSpaces(): boolean {
    const session = this.currentTinyCloudSession();
    const operations = session
      ? this.recapOperationsFromSession(session)
      : [];
    if (operations.length === 0) {
      return true;
    }
    return operations.some(
      (operation) =>
        operation.service === "space" &&
        this.actionContains(operation.action, "tinycloud.space/list"),
    );
  }

  private async withAccountRegistryRetry(task: () => Promise<void>): Promise<void> {
    const delays = [250, 1_000, 3_000];
    let lastError: unknown;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        await task();
        return;
      } catch (error) {
        // Authorization verdicts are deterministic, not transient: retrying an
        // `Unauthorized Action` / 401 only re-emits the doomed request (the
        // 2026-07-03 recap-storm incident). Warn once and stop; generic errors
        // still get the full retry budget below.
        const message = error instanceof Error ? error.message : String(error);
        if (/Unauthorized Action|\b401\b/.test(message)) {
          console.warn(
            "TinyCloud account registry sync stopped: authorization verdict is not retryable",
            error,
          );
          return;
        }
        lastError = error;
        if (attempt < delays.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }
    }

    console.warn(
      "TinyCloud account registry sync failed after retries",
      lastError,
    );
  }

  private requestedEncryptionNetworkIds(): string[] {
    const request = this.capabilityRequest;
    if (!request) {
      return [];
    }

    const networkIds = new Set<string>();
    for (const resource of request.resources) {
      if (
        resource.service === ENCRYPTION_PERMISSION_SERVICE &&
        resource.path.startsWith("urn:tinycloud:encryption:") &&
        resource.actions.includes(DECRYPT_ACTION)
      ) {
        networkIds.add(resource.path);
      }
    }
    return [...networkIds];
  }

  private async ensureRequestedEncryptionNetworks(): Promise<void> {
    if (!this.signer || !this.auth) {
      return;
    }

    for (const networkId of this.requestedEncryptionNetworkIds()) {
      const parsed = parseNetworkId(networkId);
      if (!didPrincipalMatches(parsed.ownerDid, this.did)) {
        continue;
      }
      await this.ensureEncryptionNetwork(networkId);
    }
  }

  private async ensureOwnedSpaceHostedById(spaceId: string): Promise<void> {
    if (!this.auth) {
      throw new Error("Owned space hosting requires wallet mode");
    }

    const session = this.auth.tinyCloudSession;
    if (!session) {
      throw new Error("Owned space hosting requires an active session");
    }

    const host = this.hosts[0] ?? this.config.host;
    if (!host) {
      throw new Error("Owned space hosting requires a TinyCloud host");
    }

    const activation = await activateSessionWithHost(host, session.delegationHeader);
    if (activation.success && !activation.skipped?.includes(spaceId)) {
      return;
    }

    if (!activation.success && activation.status !== 404) {
      throw new Error(
        `Failed to check owned space ${spaceId}: ${activation.error ?? activation.status}`,
      );
    }

    const created = await (this.auth as NodeUserAuthorization).hostOwnedSpace(spaceId);
    if (!created) {
      throw new Error(`Failed to create owned space: ${spaceId}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const retry = await activateSessionWithHost(host, session.delegationHeader);
    if (!retry.success || retry.skipped?.includes(spaceId)) {
      throw new Error(
        `Failed to activate session after creating owned space ${spaceId}: ${
          retry.error ?? "space was skipped"
        }`,
      );
    }
  }

  /**
   * Host one of this user's owned spaces by name (e.g. `"applications"`).
   *
   * Resolves the name to the owned space URI
   * (`tinycloud:pkh:eip155:<chain>:<addr>:<name>`) and registers it on the
   * server via the host-SIWE delegation flow, so subsequent KV/SQL writes to
   * that space succeed instead of returning `404 - Space not found`. The
   * caller is the root authority of their own owned spaces, so no additional
   * delegation is required.
   *
   * Unlike {@link ensureOwnedSpaceHostedById}, this always submits the host
   * delegation rather than inferring hosting from session activation: a space
   * the current session has never referenced is reported neither as
   * `activated` nor `skipped`, so activation-based detection would wrongly
   * skip the host. The host SIWE is idempotent server-side, so re-hosting an
   * existing space is a safe no-op. Must be called after {@link signIn}.
   *
   * @param name - The owned space name (e.g. `"applications"`).
   * @returns The hosted space URI.
   */
  async hostOwnedSpace(name: string): Promise<string> {
    if (!this.auth || !this.auth.tinyCloudSession) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    const spaceId = this.ownedSpaceId(name);

    const host = this.hosts[0] ?? this.config.host;
    if (!host) {
      throw new Error("Owned space hosting requires a TinyCloud host");
    }

    const hosted = await (this.auth as NodeUserAuthorization).hostOwnedSpace(
      spaceId,
    );
    if (!hosted) {
      throw new Error(`Failed to host owned space: ${spaceId}`);
    }

    // Re-activate the session so it covers the newly hosted space, and prove
    // the session can actually use it before reporting success: a successful
    // /delegate that still lists the space under `skipped` means it is not
    // hosted for this session.
    const activation = await activateSessionWithHost(
      host,
      this.auth.tinyCloudSession.delegationHeader,
    );
    if (!activation.success || activation.skipped?.includes(spaceId)) {
      throw new Error(
        `Failed to activate session for owned space ${spaceId}: ${
          activation.error ?? "space was skipped"
        }`,
      );
    }

    void this.account.spaces
      .register({
        spaceId,
        name,
        ownerDid: this.did,
        type: "owned",
        permissions: ["*"],
        status: "active",
      })
      .catch(() => {});

    return spaceId;
  }

  /**
   * Ensure one of this user's owned spaces (e.g. `"secrets"`) is hosted on the
   * server.
   *
   * At sign-in, a full-authority session auto-hosts the owner's `secrets`
   * space, but a session created with a manifest / capabilityRequest does not.
   * Such a session can therefore hold valid `tinycloud.kv/*` capabilities for
   * the owned `secrets` space yet still fail its first scoped
   * `secrets.put(...)` with `404 Space not found`, because the space was never
   * registered on the node.
   *
   * Calling this resolves `name` to the owner's owned-space URI
   * (`tinycloud:pkh:eip155:<chain>:<addr>:<name>`). It first consults the
   * account-space spaces registry (`account/spaces/{space_id}`, the canonical
   * KV source of truth, fronted by a best-effort SQLite index): if the space is
   * already registered/hosted it returns the URI WITHOUT submitting a host
   * delegation, avoiding a redundant host-SIWE signature prompt for owners who
   * already use the space. Only when the space is absent — or the registry
   * check fails for any reason (e.g. a cold SQLite index reporting
   * `no such table: spaces`) — does it fall through to {@link hostOwnedSpace}.
   *
   * The registry check is purely an optimization: any failure falls back to
   * hosting, and the host SIWE is idempotent server-side, so re-hosting an
   * existing space remains a safe no-op. Must be called after {@link signIn}.
   *
   * @param name - The owned space name (e.g. `"secrets"`).
   * @returns The hosted owned-space URI.
   */
  async ensureOwnedSpaceHosted(name: string): Promise<string> {
    if (!this.auth || !this.auth.tinyCloudSession) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    const spaceId = this.ownedSpaceId(name);

    if (await this.isOwnedSpaceRegistered(spaceId)) {
      return spaceId;
    }

    const hosted = await this.hostOwnedSpace(name);

    // hostOwnedSpace registers best-effort and fire-and-forget; await an
    // explicit registry write here so the canonical `account/spaces/{id}`
    // record is durably present and a subsequent ensure short-circuits on the
    // registry instead of re-hosting. The host already succeeded, so a failed
    // registry write must not fail this call.
    try {
      await this.account.spaces.register({
        spaceId,
        name,
        ownerDid: this.did,
        type: "owned",
        permissions: ["*"],
        status: "active",
      });
    } catch {
      // Registry write is best-effort; the space is hosted regardless.
    }

    return hosted;
  }

  /**
   * Check whether an owned space is already registered/hosted by consulting the
   * account spaces registry.
   *
   * Source of truth is the canonical KV registry record
   * `account/spaces/{space_id}`, read here via `account.spaces.get(spaceId)`.
   * The KV path is used (rather than `syncAccessible()`) because it works under
   * a manifest/recap session with NO extra prompt: the composed manifest recap
   * already grants `tinycloud.kv get/list` on the account space `spaces/`
   * prefix, whereas `syncAccessible()` depends on `tinycloud.space/list`, which
   * a recap session does not hold. Before reading, it consults the fast SQLite
   * index (`account.index.spaces.list()`) as a best-effort short-circuit; on a
   * cold index (`no such table: spaces`) or any other index failure it falls
   * back to the canonical KV read.
   *
   * This is a best-effort optimization. ANY failure of the check path (missing
   * table, KV error, missing record, thrown exception) resolves to `false` so
   * the caller falls through to hosting — per the directive, "if it fails in any
   * way then create the space".
   */
  private async isOwnedSpaceRegistered(spaceId: string): Promise<boolean> {
    // Best-effort fast path: the SQLite index. Only trust a positive hit; treat
    // misses/empties/errors/throws (e.g. a cold `no such table: spaces`) as
    // inconclusive and fall through to the canonical KV read.
    try {
      const indexed = await this.account.index.spaces.list();
      if (indexed.ok && indexed.data.some((space) => space.spaceId === spaceId)) {
        return true;
      }
    } catch {
      // Cache miss/error — fall back to canonical below.
    }

    // Canonical: the `account/spaces/{space_id}` KV record. This is the registry
    // source of truth and is recap-readable. Any failure here (missing record,
    // KV error, throw) resolves to "not registered" so the caller hosts.
    try {
      const record = await this.account.spaces.get(spaceId);
      return record.ok;
    } catch {
      return false;
    }
  }

  /**
   * Restore a previously established session from stored delegation data.
   *
   * This is used by the CLI to restore a session that was created via the
   * browser-based delegation flow (OpenKey `/delegate` page). Instead of
   * signing in with a private key, it injects the delegation data directly.
   *
   * @param sessionData - The stored delegation data from the browser flow
   */
  async restoreSession(sessionData: {
    delegationHeader: { Authorization: string };
    delegationCid: string;
    spaceId: string;
    /** Additional capability spaces persisted with the primary session. */
    spaces?: Record<string, string>;
    jwk: object;
    verificationMethod: string;
    address?: string;
    chainId?: number;
    /**
     * The SIWE message that authorized this session. Required for
     * downstream operations that need the session's expiry (e.g.
     * {@link grantRuntimePermissions}). When omitted the SDK can still
     * invoke services with the existing delegation, but anything that
     * reads `auth.tinyCloudSession.siwe` will treat the session as
     * expired-at-epoch-zero.
     */
    siwe?: string;
    /**
     * The wallet/OpenKey signature over `siwe`. When any signed-session
     * metadata is restored, this is required and verified in WASM before
     * local ReCap or expiry authority is installed.
     */
    signature?: string;
    /**
     * Persisted policy expiry. Required when an otherwise valid SIWE omits
     * `Expiration Time`; restore never invents a new renewable lifetime.
     */
    expiresAt?: string;
    /**
     * The TinyCloud hosts this session was created against (from
     * {@link PersistedSessionData.tinycloudHosts}). When present they are
     * adopted so the restored session targets the same node as the
     * original sign-in — without this, service calls fall back to the
     * default host and the auth layer throws "TinyCloud hosts have not
     * been resolved". When absent (old persisted session) hosts resolve
     * lazily via the registry/fallback on the first host-needing call.
     */
    tinycloudHosts?: string[];
  }): Promise<void> {
    // Ensure WASM is ready (critical for browser where WASM loads asynchronously)
    await this.wasmBindings.ensureInitialized?.();

    // Build every part of the restored state against a disposable manager.
    // Nothing live is touched until the commit below.
    const restoredJwk = clonePersistedSessionJwk(sessionData.jwk);
    if (
      sessionData.chainId !== undefined &&
      (!Number.isSafeInteger(sessionData.chainId) || sessionData.chainId <= 0)
    ) {
      throw new Error("Persisted session chain ID must be a positive safe integer.");
    }
    const stagedManager = this.wasmBindings.createSessionManager();
    const stagedReplace = stagedManager.replaceSessionKey;
    const liveKeys = this.sessionManager.listSessionKeys;
    const stagedKeys = stagedManager.listSessionKeys;
    if (
      typeof stagedReplace !== "function" ||
      typeof liveKeys !== "function" ||
      typeof stagedKeys !== "function"
    ) {
      throw new UnsupportedSessionRestoreError();
    }
    let stagedKeyId: string;
    let stagedJwk: object;
    let canonicalVerificationMethod: string;
    try {
      // Replacing a primary signer without a complete key inventory silently
      // loses receive/share keys. Require the capability rather than guessing.
      const keyIds = liveKeys.call(this.sessionManager);
      if (!Array.isArray(keyIds) || !keyIds.every((keyId) => typeof keyId === "string")) {
        throw new UnsupportedSessionRestoreError("it cannot reliably enumerate every live session signer");
      }
      for (const keyId of keyIds) {
        if (keyId === this.sessionKeyId) continue;
        const jwk = this.sessionManager.jwk(keyId);
        if (!jwk) throw new Error("missing live session key");
        stagedReplace.call(stagedManager, clonePersistedSessionJwk(JSON.parse(jwk)), keyId);
      }
      stagedKeyId = stagedReplace.call(stagedManager, restoredJwk, this.sessionKeyId);
      const stagedJwkJson = stagedManager.jwk(stagedKeyId);
      if (!stagedJwkJson) throw new Error("missing restored session key");
      stagedJwk = clonePersistedSessionJwk(JSON.parse(stagedJwkJson));
      canonicalVerificationMethod = stagedManager.getDID(stagedKeyId);
    } catch (error) {
      if (error instanceof UnsupportedSessionRestoreError) throw error;
      throw new Error("Persisted session has an invalid private Ed25519 session key.");
    }
    const restoredVerificationMethod = canonicalRestoredVerificationMethod(
      canonicalVerificationMethod,
      sessionData.verificationMethod,
    );
    if (!restoredVerificationMethod) {
      throw new Error(
        "Persisted session verification method does not match its private Ed25519 session key.",
      );
    }
    const proofValues = [
      sessionData.siwe,
      sessionData.signature,
      sessionData.address,
      sessionData.chainId,
    ];
    const hasPersistedProof = proofValues.every((value) => value !== undefined);
    if (!hasPersistedProof && (proofValues.some((value) => value !== undefined) || sessionData.expiresAt !== undefined)) {
      throw new Error("Persisted session authority metadata is incomplete.");
    }

    const restoredAddress = hasPersistedProof
      ? canonicalizeAddress(sessionData.address!)
      : undefined;
    let stagedSessionExpiry = new Date(0);
    let stagedRecap: WasmRecapEntry[] = [];
    if (hasPersistedProof) {
      if (typeof this.wasmBindings.validatePersistedSession !== "function") {
        throw new UnsupportedSessionRestoreError("it cannot verify persisted SIWE authority");
      }
      const verified = this.wasmBindings.validatePersistedSession({
        delegationHeader: sessionData.delegationHeader,
        delegationCid: sessionData.delegationCid,
        spaceId: sessionData.spaceId,
        jwk: stagedJwk,
        address: restoredAddress!,
        chainId: sessionData.chainId!,
        siwe: sessionData.siwe!,
        signature: sessionData.signature!,
      });
      const exactRecap = verified.verifiedRecap;
      if (!Array.isArray(exactRecap) || !exactRecap.every((entry) =>
        entry !== null && typeof entry === "object" &&
        typeof entry.service === "string" &&
        typeof entry.space === "string" &&
        typeof entry.path === "string" &&
        Array.isArray(entry.actions) && entry.actions.every((action) => typeof action === "string") &&
        Array.isArray(entry.caveats) && entry.caveats.every((caveat) =>
          caveat !== null && typeof caveat === "object" && !Array.isArray(caveat)
        )
      )) {
        throw new UnsupportedSessionRestoreError(
          "it cannot reconstruct caveat-preserving persisted ReCap authority",
        );
      }
      stagedRecap = exactRecap.map((entry) => ({
        service: entry.service,
        space: entry.space,
        path: entry.path,
        actions: [...entry.actions],
        caveats: cloneRecapCaveats(entry.caveats),
      }));
      const signedExpiry = verified.expiresAt === undefined
        ? undefined
        : persistedExpiry(verified.expiresAt);
      const persistedPolicyExpiry = sessionData.expiresAt === undefined
        ? undefined
        : persistedExpiry(sessionData.expiresAt);
      if (signedExpiry && persistedPolicyExpiry && !sameInstant(signedExpiry, persistedPolicyExpiry)) {
        throw new Error("Persisted session expiry does not match its signed SIWE authority.");
      }
      stagedSessionExpiry = signedExpiry ?? persistedPolicyExpiry ?? persistedExpiry(undefined);
    }
    const resolvedHost = await this.resolveRestoredHost(
      sessionData.tinycloudHosts,
      restoredAddress,
      sessionData.chainId,
    );
    const stagedHost = resolvedHost ?? this.config.host!;
    // Never blend a metadata-light restore with the prior wallet identity.
    const stagedAddress = restoredAddress;
    const stagedChainId = sessionData.chainId ?? 1;
    const stagedNodeDid = stagedAddress
      ? pkhDid(stagedAddress, stagedChainId)
      : canonicalVerificationMethod;
    const serviceSession: ServiceSession = {
      delegationHeader: sessionData.delegationHeader,
      delegationCid: sessionData.delegationCid,
      spaceId: sessionData.spaceId,
      verificationMethod: restoredVerificationMethod,
      jwk: stagedJwk,
    };
    const stagedTcSession: TinyCloudSession | undefined =
      hasPersistedProof ? {
        address: restoredAddress!,
        chainId: sessionData.chainId!,
        sessionKey: JSON.stringify(stagedJwk),
        spaceId: sessionData.spaceId,
        spaces: sessionData.spaces,
        delegationCid: sessionData.delegationCid,
        delegationHeader: sessionData.delegationHeader,
        verificationMethod: restoredVerificationMethod,
        jwk: stagedJwk as { [k: string]: unknown },
        siwe: sessionData.siwe!,
        signature: sessionData.signature!,
      } : undefined;
    const stagedPrimary = this.stagePrimarySessionState(
      stagedTcSession,
      stagedNodeDid,
      stagedHost,
      stagedSessionExpiry,
      stagedRecap,
    );
    const stagedGraph = this.stageRestoredServiceGraph({
      host: stagedHost,
      manager: stagedManager,
      serviceSession,
      verificationMethod: canonicalVerificationMethod,
      nodeDid: stagedNodeDid,
      address: stagedAddress,
      chainId: stagedChainId,
      tinyCloudSession: stagedTcSession,
      sessionExpiry: stagedSessionExpiry,
      recap: stagedRecap,
    });

    // Every operation below is a non-throwing pointer/value swap.
    const oldGraph = this._serviceGraph;
    const oldCore = this.tc;
    this.sessionManager = stagedManager;
    this.sessionKeyId = stagedKeyId;
    this.sessionKeyJwk = stagedJwk;
    if (resolvedHost) this.config.host = resolvedHost;
    this._address = stagedAddress;
    this._chainId = stagedChainId;
    this._serviceContext = stagedGraph.serviceContext;
    this._kv = stagedGraph.kv;
    this._sql = stagedGraph.sql;
    this._duckdb = stagedGraph.duckdb;
    this._hooks = stagedGraph.hooks;
    this._vault = stagedGraph.vault;
    this._encryption = stagedGraph.encryption;
    this._capabilityRegistry = stagedGraph.capabilityRegistry;
    this._keyProvider = stagedGraph.keyProvider;
    this._sharingService = stagedGraph.sharingService;
    this._delegationManager = stagedGraph.delegationManager;
    this._spaceService = stagedGraph.spaceService;
    this._serviceGraph = stagedGraph.graph;
    this._baseSecrets = new Map();
    this._secrets = new Map();
    this._publicKV = undefined;
    this._account = undefined;
    this.tc = stagedGraph.core;
    this._recapOperationsCache = stagedPrimary.cache;
    this.runtimePermissionGrants = stagedPrimary.grants;
    if (this.auth) {
      this.auth.installRestoredSession(stagedManager, stagedTcSession, [stagedHost]);
      this._restoredTcSession = undefined;
    } else {
      this._restoredTcSession = stagedTcSession;
    }
    oldGraph.retire();
    (oldCore as { retireServices?: () => void } | null)?.retireServices?.();
  }

  private stagePrimarySessionState(
    session: TinyCloudSession | undefined,
    verificationMethod: string,
    host: string,
    sessionExpiry: Date,
    recap: WasmRecapEntry[],
  ): { cache: { siwe: string; operations: RuntimePermissionOperation[] } | undefined; grants: RuntimePermissionGrant[] } {
    if (!session?.siwe) return { cache: undefined, grants: [] };
    let operations: RuntimePermissionOperation[] = [];
    operations = recap.flatMap((entry) => {
      const service = this.invocationServiceName(entry.service);
      return entry.actions.map((action) => ({
        ...(this.isEncryptionNetworkOperation(service, entry.path) ? { resource: entry.path } : { spaceId: entry.space }),
        service,
        path: entry.path,
        action,
        caveats: cloneRecapCaveats(entry.caveats),
      }));
    });
    const cache = { siwe: session.siwe, operations };
    // Restored authority has no host-activation result yet. Importing a skip
    // list from an unrelated prior session would erase valid restored grants.
    if (operations.length === 0) return { cache, grants: [] };
    const expiresAt = sessionExpiry;
    return {
      cache,
      grants: [{
        session: {
          delegationHeader: session.delegationHeader,
          delegationCid: session.delegationCid,
          spaceId: session.spaceId,
          verificationMethod: session.verificationMethod,
          jwk: session.jwk,
        },
        delegation: {
          cid: session.delegationCid,
          delegationHeader: session.delegationHeader,
          delegateDID: session.verificationMethod,
          delegatorDID: verificationMethod,
          spaceId: session.spaceId,
          path: "",
          actions: [...new Set(operations.map((operation) => operation.action))],
          expiry: expiresAt,
          allowSubDelegation: true,
          ownerAddress: session.address,
          chainId: session.chainId,
          host,
        },
        operations,
        expiresAt,
        provenance: "primary",
      }],
    };
  }

  private stageRestoredServiceGraph(input: {
    host: string;
    manager: ISessionManager;
    serviceSession: ServiceSession;
    verificationMethod: string;
    nodeDid: string;
    address: string | undefined;
    chainId: number;
    tinyCloudSession: TinyCloudSession | undefined;
    sessionExpiry: Date;
    recap: WasmRecapEntry[];
  }): {
    core: TinyCloud | null;
    graph: ServiceGraphLifetime;
    serviceContext: ServiceContext;
    kv: KVService;
    sql: SQLService;
    duckdb: DuckDbService;
    hooks: HooksService;
    vault: DataVaultService;
    encryption: EncryptionService;
    capabilityRegistry: CapabilityKeyRegistry;
    keyProvider: WasmKeyProvider;
    sharingService: SharingService;
    delegationManager: DelegationManager;
    spaceService: SpaceService;
  } {
    // TinyCloud owns the public-KV service graph. Stage a replacement core
    // context alongside the node graph so repeated cross-host restores cannot
    // leave publicKV pointed at a stale or uninitialized context.
    const graph = this.createServiceGraphLifetime();
    const core = this.auth
      ? new TinyCloud(this.auth, {
        invokeAny: graph.invokeAny,
        telemetry: this.config.telemetry,
      })
      : null;
    if (core) {
      core.initializeServices(graph.invoke, [input.host], graph.fetch);
      const coreContext = graph.track(core.serviceContext as ServiceContext);
      coreContext.setSession(input.serviceSession);
    }
    const serviceContext = graph.track(new ServiceContext({
      invoke: graph.invoke,
      invokeAny: graph.invokeAny,
      fetch: graph.fetch,
      hosts: [input.host],
      telemetry: this.config.telemetry,
    }));
    const kv = new KVService({});
    kv.initialize(serviceContext);
    serviceContext.registerService('kv', kv);
    const sql = new SQLService({});
    sql.initialize(serviceContext);
    serviceContext.registerService('sql', sql);
    const duckdb = new DuckDbService({});
    duckdb.initialize(serviceContext);
    serviceContext.registerService('duckdb', duckdb);
    const hooks = new HooksService({});
    hooks.initialize(serviceContext);
    serviceContext.registerService('hooks', hooks);
    serviceContext.setSession(input.serviceSession);
    const encryption = this.createEncryptionService({
      graph,
      host: input.host,
      session: input.serviceSession,
      did: input.nodeDid,
      address: input.address,
      chainId: input.chainId,
    });
    encryption.initialize(serviceContext);
    serviceContext.registerService('encryption', encryption);
    const vault = this.createVaultService(input.serviceSession.spaceId, kv, encryption, {
      host: input.host,
      did: input.nodeDid,
      address: input.address,
      chainId: input.chainId,
      serviceGraph: graph,
    });
    vault.initialize(serviceContext);
    serviceContext.registerService('vault', vault);

    const capabilityRegistry = new CapabilityKeyRegistry();
    if (input.tinyCloudSession) {
      const session = input.tinyCloudSession;
      // ReCap entries are returned by the verifier that authenticated this
      // SIWE. Persisted space metadata is only a routing hint and cannot add
      // an unsigned space, path, or action to the registry.
      const delegations: Delegation[] = input.recap.map((entry) => ({
          cid: session.delegationCid,
          delegateDID: session.verificationMethod,
          spaceId: entry.space,
          path: entry.path,
          actions: [...entry.actions],
          caveats: cloneRecapCaveats(entry.caveats),
          expiry: input.sessionExpiry,
          isRevoked: false,
          allowSubDelegation: true,
        }));
      if (delegations.length > 0) {
        capabilityRegistry.registerKey({
          id: session.sessionKey,
          did: session.verificationMethod,
          type: "session",
          jwk: session.jwk as JWK,
          priority: 0,
        }, delegations);
      }
    }
    const delegationManager = new DelegationManager({
      hosts: [input.host],
      session: input.serviceSession,
      invoke: graph.invoke,
      invokeAny: graph.invokeAny,
      fetch: graph.fetch,
    });
    const keyProvider = new WasmKeyProvider({ sessionManager: input.manager });
    const sharingService = new SharingService({
      hosts: [input.host],
      invoke: graph.invoke,
      fetch: graph.fetch,
      assertActive: () => graph.assertActive(),
      keyProvider,
      registry: capabilityRegistry,
      createDelegationWasm: (params) => this.createDelegationWrapper(params),
      computeCid: (data, codec) => {
        if (!this.wasmBindings.computeCid) throw new Error("computeCid is unavailable");
        return this.wasmBindings.computeCid(data, codec);
      },
      createKVService: (config) => {
        const service = new KVService({ prefix: config.pathPrefix?.replace(/\/$/, '') });
        const context = graph.track(new ServiceContext({
          invoke: config.invoke,
          fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
          hosts: config.hosts,
          telemetry: this.config.telemetry,
        }));
        context.setSession(config.session);
        service.initialize(context);
        return service;
      },
    });
    sharingService.updateConfig({
      session: input.serviceSession,
      delegationManager,
      sessionExpiry: input.sessionExpiry,
      createDelegationWasm: (params) => {
        graph.assertActive();
        return this.createDelegationWrapper(params);
      },
      onRootDelegationNeeded: this.signer ? async (params) => {
        graph.assertActive();
        const delegation = await this.createRootDelegationForSharing(
          params,
          () => graph.assertActive(),
        );
        graph.assertActive();
        return delegation;
      } : undefined,
    });
    const spaceService = new SpaceService({
      hosts: [input.host],
      session: input.serviceSession,
      invoke: graph.invoke,
      fetch: graph.fetch,
      capabilityRegistry,
      userDid: input.nodeDid,
      createKVService: (spaceId) => {
        graph.assertActive();
        const scopedKv = new KVService({});
        const context = graph.track(new ServiceContext({
          invoke: graph.invoke,
          invokeAny: graph.invokeAny,
          fetch: graph.fetch,
          hosts: [input.host],
          telemetry: this.config.telemetry,
        }));
        context.setSession({ ...input.serviceSession, spaceId });
        scopedKv.initialize(context);
        return scopedKv;
      },
      createVaultService: (spaceId) => {
        graph.assertActive();
        const scopedKv = new KVService({});
        const context = graph.track(new ServiceContext({
          invoke: graph.invoke,
          invokeAny: graph.invokeAny,
          fetch: graph.fetch,
          hosts: [input.host],
          telemetry: this.config.telemetry,
        }));
        context.setSession({ ...input.serviceSession, spaceId });
        scopedKv.initialize(context);
        const scopedVault = this.createVaultService(spaceId, scopedKv, encryption, {
          host: input.host,
          did: input.nodeDid,
          address: input.address,
          chainId: input.chainId,
          serviceGraph: graph,
        });
        scopedVault.initialize(context);
        return scopedVault;
      },
      createSecretsService: (spaceId) => {
        graph.assertActive();
        return this.secretsForSpace(spaceId);
      },
      createDelegation: async (params) => {
        graph.assertActive();
        try {
          const portableDelegation = await this.createDelegation({
            delegateDID: params.delegateDID,
            path: params.path,
            actions: params.actions,
            disableSubDelegation: params.disableSubDelegation,
            expiryMs: params.expiry ? params.expiry.getTime() - Date.now() : undefined,
          });
          return { ok: true as const, data: {
            cid: portableDelegation.cid,
            delegateDID: portableDelegation.delegateDID,
            delegatorDID: this.did,
            spaceId: portableDelegation.spaceId,
            path: portableDelegation.path,
            actions: portableDelegation.actions,
            expiry: portableDelegation.expiry,
            isRevoked: false,
            allowSubDelegation: !portableDelegation.disableSubDelegation,
            createdAt: new Date(),
            authHeader: portableDelegation.delegationHeader.Authorization,
          }};
        } catch (error) {
          return { ok: false as const, error: {
            code: "CREATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            service: "delegation",
          }};
        }
      },
      onSpaceRegistered: async (space) => {
        graph.assertActive();
        await this.account.spaces.register(space);
      },
    });
    spaceService.updateConfig({ sharingService });
    return { core, graph, serviceContext, kv, sql, duckdb, hooks, vault, encryption, capabilityRegistry, keyProvider, sharingService, delegationManager, spaceService };
  }

  /**
   * Resolve the host a restored session should target.
   *
   * Mirrors fresh sign-in host resolution but for the restore path:
   * an explicit/pinned host always wins, then the hosts the session was
   * persisted with, then a lazy registry/fallback resolution for sessions
   * that predate the persisted `tinycloudHosts` field. Returns `undefined`
   * only when there's nothing to resolve from (no explicit host, no
   * persisted hosts, and no address/chainId) — in which case the existing
   * `config.host` (default) is left in place.
   *
   * Resolution failures are surfaced, not swallowed: a genuinely broken
   * registry lookup throws rather than silently falling back to a wrong host.
   */
  private async resolveRestoredHost(
    persistedHosts: string[] | undefined,
    address: string | undefined,
    chainId: number | undefined,
  ): Promise<string | undefined> {
    if (this.explicitHost) {
      return this.explicitHost;
    }
    if (persistedHosts && persistedHosts.length > 0) {
      return persistedHosts[0];
    }
    if (address === undefined || chainId === undefined) {
      return undefined;
    }
    const resolved = await resolveTinyCloudHosts(pkhDid(address, chainId), {
      registryUrl: this.config.tinycloudRegistryUrl,
      fallbackHosts: this.config.tinycloudFallbackHosts,
      autoDiscoverLocalNode: this.config.autoDiscoverLocalNode,
      localNodeUrl: this.config.localNodeUrl,
      localLinkName: this.config.localLinkName,
      expectedNodeDid: this.config.expectedNodeDid,
    });
    return resolved.hosts[0];
  }

  /**
   * Resolve the currently-active TinyCloudSession, preferring the auth
   * layer's value (wallet mode) and falling back to the node-level
   * rehydration set by {@link restoreSession} (session-only mode).
   */
  private currentTinyCloudSession(): TinyCloudSession | undefined {
    return this.auth?.tinyCloudSession ?? this._restoredTcSession;
  }

  /**
   * Connect a wallet to upgrade from session-only mode to wallet mode.
   *
   * This allows a user who started in session-only mode to later connect
   * a wallet and gain the ability to create their own space.
   *
   * Note: This does NOT automatically sign in. Call signIn() after connecting
   * the wallet to create your space.
   *
   * @param privateKey - The Ethereum private key (hex string, no 0x prefix)
   * @param options - Optional configuration
   * @param options.prefix - Space name prefix (defaults to "default")
   *
   * @example
   * ```typescript
   * // Start in session-only mode
   * const node = new TinyCloudNode({ host: "https://node.tinycloud.xyz" });
   * console.log(node.did); // did:key:z6Mk... (session key)
   *
   * // Later, connect a wallet
   * node.connectWallet(privateKey);
   * await node.signIn();
   * console.log(node.did); // did:pkh:eip155:1:0x... (PKH)
   * ```
   */
  connectWallet(privateKey: string, options?: { prefix?: string; sessionStorage?: ISessionStorage }): void {
    if (this.signer) {
      throw new Error("Wallet already connected. Cannot connect another wallet.");
    }

    const prefix = options?.prefix ?? "default";

    // Create signer from private key
    if (!TinyCloudNode.nodeDefaults) {
      throw new Error(
        "connectWallet() requires PrivateKeySigner. Use connectSigner() instead, " +
        "or import from '@tinycloud/node-sdk' (not '/core') for automatic Node.js defaults."
      );
    }
    this.signer = TinyCloudNode.nodeDefaults.createSigner(privateKey);

    // Create authorization handler
    const authConfig = { ...this.config, prefix };
    const useBootstrapSignInRequest = this.shouldUseBootstrapSignInRequest(authConfig);
    this.auth = new NodeUserAuthorization({
      signer: this.signer,
      signStrategy: this.config.signStrategy ?? { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionManager: this.sessionManager,
      sessionStorage: options?.sessionStorage ?? this.config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: prefix,
      sessionExpirationMs: this.config.sessionExpirationMs ?? DEFAULT_SESSION_EXPIRATION_MS,
      tinycloudHosts: this.explicitHost ? [this.explicitHost] : undefined,
      tinycloudRegistryUrl: this.config.tinycloudRegistryUrl,
      tinycloudFallbackHosts: this.config.tinycloudFallbackHosts,
      autoDiscoverLocalNode: this.config.autoDiscoverLocalNode,
      localNodeUrl: this.config.localNodeUrl,
      localLinkName: this.config.localLinkName,
      expectedNodeDid: this.config.expectedNodeDid,
      autoCreateSpace: useBootstrapSignInRequest ? false : this.config.autoCreateSpace,
      enablePublicSpace: this.config.enablePublicSpace ?? true,
      spaceCreationHandler: useBootstrapSignInRequest
        ? undefined
        : this.config.spaceCreationHandler,
      nonce: this.config.nonce,
      siweConfig: this.config.siweConfig,
      manifest: useBootstrapSignInRequest ? undefined : this.config.manifest,
      capabilityRequest: useBootstrapSignInRequest
        ? BOOTSTRAP_SESSION_REQUESTS.default
        : this.config.capabilityRequest,
      includeAccountRegistryPermissions: useBootstrapSignInRequest
        ? false
        : this.config.includeAccountRegistryPermissions,
    });

    // Create TinyCloud instance
    this.tc = new TinyCloud(this.auth, {
      invokeAny: this.invokeAnyWithRuntimePermissions,
      telemetry: this.config.telemetry,
    });

    // Update config with prefix
    this.config.prefix = prefix;
  }

  /**
   * Connect any ISigner to upgrade from session-only mode to wallet mode.
   *
   * Same as connectWallet() but accepts any ISigner implementation instead
   * of a raw private key string. Use this for browser wallets, hardware wallets,
   * or custom signing backends.
   *
   * Note: This does NOT automatically sign in. Call signIn() after connecting.
   *
   * @param signer - Any ISigner implementation
   * @param options - Optional configuration
   * @param options.prefix - Space name prefix (defaults to "default")
   */
  connectSigner(signer: ISigner, options?: { prefix?: string; sessionStorage?: ISessionStorage }): void {
    if (this.signer) {
      throw new Error("Signer already connected. Cannot connect another signer.");
    }

    const prefix = options?.prefix ?? "default";

    this.signer = signer;

    const authConfig = { ...this.config, prefix };
    const useBootstrapSignInRequest = this.shouldUseBootstrapSignInRequest(authConfig);
    this.auth = new NodeUserAuthorization({
      signer: this.signer,
      signStrategy: this.config.signStrategy ?? { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionManager: this.sessionManager,
      sessionStorage: options?.sessionStorage ?? this.config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: prefix,
      sessionExpirationMs: this.config.sessionExpirationMs ?? DEFAULT_SESSION_EXPIRATION_MS,
      tinycloudHosts: this.explicitHost ? [this.explicitHost] : undefined,
      tinycloudRegistryUrl: this.config.tinycloudRegistryUrl,
      tinycloudFallbackHosts: this.config.tinycloudFallbackHosts,
      autoDiscoverLocalNode: this.config.autoDiscoverLocalNode,
      localNodeUrl: this.config.localNodeUrl,
      localLinkName: this.config.localLinkName,
      expectedNodeDid: this.config.expectedNodeDid,
      autoCreateSpace: useBootstrapSignInRequest ? false : this.config.autoCreateSpace,
      enablePublicSpace: this.config.enablePublicSpace ?? true,
      spaceCreationHandler: useBootstrapSignInRequest
        ? undefined
        : this.config.spaceCreationHandler,
      nonce: this.config.nonce,
      siweConfig: this.config.siweConfig,
      manifest: useBootstrapSignInRequest ? undefined : this.config.manifest,
      capabilityRequest: useBootstrapSignInRequest
        ? BOOTSTRAP_SESSION_REQUESTS.default
        : this.config.capabilityRequest,
      includeAccountRegistryPermissions: useBootstrapSignInRequest
        ? false
        : this.config.includeAccountRegistryPermissions,
    });

    this.tc = new TinyCloud(this.auth, {
      invokeAny: this.invokeAnyWithRuntimePermissions,
      telemetry: this.config.telemetry,
    });
    this.config.prefix = prefix;
  }

  /**
   * Initialize the service context and KV service after sign-in.
   * @internal
   */
  private initializeServices(): void {
    const session = this.currentTinyCloudSession();
    if (!session) {
      return;
    }

    // Initialize TinyCloud core services (needed for publicKV, ensurePublicSpace)
    this.tc!.initializeServices(
      this._serviceGraph.invoke,
      [this.config.host!],
      this._serviceGraph.fetch,
    );
    this._serviceGraph.track(this.tc!.serviceContext as ServiceContext);

    // Create service context
    this._serviceContext = this._serviceGraph.track(new ServiceContext({
      invoke: this._serviceGraph.invoke,
      invokeAny: this._serviceGraph.invokeAny,
      fetch: this._serviceGraph.fetch,
      hosts: [this.config.host!],
      telemetry: this.config.telemetry,
    }));

    // Create and register KV service
    this._kv = new KVService({});
    this._kv.initialize(this._serviceContext);
    this._serviceContext.registerService('kv', this._kv);

    // Create and register SQL service (if supported)
    const features = this.nodeFeatures;
    if (features.length === 0 || features.includes("sql")) {
      this._sql = new SQLService({});
      this._sql.initialize(this._serviceContext);
      this._serviceContext.registerService('sql', this._sql);
    }

    // Create and register DuckDB service (if supported)
    if (features.length === 0 || features.includes("duckdb")) {
      this._duckdb = new DuckDbService({});
      this._duckdb.initialize(this._serviceContext);
      this._serviceContext.registerService('duckdb', this._duckdb);
    }

    this._hooks = new HooksService({});
    this._hooks.initialize(this._serviceContext);
    this._serviceContext.registerService('hooks', this._hooks);

    // Set session on context
    const serviceSession: ServiceSession = {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      verificationMethod: session.verificationMethod,
      jwk: session.jwk,
    };
    this._serviceContext.setSession(serviceSession);
    (this.tc!.serviceContext as ServiceContext).setSession(serviceSession);

    // Create and register Vault service
    this._vault = this.createVaultService(session.spaceId, this._kv!);
    this._vault.initialize(this._serviceContext);
    this._serviceContext.registerService('vault', this._vault);

    // Initialize v2 services
    this.initializeV2Services(serviceSession);
  }

  private createSpaceScopedKVService(spaceId: string): KVService {
    const kvService = new KVService({});
    if (this._serviceContext) {
      const spaceScopedContext = this._serviceGraph.track(new ServiceContext({
        invoke: this._serviceContext.invoke,
        fetch: this._serviceContext.fetch,
        hosts: this._serviceContext.hosts,
        telemetry: this.config.telemetry,
      }));
      const session = this._serviceContext.session;
      if (session) {
        spaceScopedContext.setSession({ ...session, spaceId });
      }
      kvService.initialize(spaceScopedContext);
    }
    return kvService;
  }

  getDefaultEncryptionNetworkId(name = DEFAULT_ENCRYPTION_NETWORK_NAME): string {
    return `urn:tinycloud:encryption:${this.did}:${name}`;
  }

  getEncryptionNetworkIdForSpace(
    spaceId: string,
    name = DEFAULT_ENCRYPTION_NETWORK_NAME,
  ): string {
    const ownerDid = this.ownerDidFromSpaceId(spaceId) ?? this.did;
    return `urn:tinycloud:encryption:${ownerDid}:${name}`;
  }

  private ownerDidFromSpaceId(spaceId: string): string | undefined {
    if (!spaceId.startsWith("tinycloud:")) return undefined;
    const body = spaceId.slice("tinycloud:".length);
    const lastSeparator = body.lastIndexOf(":");
    if (lastSeparator <= 0) return undefined;
    const owner = body.slice(0, lastSeparator);
    if (owner.startsWith("did:")) return owner;
    if (!owner.includes(":")) return undefined;
    return `did:${owner}`;
  }

  private requireServiceSession(): ServiceSession {
    const session = this._serviceContext?.session;
    if (!session) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return session;
  }

  /**
   * Runtime-permission helpers can be used from an authenticated Node session
   * before its public ServiceContext is initialized. They still need the
   * current signed session, never an optional or stale authority object.
   */
  private requireEncryptionSession(): ServiceSession {
    const session = this._serviceContext?.session ?? this.auth?.tinyCloudSession;
    if (!session) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return session;
  }

  private createEncryptionCrypto(): EncryptionCrypto {
    const wasm = this.wasmBindings;
    const columnEncrypt = (key: Uint8Array, plaintext: Uint8Array): Uint8Array => {
      const encrypted = wasm.vault_encrypt(key, plaintext);
      const out = new Uint8Array(1 + encrypted.length);
      out[0] = 0x01;
      out.set(encrypted, 1);
      return out;
    };
    const columnDecrypt = (key: Uint8Array, blob: Uint8Array): Uint8Array => {
      if (blob[0] !== 0x01) {
        return blob;
      }
      return wasm.vault_decrypt(key, blob.slice(1));
    };
    return {
      sha256: (data) => wasm.vault_sha256(data),
      randomBytes: (length) => wasm.vault_random_bytes(length),
      x25519FromSeed: (seed) => wasm.vault_x25519_from_seed(seed),
      x25519Dh: (privateKey, publicKey) =>
        wasm.vault_x25519_dh(privateKey, publicKey),
      authEncrypt: (key, plaintext) => wasm.vault_encrypt(key, plaintext),
      authDecrypt: (key, ciphertext) => wasm.vault_decrypt(key, ciphertext),
      sealToNetworkKey: (networkPublicKey, symmetricKey) => {
        const seed = wasm.vault_random_bytes(32);
        const ephemeral = wasm.vault_x25519_from_seed(seed);
        const shared = wasm.vault_x25519_dh(
          ephemeral.privateKey,
          networkPublicKey,
        );
        const encrypted = columnEncrypt(shared, symmetricKey);
        const out = new Uint8Array(ephemeral.publicKey.length + encrypted.length);
        out.set(ephemeral.publicKey, 0);
        out.set(encrypted, ephemeral.publicKey.length);
        return out;
      },
      openWithReceiverKey: (receiverPrivateKey, wrappedKey) => {
        const peerPublic = wrappedKey.slice(0, 32);
        const ciphertext = wrappedKey.slice(32);
        const shared = wasm.vault_x25519_dh(receiverPrivateKey, peerPublic);
        return columnDecrypt(shared, ciphertext);
      },
      verifyNodeSignature: (nodeId, message, signature) =>
        verifyDidKeyEd25519Signature(nodeId, message, signature),
    };
  }

  private async fetchNodeId(): Promise<string> {
    const response = await fetch(`${this.config.host}/info`);
    if (!response.ok) {
      throw new Error(`Failed to fetch node info: HTTP ${response.status}`);
    }
    const info = (await response.json()) as { nodeId?: unknown };
    if (typeof info.nodeId !== "string" || info.nodeId.length === 0) {
      throw new Error("Node /info response did not include nodeId");
    }
    return info.nodeId;
  }

  private async signRawNetworkAuthorization(input: {
    targetNode: string;
    networkId: string;
    action: string;
    facts: NetworkInvocationFact;
  }, binding?: {
    graph: ServiceGraphLifetime;
    session: ServiceSession;
  }): Promise<{ authorization: string; invocationCid: string }> {
    binding?.graph.assertActive();
    if (!this.wasmBindings.invokeAny) {
      throw new Error("WASM binding does not support raw-resource invokeAny");
    }
    if (!this.wasmBindings.computeCid) {
      throw new Error("WASM binding does not support invocation CID computation");
    }
    const session = binding?.session ?? this.requireEncryptionSession();
    const headers = this.invokeAnyWithRuntimePermissions(
      session,
      [
        {
          resource: input.networkId,
          service: "encryption",
          path: input.networkId,
          action: input.action,
        },
      ],
      [input.facts as Record<string, unknown>],
    );
    const authorization = authorizationHeader(headers);
    const audienceBound = await rewriteInvocationAudience(
      authorization,
      input.targetNode,
      session.jwk,
    );
    binding?.graph.assertActive();
    return {
      authorization: audienceBound,
      invocationCid: this.wasmBindings.computeCid(
        new TextEncoder().encode(audienceBound),
        0x55n,
      ),
    };
  }

  private async fetchEncryptionNetworkAt(
    host: string,
    networkId: string,
    fetchFn: FetchFunction,
  ): Promise<NetworkDescriptor | null> {
    const response = await fetchFn(
      `${host}/encryption/networks/${encodeURIComponent(networkId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Failed to fetch encryption network ${networkId}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      descriptor?: NetworkDescriptor;
    } | NetworkDescriptor;
    return "descriptor" in body && body.descriptor ? body.descriptor : body as NetworkDescriptor;
  }

  private createEncryptionService(binding?: {
    graph: ServiceGraphLifetime;
    host: string;
    session: ServiceSession;
    did: string;
    address: string | undefined;
    chainId: number;
  }): EncryptionService {
    const graph = binding?.graph ?? this._serviceGraph;
    const host = binding?.host ?? this.config.host!;
    // The public service path always has a ServiceContext. Keep the auth-session
    // fallback for the internal runtime-permission helpers, which construct an
    // encryption service before a ServiceContext is installed. Both paths bind
    // the resulting service to this graph, so a later graph replacement still
    // retires the captured service permanently.
    const session = binding?.session ?? this.requireEncryptionSession();
    const did = binding?.did ?? this.did;
    const address = binding?.address ?? this._address;
    const chainId = binding?.chainId ?? this._chainId;
    const crypto = this.createEncryptionCrypto();
    const transport: DecryptTransport = {
      postDecrypt: async ({ networkId, authorization, canonicalBody, signal }) => {
        graph.assertActive();
        const response = await graph.fetch(
          `${host}/encryption/networks/${encodeURIComponent(networkId)}/decrypt`,
          {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
            },
            body: canonicalBody,
            signal,
          },
        );
        graph.assertActive();
        if (!response.ok) {
          let permissionHint: PermissionHint | undefined;
          if (response.status === 401 || response.status === 403) {
            try {
              const body: unknown = await response.json();
              const record = typeof body === "object" && body !== null
                ? body as Record<string, unknown>
                : undefined;
              const nested = typeof record?.error === "object" && record.error !== null
                ? record.error as Record<string, unknown>
                : undefined;
              permissionHint = parsePermissionHint(record?.permissionHint) ??
                parsePermissionHint(nested?.permissionHint);
            } catch {
              // A denied response without the SDK-owned structured field is
              // classified safely below and cannot become a grant hint.
            }
          }
          throw new DecryptTransportResponseError(response.status, permissionHint);
        }
        return (await response.json()) as DecryptResponseBody;
      },
    };
    return new EncryptionService({
      crypto,
      signer: {
        signDecryptInvocation: async (
          input: BuildDecryptInvocationInput,
        ): Promise<BuiltDecryptInvocation> => {
          graph.assertActive();
          const signed = await this.signRawNetworkAuthorization({
            targetNode: input.targetNode,
            networkId: input.networkId,
            action: DECRYPT_ACTION,
            facts: input.facts,
          }, { graph, session });
          graph.assertActive();
          return {
            ...signed,
            canonicalBody: canonicalizeEncryptionJson(
              input.body as unknown as CanonicalizableEncryptionJson,
            ),
          };
        },
      },
      transport,
      node: {
        fetchByNetworkId: async (networkId) => {
          graph.assertActive();
          const descriptor = await this.fetchEncryptionNetworkAt(host, networkId, graph.fetch);
          graph.assertActive();
          return descriptor;
        },
      },
      wellKnown: {
        fetchWellKnown: async (principal, discoveryKey) => {
          graph.assertActive();
          if (!address || !didPrincipalMatches(principal, did)) {
            return null;
          }
          const publicSpaceId = makePublicSpaceId(address, chainId);
          const encodedKey = discoveryKey.split("/").map(encodeURIComponent).join("/");
          const response = await graph.fetch(
            `${host}/public/${encodeURIComponent(publicSpaceId)}/kv/${encodedKey}`,
            { method: "GET" },
          );
          graph.assertActive();
          if (!response.ok) {
            return null;
          }
          const body = await response.json() as
            | NetworkDescriptor
            | { descriptor?: NetworkDescriptor };
          graph.assertActive();
          return "descriptor" in body && body.descriptor
            ? body.descriptor
            : (body as NetworkDescriptor);
        },
      },
      assertActive: () => graph.assertActive(),
    });
  }

  private getEncryptionService(): EncryptionService {
    if (!this._serviceContext) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    if (!this._encryption) {
      this._encryption = this.createEncryptionService();
      this._encryption.initialize(this._serviceContext);
      this._serviceContext.registerService("encryption", this._encryption);
    }
    return this._encryption;
  }

  private createVaultService(
    spaceId: string,
    kv: IKVService,
    encryptionService = this.getEncryptionService(),
    nodeContext?: {
      host: string;
      did: string;
      address: string | undefined;
      chainId: number;
      serviceGraph?: ServiceGraphLifetime;
    },
  ): DataVaultService {
    const wasm = this.wasmBindings;
    const serviceGraph = nodeContext?.serviceGraph ?? this._serviceGraph;
    const vaultCrypto = createVaultCrypto({
      vault_encrypt: wasm.vault_encrypt, vault_decrypt: wasm.vault_decrypt, vault_derive_key: wasm.vault_derive_key,
      vault_x25519_from_seed: wasm.vault_x25519_from_seed, vault_x25519_dh: wasm.vault_x25519_dh,
      vault_random_bytes: wasm.vault_random_bytes, vault_sha256: wasm.vault_sha256,
    });
    const self = this;
    const did = nodeContext?.did ?? this.did;
    const address = nodeContext?.address ?? this._address;
    const chainId = nodeContext?.chainId ?? this._chainId;
    const host = nodeContext?.host ?? this.config.host!;
    const ownerDid = this.ownerDidFromSpaceId(spaceId) ?? did;
    return new DataVaultService({
      spaceId,
      crypto: vaultCrypto,
      encryption: {
        networkId: `urn:tinycloud:encryption:${ownerDid}:${DEFAULT_ENCRYPTION_NETWORK_NAME}`,
        service: encryptionService,
        decryptCapabilityProof: () => ({
          proofs: [this.requireServiceSession().delegationCid],
        }),
      },
      tc: {
        kv,
        ensurePublicSpace: async () => {
          try {
            serviceGraph.assertActive();
            await self.ensurePublicSpace();
            return { ok: true as const, data: undefined };
          } catch (error) {
            return { ok: false as const, error: { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : String(error), service: "vault" } };
          }
        },
        get publicKV() {
          serviceGraph.assertActive();
          return self._publicKV ?? self.tc!.publicKV;
        },
        readPublicSpace: <T>(host: string, targetSpaceId: string, key: string) =>
          TinyCloud.readPublicSpace<T>(host, targetSpaceId, key),
        makePublicSpaceId: TinyCloud.makePublicSpaceId,
        did,
        address: address ?? "",
        chainId,
        hosts: [host],
      },
    });
  }

  /**
   * Initialize the v2 delegation system services.
   * @internal
   */
  private initializeV2Services(serviceSession: ServiceSession): void {
    const graph = this._serviceGraph;

    // Initialize CapabilityKeyRegistry
    this._capabilityRegistry = new CapabilityKeyRegistry();

    const tcSession = this.auth?.tinyCloudSession;
    // Register the session key with its capabilities
    if (tcSession && this._address) {
      const sessionKey: KeyInfo = {
        id: tcSession.sessionKey,
        did: tcSession.verificationMethod,
        type: "session",
        // Cast jwk from generic object to JWK - we know it has the required structure
        jwk: tcSession.jwk as JWK,
        priority: 0, // Session keys have highest priority
      };

      // Create root delegation for the session
      const rootDelegation: Delegation = {
        cid: tcSession.delegationCid,
        delegateDID: tcSession.verificationMethod,
        spaceId: tcSession.spaceId,
        path: "", // Root access
        actions: [...ROOT_DELEGATION_ACTIONS],
        expiry: this.getSessionExpiry(),
        isRevoked: false,
        allowSubDelegation: true,
      };

      // Register root delegations
      const delegations = [rootDelegation];

      // If session includes additional spaces (e.g., public), register delegations for those too
      if (tcSession.spaces) {
        for (const [spaceName, spaceId] of Object.entries(tcSession.spaces)) {
          delegations.push({
            cid: tcSession.delegationCid,
            delegateDID: tcSession.verificationMethod,
            spaceId,
            path: "",
            actions: [...ROOT_DELEGATION_ACTIONS],
            expiry: this.getSessionExpiry(),
            isRevoked: false,
            allowSubDelegation: true,
          });
        }
      }

      this._capabilityRegistry.registerKey(sessionKey, delegations);
    }

    // Initialize DelegationManager
    this._delegationManager = new DelegationManager({
      hosts: [this.config.host!],
      accountSpaceId: this.accountSpaceId,
      session: serviceSession,
      invoke: graph.invoke,
      invokeAny: graph.invokeAny,
      fetch: graph.fetch,
    });

    // Initialize SpaceService
    this._spaceService = new SpaceService({
      hosts: [this.config.host!],
      session: serviceSession,
      invoke: graph.invoke,
      fetch: graph.fetch,
      capabilityRegistry: this._capabilityRegistry,
      userDid: this.did,
      createKVService: (spaceId: string) => {
        graph.assertActive();
        return this.createSpaceScopedKVService(spaceId);
      },
      createVaultService: (spaceId: string) => {
        graph.assertActive();
        const kvService = this.createSpaceScopedKVService(spaceId);
        const vaultService = this.createVaultService(spaceId, kvService);
        if (this._serviceContext) {
          vaultService.initialize(this._serviceContext);
        }
        return vaultService;
      },
      createSecretsService: (spaceId: string) => {
        graph.assertActive();
        return this.secretsForSpace(spaceId);
      },
      // Enable space.delegations.create() via SIWE-based delegation
      createDelegation: async (params) => {
        try {
          graph.assertActive();
          // Use the existing createDelegation method which calls /delegate with SIWE
          const portableDelegation = await this.createDelegation({
            delegateDID: params.delegateDID,
            path: params.path,
            actions: params.actions,
            disableSubDelegation: params.disableSubDelegation,
            expiryMs: params.expiry
              ? params.expiry.getTime() - Date.now()
              : undefined,
          });

          // Convert PortableDelegation to Delegation type for Space API
          const delegation: Delegation = {
            cid: portableDelegation.cid,
            delegateDID: portableDelegation.delegateDID,
            delegatorDID: this.did,
            spaceId: portableDelegation.spaceId,
            path: portableDelegation.path,
            actions: portableDelegation.actions,
            expiry: portableDelegation.expiry,
            isRevoked: false,
            allowSubDelegation: !portableDelegation.disableSubDelegation,
            createdAt: new Date(),
            authHeader: portableDelegation.delegationHeader.Authorization,
          };

          return { ok: true, data: delegation };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "CREATION_FAILED",
              message: error instanceof Error ? error.message : String(error),
              service: "delegation",
            },
          };
        }
      },
      onSpaceRegistered: async (space) => {
        graph.assertActive();
        await this.account.spaces.register(space);
      },
    });

    // A SharingService retains its invoke/fetch functions and lifetime guard.
    // Recreate it for this graph instead of updating the receive-only instance
    // from the graph that was just retired during a subsequent sign-in.
    this._sharingService = new SharingService({
      hosts: [this.config.host!],
      session: serviceSession,
      invoke: graph.invoke,
      fetch: graph.fetch,
      assertActive: () => graph.assertActive(),
      keyProvider: this._keyProvider,
      registry: this._capabilityRegistry,
      delegationManager: this._delegationManager,
      sessionExpiry: this.getSessionExpiry(),
      createDelegationWasm: (params) => {
        graph.assertActive();
        return this.createDelegationWrapper(params);
      },
      computeCid: (data, codec) => {
        if (!this.wasmBindings.computeCid) throw new Error("computeCid is unavailable");
        return this.wasmBindings.computeCid(data, codec);
      },
      createKVService: (config) => {
        graph.assertActive();
        const service = new KVService({ prefix: config.pathPrefix?.replace(/\/$/, "") });
        const context = graph.track(new ServiceContext({
          invoke: config.invoke,
          fetch: config.fetch ?? graph.fetch,
          hosts: config.hosts,
          telemetry: this.config.telemetry,
        }));
        context.setSession(config.session);
        service.initialize(context);
        return service;
      },
      onRootDelegationNeeded: this.signer
        ? async (params) => {
          graph.assertActive();
          const delegation = await this.createRootDelegationForSharing(
            params,
            () => graph.assertActive(),
          );
          graph.assertActive();
          return delegation;
        }
        : undefined,
    });

    // Wire up SharingService to SpaceService for space.sharing.generate()
    this._spaceService.updateConfig({
      sharingService: this._sharingService,
    });
  }

  /**
   * Get the session expiry time.
   * @internal
   */
  private getSessionExpiry(): Date {
    // Default to 1 hour from now if not explicitly set
    const expirationMs = this.config.sessionExpirationMs ?? DEFAULT_SESSION_EXPIRATION_MS;
    return new Date(Date.now() + expirationMs);
  }

  /**
   * Wrapper for the WASM createDelegation function.
   *
   * The WASM call now takes a multi-resource `abilities` map
   * (matching `prepareSession`'s shape) and emits ONE UCAN that
   * covers every `(service, path, actions)` entry. We mirror the raw
   * result back through `CreateDelegationWasmResult`, converting the
   * seconds-since-epoch `expiry` to a Date and normalizing the
   * `delegateDid` → `delegateDID` case.
   *
   * Both SharingService (single-entry) and
   * {@link TinyCloudNode.delegateTo} (multi-entry) drive this through
   * the same code path so there's exactly one place that touches the
   * WASM boundary.
   *
   * @internal
   */
  private createDelegationWrapper(params: CreateDelegationWasmParams): CreateDelegationWasmResult {
    // Convert ServiceSession to the format WASM expects
    const wasmSession = {
      delegationHeader: params.session.delegationHeader,
      delegationCid: params.session.delegationCid,
      jwk: params.session.jwk,
      spaceId: params.session.spaceId,
      // Session storage carries the verification method as a DID URL
      // (`did:key:...#key-id`). The Rust UCAN builder expects the principal
      // DID here and rejects the fragment as an invalid audience DID.
      verificationMethod: params.session.verificationMethod.split("#", 1)[0],
    };

    const result = this.wasmBindings.createDelegation(
      wasmSession,
      params.delegateDID,
      params.spaceId,
      params.abilities,
      params.expirationSecs,
      params.notBeforeSecs
    );

    return {
      delegation: result.delegation,
      cid: result.cid,
      // Rust serde `rename_all = "camelCase"` emits `delegateDid`
      // (lowercase d); the TypeScript interface uses `delegateDID`
      // (historical, matches Delegation.delegateDID). Normalize here.
      delegateDID: result.delegateDid ?? result.delegateDID,
      expiry: new Date(result.expiry * 1000),
      resources: result.resources,
    };
  }

  /**
   * Create a direct root delegation from the wallet to a share key.
   * This bypasses the session delegation chain, allowing share links
   * with expiry longer than the current session.
   * @internal
   */
  async createOwnerDelegation(
    params: CreateOwnerDelegationParams,
    assertActive?: () => void,
  ): Promise<OwnerDelegationReceipt> {
    const assertOwnerGraphActive = assertActive ?? this._serviceGraph.assertActive.bind(this._serviceGraph);
    assertOwnerGraphActive();
    if (!params.delegateDid.startsWith("did:key:") || params.actions.length === 0 || params.path.length === 0) {
      throw new Error("Owner delegation requires an external did:key audience and bounded capabilities");
    }
    const now = new Date();
    if (params.expiresAt.getTime() <= now.getTime() || params.expiresAt.getTime() - now.getTime() > EXPIRY.MAX_MS) {
      throw new Error("Owner delegation expiry must be explicit, future, and within EXPIRY.MAX_MS");
    }
    if (!this.signer) throw new Error("Owner wallet signer is required");
    const session = this.currentTinyCloudSession();
    if (!session) throw new Error("Owner session is required");
    const abilities = sharingActionsToAbilities(params.path, [...params.actions]);
    if (!abilities) throw new Error("Owner delegation capabilities are unsupported");

    const host = this.config.host!;
    const prepared = this.wasmBindings.prepareSession({
      abilities,
      address: this.wasmBindings.ensureEip55(session.address),
      chainId: session.chainId,
      domain: this.siweDomain,
      issuedAt: now.toISOString(),
      expirationTime: params.expiresAt.toISOString(),
      spaceId: params.spaceId,
      delegateUri: params.delegateDid,
    });
    const signature = await this.signer.signMessage(prepared.siwe);
    assertOwnerGraphActive();
    const delegationSession = this.wasmBindings.completeSessionSetup({ ...prepared, signature });
    const activation = await activateSessionWithHost(host, delegationSession.delegationHeader);
    assertOwnerGraphActive();
    if (!activation.success) {
      throw new Error(`Owner delegation import failed: ${activation.status} ${activation.error ?? ""}`.trim());
    }
    const delegation: Delegation = {
      cid: delegationSession.delegationCid,
      delegateDID: params.delegateDid,
      delegatorDID: pkhDid(session.address, session.chainId),
      spaceId: params.spaceId,
      path: params.path,
      actions: [...params.actions],
      expiry: params.expiresAt,
      isRevoked: false,
      allowSubDelegation: true,
      createdAt: now,
      authHeader: delegationSession.delegationHeader.Authorization,
    };
    return {
      delegation,
      signedDagCbor: decodeAuthorizationBytes(delegationSession.delegationHeader.Authorization),
      delegationCid: delegationSession.delegationCid,
      nodeReceipt: {
        commitEventCid: (activation as typeof activation & { commitEventCid?: string }).commitEventCid,
        activated: activation.activated ?? [],
        skipped: activation.skipped ?? [],
      },
    };
  }

  private async createRootDelegationForSharing(params: {
    shareKeyDID: string;
    spaceId: string;
    path: string;
    actions: string[];
    requestedExpiry: Date;
  }, assertActive?: () => void): Promise<Delegation | undefined> {
    try {
      return (await this.createOwnerDelegation({
        delegateDid: params.shareKeyDID,
        spaceId: params.spaceId,
        path: params.path,
        actions: params.actions,
        expiresAt: params.requestedExpiry,
      }, assertActive)).delegation;
    } catch {
      assertActive?.();
      return undefined;
    }
  }

  /**
   * Track a received delegation in the capability registry.
   * @internal
   */
  private trackReceivedDelegation(delegation: PortableDelegation, jwk: JWK): void {
    if (!this._capabilityRegistry) {
      return;
    }

    const keyInfo: KeyInfo = {
      id: `received:${delegation.cid}`,
      did: this.sessionDid,
      type: "ingested",
      jwk,
      priority: 2,
    };

    // Convert PortableDelegation to Delegation type
    const delegationRecord: Delegation = {
      cid: delegation.cid,
      delegateDID: delegation.delegateDID,
      spaceId: delegation.spaceId,
      path: delegation.path,
      actions: delegation.actions,
      expiry: delegation.expiry,
      isRevoked: false,
      allowSubDelegation: !delegation.disableSubDelegation,
    };

    this._capabilityRegistry.ingestKey(keyInfo, delegationRecord);
  }

  /**
   * Key-value storage operations on this user's space.
   */
  get kv(): IKVService {
    if (!this._kv) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._kv;
  }

  /**
   * SQL database operations on this user's space.
   */
  get sql(): ISQLService {
    if (!this._sql) {
      const features = this.nodeFeatures;
      if (features.length > 0 && !features.includes("sql")) {
        throw new UnsupportedFeatureError("sql", this.config.host!, features);
      }
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._sql;
  }

  /**
   * Get an SQL service scoped to a specific space.
   *
   * Mirrors {@link SpaceService}'s per-space KV factory: clones the active
   * service context and overrides its session's spaceId so that subsequent
   * `sql/<dbName>/<action>` invocations route to that space. Useful when
   * the caller already holds a delegation covering the target space (e.g.
   * via {@link grantRuntimePermissions} or {@link useRuntimeDelegation})
   * but the SDK's per-space SQL surface isn't otherwise exposed.
   *
   * Does NOT auto-create the space.
   *
   * @param spaceId - Full space URI (`tinycloud:pkh:eip155:<chain>:<addr>:<name>`).
   */
  sqlForSpace(spaceId: string): ISQLService {
    if (!this._serviceContext || !this._serviceContext.session) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    const sql = new SQLService({});
    const spaceScopedContext = this._serviceGraph.track(new ServiceContext({
      invoke: this._serviceContext.invoke,
      invokeAny: this._serviceContext.invokeAny,
      fetch: this._serviceContext.fetch,
      hosts: this._serviceContext.hosts,
      telemetry: this.config.telemetry,
    }));
    spaceScopedContext.setSession({ ...this._serviceContext.session, spaceId });
    sql.initialize(spaceScopedContext);
    return sql;
  }

  /**
   * Get a KV service scoped to a specific space.
   *
   * The KV counterpart to {@link sqlForSpace}: clones the active service
   * context and overrides its session's spaceId so that subsequent
   * `kv/<action>` invocations route to that space. Useful for reading data
   * that a manifest app stores outside the primary space (e.g. transcripts a
   * `defaults: true` app keeps under the owner's `applications` space), when
   * the caller already holds a delegation covering the target space.
   *
   * Does NOT auto-create the space.
   *
   * @param spaceId - Full space URI (`tinycloud:pkh:eip155:<chain>:<addr>:<name>`).
   */
  kvForSpace(spaceId: string): IKVService {
    if (!this._serviceContext || !this._serviceContext.session) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    const kv = new KVService({});
    const spaceScopedContext = this._serviceGraph.track(new ServiceContext({
      invoke: this._serviceContext.invoke,
      invokeAny: this._serviceContext.invokeAny,
      fetch: this._serviceContext.fetch,
      hosts: this._serviceContext.hosts,
    }));
    spaceScopedContext.setSession({ ...this._serviceContext.session, spaceId });
    kv.initialize(spaceScopedContext);
    return kv;
  }

  /**
   * DuckDB database operations on this user's space.
   */
  get duckdb(): IDuckDbService {
    if (!this._duckdb) {
      const features = this.nodeFeatures;
      if (features.length > 0 && !features.includes("duckdb")) {
        throw new UnsupportedFeatureError("duckdb", this.config.host!, features);
      }
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._duckdb;
  }

  /**
   * Data Vault operations - client-side encrypted KV storage.
   * Call `vault.unlock(signer)` after signIn() to derive encryption keys.
   */
  get vault(): IDataVaultService {
    if (!this._vault) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._vault;
  }

  /**
   * Network-scoped encryption/decrypt service.
   */
  get encryption(): IEncryptionService {
    return this.getEncryptionService();
  }

  async getEncryptionNetwork(
    nameOrNetworkId = this.getDefaultEncryptionNetworkId(),
  ): Promise<NetworkDescriptor | null> {
    const networkId = nameOrNetworkId.startsWith("urn:tinycloud:encryption:")
      ? nameOrNetworkId
      : this.getDefaultEncryptionNetworkId(nameOrNetworkId);
    return this.fetchEncryptionNetworkAt(
      this.config.host!,
      networkId,
      globalThis.fetch.bind(globalThis),
    );
  }

  async createEncryptionNetwork(
    name = DEFAULT_ENCRYPTION_NETWORK_NAME,
  ): Promise<NetworkDescriptor> {
    const targetNode = await this.fetchNodeId();
    const ownerDid = this.did;
    const networkId = this.getDefaultEncryptionNetworkId(name);
    const body = {
      name,
      ownerDid,
      threshold: { n: 1, t: 1 },
    };
    const crypto = this.createEncryptionCrypto();
    const facts = {
      type: NETWORK_ADMIN_TYPE,
      targetNode,
      networkId,
      bodyHash: canonicalHashHex(
        crypto.sha256,
        body as unknown as CanonicalizableEncryptionJson,
      ),
      action: NETWORK_CREATE_ACTION,
    };
    const signed = await this.signRawNetworkAuthorization({
      targetNode,
      networkId,
      action: NETWORK_CREATE_ACTION,
      facts,
    });
    const response = await fetch(`${this.config.host}/encryption/networks`, {
      method: "POST",
      headers: {
        Authorization: signed.authorization,
        "Content-Type": "application/json",
      },
      body: canonicalizeEncryptionJson(
        body as unknown as CanonicalizableEncryptionJson,
      ),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to create encryption network ${networkId}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const created = (await response.json()) as { descriptor: NetworkDescriptor };
    return created.descriptor;
  }

  async ensureEncryptionNetwork(
    nameOrNetworkId = DEFAULT_ENCRYPTION_NETWORK_NAME,
  ): Promise<NetworkDescriptor> {
    const networkId = nameOrNetworkId.startsWith("urn:tinycloud:encryption:")
      ? nameOrNetworkId
      : this.getDefaultEncryptionNetworkId(nameOrNetworkId);
    const existing = await this.getEncryptionNetwork(networkId);
    if (existing) {
      return existing;
    }
    const parsed = parseNetworkId(networkId);
    if (!didPrincipalMatches(parsed.ownerDid, this.did)) {
      throw new Error(
        `Cannot create encryption network ${networkId}: owner ${parsed.ownerDid} does not match signed-in DID ${this.did}`,
      );
    }
    return this.createEncryptionNetwork(parsed.name);
  }

  /**
   * App-facing secrets API backed by the `secrets` space vault.
   */
  get secrets(): ISecretsService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this.secretsForSpace("secrets");
  }

  /**
   * App-facing secrets API backed by the requested space's vault.
   */
  secretsForSpace(spaceId: string): ISecretsService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    const resolvedSpace = spaceId.startsWith("tinycloud:")
      ? spaceId
      : this.ownedSpaceId(spaceId);
    let secrets = this._secrets.get(resolvedSpace);
    if (!secrets) {
      secrets = new NodeSecretsService({
        getService: () => this.getBaseSecrets(resolvedSpace),
        space: resolvedSpace,
        getManifest: () => this.manifest,
        hasPermissions: (permissions) => this.hasRuntimePermissions(permissions),
        grantPermissions: (additional) => this.grantRuntimePermissions(additional),
        canEscalate: () => this.signer !== undefined && this.tc !== undefined,
        getEncryptionNetworkId: () => this.getEncryptionNetworkIdForSpace(resolvedSpace),
        resolveSpace: (space) => space.startsWith("tinycloud:") ? space : this.ownedSpaceId(space),
        getUnlockSigner: () => this.signer ?? undefined,
      });
      this._secrets.set(resolvedSpace, secrets);
    }
    return secrets;
  }

  /**
   * Read a secret from an explicit target space without requesting or
   * auto-signing authority. Active runtime delegations are selected by the
   * normal KV and encryption invocation paths.
   */
  async readSecret(input: SecretReadInput): Promise<SecretReadResult> {
    const resolved = resolveSecretPath(input.name, { scope: input.scope });
    const targetSpace = input.space.startsWith("tinycloud:")
      ? input.space
      : this.ownedSpaceId(input.space);
    const result = await this.getBaseVault(targetSpace).readNetworkEncrypted<unknown>(
      resolved.vaultKey,
    );

    if (result.status !== "ok") {
      if (result.status === "permission_required") {
        const hint = parsePermissionHint(result.hint);
        if (hint === undefined) return { status: "read_failed" };
        return {
          status: "permission_required",
          hint: {
            service: hint.service,
            ...(hint.space === undefined ? {} : { space: hint.space }),
            path: hint.path,
            actions: [...hint.actions],
          },
        };
      }
      return { status: result.status };
    }
    if (!isSecretPayload(result.entry.value)) {
      return { status: "invalid_payload" };
    }
    return { status: "ok", value: result.entry.value.value };
  }

  private getBaseSecrets(spaceId: string): ISecretsService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    const resolvedSpace = spaceId.startsWith("tinycloud:")
      ? spaceId
      : this.ownedSpaceId(spaceId);
    let secrets = this._baseSecrets.get(resolvedSpace);
    if (!secrets) {
      secrets = new SecretsService(() => this.getBaseVault(resolvedSpace));
      this._baseSecrets.set(resolvedSpace, secrets);
    }
    return secrets;
  }

  private getBaseVault(spaceId: string): DataVaultService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    const resolvedSpace = spaceId.startsWith("tinycloud:")
      ? spaceId
      : this.ownedSpaceId(spaceId);
    let vault = this._baseVaults.get(resolvedSpace);
    if (!vault) {
      vault = this.createVaultService(
        resolvedSpace,
        this.createSpaceScopedKVService(resolvedSpace),
      );
      if (this._serviceContext) {
        vault.initialize(this._serviceContext);
      }
      this._baseVaults.set(resolvedSpace, vault);
    }
    return vault;
  }

  /**
   * Hooks write stream subscription API.
   */
  get hooks(): IHooksService {
    if (!this._hooks) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._hooks;
  }

  // ===========================================================================
  // v2 Service Accessors
  // ===========================================================================

  /**
   * Get the CapabilityKeyRegistry for managing keys and their capabilities.
   *
   * The registry tracks keys (session, main, ingested) and their associated
   * delegations, enabling automatic key selection for operations.
   *
   * @example
   * ```typescript
   * const registry = alice.capabilityRegistry;
   *
   * // Get the best key for an operation
   * const key = registry.getKeyForCapability(
   *   "tinycloud://my-space/kv/data",
   *   "tinycloud.kv/get"
   * );
   *
   * // List all capabilities
   * const capabilities = registry.getAllCapabilities();
   * ```
   */
  get capabilityRegistry(): ICapabilityKeyRegistry {
    if (!this._capabilityRegistry) {
      throw new Error("CapabilityKeyRegistry not initialized.");
    }
    return this._capabilityRegistry;
  }

  /**
   * Access received delegations (recipient view).
   *
   * Use this to see what delegations have been received via useDelegation().
   *
   * @example
   * ```typescript
   * // List all received delegations
   * const received = bob.delegations.list();
   * console.log("I have access to:", received.length, "spaces");
   *
   * // Get a specific delegation by CID
   * const delegation = bob.delegations.get(cid);
   * ```
   */
  get delegations(): {
    /** List all received delegations */
    list: () => Delegation[];
    /** Get a delegation by CID */
    get: (cid: string) => Delegation | undefined;
  } {
    const registry = this._capabilityRegistry;
    if (!registry) {
      return {
        list: () => [],
        get: () => undefined,
      };
    }

    return {
      list: () => registry.getAllCapabilities().map((entry) => entry.delegation),
      get: (cid: string) => {
        const capabilities = registry.getAllCapabilities();
        const entry = capabilities.find((e) => e.delegation.cid === cid);
        return entry?.delegation;
      },
    };
  }

  /**
   * Check whether the current session or an approved runtime delegation covers
   * every requested permission.
   */
  hasRuntimePermissions(permissions: PermissionEntry[]): boolean {
    const session = this.currentTinyCloudSession();
    if (!session || !Array.isArray(permissions) || permissions.length === 0) {
      return false;
    }

    const expanded = this.expandPermissionEntries(permissions);
    if (this.sessionCoversPermissionEntries(session, expanded)) {
      return true;
    }

    return this.findRuntimeGrantsForPermissionEntries(expanded, session).length > 0;
  }

  /**
   * Return installed runtime permission delegations. When `permissions` is
   * provided, only delegations currently covering those permissions are
   * returned. Base-session manifest permissions are not represented here.
   */
  getRuntimePermissionDelegations(
    permissions?: PermissionEntry[],
  ): PortableDelegation[] {
    this.pruneExpiredRuntimePermissionGrants();
    if (permissions === undefined) {
      // Exclude the synthetic primary grant: it represents the base session's
      // own recap, not an installed runtime delegation. Per this method's
      // contract, base-session manifest permissions are not represented here.
      return this.runtimePermissionGrants
        .filter((grant) => grant.provenance !== "primary")
        .map((grant) => grant.delegation);
    }

    const session = this.currentTinyCloudSession();
    if (!session || !Array.isArray(permissions) || permissions.length === 0) {
      return [];
    }
    const expanded = this.expandPermissionEntries(permissions);
    return this.findRuntimeGrantsForPermissionEntries(expanded, session).map(
      (grant) => grant.delegation,
    );
  }

  /**
   * Return the effective capabilities of installed runtime grants.
   *
   * The result is projected from the SDK's activated, expiry-pruned grant
   * operations rather than from PortableDelegation transport metadata. Base
   * session authority is intentionally omitted; callers that need the full
   * live authority must combine this with {@link getVerifiedSessionCapabilities}.
   */
  getEffectiveRuntimePermissionEntries(): PermissionEntry[] {
    const session = this.currentTinyCloudSession();
    if (!session) return [];

    this.pruneExpiredRuntimePermissionGrants();
    const grouped = new Map<string, PermissionEntry>();
    for (const grant of this.runtimePermissionGrants) {
      if (grant.provenance === "primary") continue;
      for (const operation of grant.operations) {
        const service = SERVICE_SHORT_TO_LONG[operation.service];
        if (service === undefined || typeof operation.path !== "string" ||
          typeof operation.action !== "string") {
          continue;
        }

        let space: string | undefined;
        if (service !== "tinycloud.encryption") {
          if (typeof operation.spaceId !== "string") continue;
          try {
            space = this.resolvePermissionSpace(operation.spaceId, session);
          } catch {
            continue;
          }
        }

        const caveats = operation.caveats === undefined || operation.caveats.length === 0
          ? undefined
          : cloneRecapCaveats(operation.caveats);
        const identity = JSON.stringify({
          service,
          ...(space === undefined ? {} : { space }),
          path: operation.path,
          caveats: canonicalizeRecapCaveats(caveats),
        });
        const existing = grouped.get(identity);
        if (existing === undefined) {
          grouped.set(identity, {
            service,
            ...(space === undefined ? {} : { space }),
            path: operation.path,
            actions: [operation.action],
            ...(caveats === undefined ? {} : { caveats }),
          });
          continue;
        }
        if (!existing.actions.includes(operation.action)) {
          existing.actions.push(operation.action);
          existing.actions.sort();
        }
      }
    }

    return [...grouped.values()].sort((left, right) =>
      left.service.localeCompare(right.service) ||
      (left.space ?? "").localeCompare(right.space ?? "") ||
      left.path.localeCompare(right.path) ||
      left.actions.join("\u0000").localeCompare(right.actions.join("\u0000")),
    );
  }

  /**
   * Install a portable runtime permission delegation into this SDK instance so
   * matching service calls and downstream `delegateTo()` calls can use it.
   */
  async useRuntimeDelegation(delegation: PortableDelegation): Promise<void> {
    const session = this.currentTinyCloudSession();
    if (!session) {
      throw new SessionExpiredError(new Date(0));
    }
    if (delegation.expiry.getTime() <= Date.now()) {
      throw new SessionExpiredError(delegation.expiry);
    }

    const expectedDids = [session.verificationMethod, this.sessionDid];
    if (!expectedDids.some((did) => didPrincipalMatches(delegation.delegateDID, did))) {
      throw new Error(
        `Runtime delegation targets ${delegation.delegateDID} but this session key is ${session.verificationMethod}.`,
      );
    }

    const targetHost = delegation.host ?? this.config.host!;
    const activateResult = await activateSessionWithHost(
      targetHost,
      delegation.delegationHeader,
    );
    if (!activateResult.success) {
      throw new Error(
        `Failed to activate runtime permission delegation: ${activateResult.error}`,
      );
    }

    this.runtimePermissionGrants = this.runtimePermissionGrants.filter(
      (grant) => grant.delegation.cid !== delegation.cid,
    );
    this.runtimePermissionGrants.push(
      this.runtimeGrantFromDelegation(delegation, session),
    );
  }

  /**
   * Store additional permissions as narrow delegations to the current session
   * key. Future service invocations automatically use a stored delegation when
   * its `(space, service, path, action)` covers the request.
   */
  async grantRuntimePermissions(
    permissions: PermissionEntry[],
    options?: RuntimePermissionGrantOptions,
  ): Promise<PortableDelegation[]> {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error("grantRuntimePermissions requires a non-empty permissions array");
    }
    const session = this.currentTinyCloudSession();
    if (!session) {
      throw new SessionExpiredError(new Date(0));
    }

    const sessionExpiry = extractSiweExpiration(session.siwe);
    if (sessionExpiry !== undefined) {
      const marginMs = TinyCloudNode.SESSION_EXPIRY_SAFETY_MARGIN_MS;
      if (sessionExpiry.getTime() <= Date.now() + marginMs) {
        throw new SessionExpiredError(sessionExpiry);
      }
    }

    const expanded = this.expandPermissionEntries(permissions);
    if (this.sessionCoversPermissionEntries(session, expanded)) {
      return [];
    }

    const existingGrants = this.findRuntimeGrantsForPermissionEntries(expanded, session);
    if (existingGrants.length > 0) {
      return existingGrants.map((grant) => grant.delegation);
    }
    if (!this.signer) {
      throw new Error(
        "grantRuntimePermissions requires wallet mode with a signer or privateKey.",
      );
    }
    this.assertDelegationCaveatsPreservable(expanded);

    const rawEntries = expanded.filter((entry) =>
      this.isEncryptionPermissionEntry(entry)
    );
    const spaceEntries = expanded.filter((entry) =>
      !this.isEncryptionPermissionEntry(entry)
    );

    const bySpace = new Map<string, PermissionEntry[]>();
    for (const entry of spaceEntries) {
      const spaceId = this.resolvePermissionSpace(entry.space, session);
      const current = bySpace.get(spaceId) ?? [];
      current.push(entry);
      bySpace.set(spaceId, current);
    }
    if (bySpace.size === 0 && rawEntries.length > 0) {
      bySpace.set(session.spaceId, []);
    }

    const now = new Date();
    const requestedExpiryMs = resolveExpiryMs(options?.expiry);
    let expiresAt = new Date(now.getTime() + requestedExpiryMs);
    if (sessionExpiry !== undefined && sessionExpiry < expiresAt) {
      expiresAt = sessionExpiry;
    }

    const delegations: PortableDelegation[] = [];
    let rawEntriesAttached = false;
    for (const [spaceId, entries] of bySpace) {
      const rawForDelegation = !rawEntriesAttached ? rawEntries : [];
      if (rawForDelegation.length > 0) {
        rawEntriesAttached = true;
      }
      const delegatedEntries = [...entries, ...rawForDelegation];
      const abilities = this.permissionsToAbilities(entries);
      const prepared = this.wasmBindings.prepareSession({
        abilities,
        ...(rawForDelegation.length > 0
          ? { rawAbilities: this.permissionsToRawAbilities(rawForDelegation) }
          : {}),
        address: this.wasmBindings.ensureEip55(session.address),
        chainId: session.chainId,
        domain: this.siweDomain,
        issuedAt: now.toISOString(),
        expirationTime: expiresAt.toISOString(),
        spaceId,
        jwk: session.jwk,
      });

      const signature = await this.signer.signMessage(prepared.siwe);
      const delegatedSession = this.wasmBindings.completeSessionSetup({
        ...prepared,
        signature,
      });

      const activateResult = await activateSessionWithHost(
        this.config.host!,
        delegatedSession.delegationHeader,
      );
      if (!activateResult.success) {
        throw new Error(
          `Failed to activate runtime permission delegation: ${activateResult.error}`,
        );
      }

      const delegation = this.runtimeDelegationFromSession(
        delegatedSession,
        delegatedEntries,
        spaceId,
        session,
        expiresAt,
      );
      this.runtimePermissionGrants.push({
        session: {
          delegationHeader: delegatedSession.delegationHeader,
          delegationCid: delegatedSession.delegationCid,
          spaceId,
          verificationMethod: session.verificationMethod,
          jwk: session.jwk,
        },
        delegation,
        operations: this.permissionOperations(delegatedEntries, spaceId),
        expiresAt,
        provenance: "runtime",
      });
      delegations.push(delegation);
    }

    return delegations;
  }

  /**
   * Get the DelegationManager for delegation CRUD operations.
   *
   * This is the v2 delegation service providing a cleaner API than
   * the legacy createDelegation/useDelegation methods.
   *
   * @example
   * ```typescript
   * const delegations = alice.delegationManager;
   *
   * // Create a delegation
   * const result = await delegations.create({
   *   delegateDID: bob.did,
   *   path: "shared/",
   *   actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
   *   expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
   * });
   *
   * // List delegations
   * const listResult = await delegations.list();
   *
   * // Revoke a delegation
   * await delegations.revoke(delegationCid);
   * ```
   */
  get delegationManager(): DelegationManager {
    if (!this._delegationManager) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._delegationManager;
  }

  /**
   * Get the SpaceService for managing spaces.
   *
   * The SpaceService provides access to owned and delegated spaces,
   * including space creation, listing, and scoped operations.
   *
   * @example
   * ```typescript
   * const spaces = alice.spaces;
   *
   * // List all accessible spaces
   * const result = await spaces.list();
   *
   * // Create a new space
   * const createResult = await spaces.create('photos');
   *
   * // Get a space object for operations
   * const mySpace = spaces.get('default');
   * await mySpace.kv.put('key', 'value');
   *
   * // Check if a space exists
   * const exists = await spaces.exists('photos');
   * ```
   */
  get spaces(): ISpaceService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this._spaceService;
  }

  /**
   * Alias for `spaces` - get the SpaceService.
   * @see spaces
   */
  get spaceService(): ISpaceService {
    return this.spaces;
  }

  /**
   * Get a Space object by short name or full URI.
   */
  space(nameOrUri: string): ISpace {
    return this.spaces.get(nameOrUri);
  }

  /**
   * Get the SharingService for creating and receiving v2 sharing links.
   *
   * The SharingService creates sharing links with embedded private keys,
   * allowing recipients to exercise delegations without prior session setup.
   *
   * @example
   * ```typescript
   * const sharing = alice.sharing;
   *
   * // Generate a sharing link
   * const result = await sharing.generate({
   *   path: "/kv/documents/report.pdf",
   *   actions: ["tinycloud.kv/get"],
   *   expiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
   * });
   *
   * if (result.ok) {
   *   console.log("Share URL:", result.data.url);
   *   // Send the URL to the recipient
   * }
   *
   * // Receive a sharing link
   * const receiveResult = await sharing.receive(shareUrl);
   * if (receiveResult.ok) {
   *   // Use the pre-configured KV service
   *   const data = await receiveResult.data.kv.get("report.pdf");
   * }
   * ```
   */
  get sharing(): ISharingService {
    // SharingService is initialized in constructor for receive-only access
    // Full capabilities (generate) are added after signIn()
    return this._sharingService;
  }

  /**
   * Alias for `sharing` - get the SharingService.
   * @see sharing
   */
  get sharingService(): ISharingService {
    return this.sharing;
  }

  // ===========================================================================
  // Public Space Methods
  // ===========================================================================

  /**
   * Ensure the user's public space exists and is accessible.
   * Creates the space and activates a session delegation for it.
   * This is the trigger for lazy public space creation — call it
   * before writing to spaces.get('public').kv.
   */
  async ensurePublicSpace() {
    if (!this.auth || !this.session || !this.signer) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    const publicSpaceId = this.session.spaces?.public;
    if (!publicSpaceId) {
      throw new Error("Public space not enabled. Set enablePublicSpace: true in config.");
    }

    // Create the public space on the server (host SIWE)
    await (this.auth as NodeUserAuthorization).hostPublicSpace(publicSpaceId);

    // Create a session delegation for the public space using the session key JWK.
    // This mirrors the primary session flow (prepareSession with jwk), ensuring
    // the delegation targets the session key — not the PKH DID — so that
    // invoke() requests signed by the session key are properly authorized.
    const kvActions = [KV.PUT, KV.GET, KV.DEL, KV.LIST, KV.METADATA];
    const abilities = { kv: { "": kvActions } };
    const now = new Date();
    // EPHEMERAL tier — this sub-delegation is auto-derived from the
    // session and re-issued whenever the SDK touches the public space,
    // so a short lifetime bounds replay without forcing user re-prompts.
    const expiryMs = EXPIRY.EPHEMERAL_MS;
    const expirationTime = new Date(now.getTime() + expiryMs);

    const prepared = this.wasmBindings.prepareSession({
      abilities,
      address: this.wasmBindings.ensureEip55(this.session.address),
      chainId: this.session.chainId,
      domain: this.siweDomain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId: publicSpaceId,
      jwk: this.session.jwk,
      parents: [this.session.delegationCid],
    });

    const signature = await this.signer.signMessage(prepared.siwe);

    const delegationSession = this.wasmBindings.completeSessionSetup({
      ...prepared,
      signature,
    });

    const activateResult = await activateSessionWithHost(
      this.config.host!,
      delegationSession.delegationHeader
    );

    if (!activateResult.success) {
      throw new Error(`Failed to activate public space delegation: ${activateResult.error}`);
    }

    // Register the delegation in the capability registry so
    // spaces.get('public').kv operations are authorized
    if (this._capabilityRegistry && this.session) {
      const sessionKey: KeyInfo = {
        id: this.session.sessionKey,
        did: this.session.verificationMethod,
        type: "session",
        jwk: this.session.jwk as JWK,
        priority: 0,
      };
      this._capabilityRegistry.registerKey(sessionKey, [{
        cid: delegationSession.delegationCid,
        delegateDID: this.session.verificationMethod,
        spaceId: publicSpaceId,
        path: "",
        actions: kvActions,
        expiry: expirationTime,
        isRevoked: false,
        allowSubDelegation: true,
      }]);
    }

    // Cache a properly authorized public KV service using the new delegation
    if (this._serviceContext) {
      const publicKV = new KVService({ prefix: "" });
      const publicContext = this._serviceGraph.track(new ServiceContext({
        invoke: this._serviceGraph.invoke,
        fetch: this._serviceGraph.fetch,
        hosts: this._serviceContext.hosts,
        telemetry: this.config.telemetry,
      }));
      publicContext.setSession({
        delegationHeader: delegationSession.delegationHeader,
        delegationCid: delegationSession.delegationCid,
        spaceId: publicSpaceId,
        verificationMethod: this.session.verificationMethod,
        jwk: this.session.jwk,
      });
      publicKV.initialize(publicContext);
      this._publicKV = publicKV;
    }
  }

  /**
   * Get a KVService scoped to the user's own public space.
   * Writes require authentication (owner/delegate).
   */
  get publicKV(): IKVService {
    if (this._publicKV) {
      return this._publicKV;
    }
    if (!this.tc) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return this.tc.publicKV;
  }

  // ===========================================================================
  // v2 Delegation Convenience Methods
  // ===========================================================================

  /**
   * Create a delegation using the v2 DelegationManager.
   *
   * This is a convenience method that wraps DelegationManager.create().
   * For more control, use `this.delegationManager` directly.
   *
   * @param params - Delegation parameters
   * @returns Result containing the created Delegation
   *
   * @example
   * ```typescript
   * const result = await alice.delegate({
   *   delegateDID: bob.did,
   *   path: "shared/",
   *   actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
   *   expiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
   * });
   *
   * if (result.ok) {
   *   console.log("Delegation created:", result.data.cid);
   * }
   * ```
   */
  async delegate(params: CreateDelegationParams): Promise<DelegationResult<Delegation>> {
    return this.delegationManager.create(params);
  }

  /**
   * Revoke a delegation using the v2 DelegationManager.
   *
   * @param cid - The CID of the delegation to revoke
   * @returns Result indicating success or failure
   */
  async revokeDelegation(cid: string): Promise<DelegationResult<DelegationRevocationReceipt>> {
    return this.delegationManager.revoke(cid);
  }

  /** Read node-confirmed lifecycle state for one delegation. */
  async getDelegationStatus(cid: string): Promise<DelegationResult<DelegationStatus>> {
    return this.delegationManager.status(cid);
  }

  /** Compute the canonical CID of a compact UCAN or DAG-CBOR delegation authorization. */
  computeDelegationCid(authorization: string): string {
    if (!authorization || !this.wasmBindings.computeCid) {
      throw new Error("Delegation CID computation is unavailable");
    }
    const compact = authorization.replace(/^Bearer /i, "");
    return this.wasmBindings.computeCid(
      compact.includes(".")
        ? new TextEncoder().encode(compact)
        : decodeAuthorizationBytes(authorization),
      0x55n,
    );
  }

  /**
   * List all delegations for the current session's space.
   *
   * @returns Result containing an array of Delegations
   */
  async listDelegations(): Promise<DelegationResult<Delegation[]>> {
    return this.delegationManager.list();
  }

  /**
   * Check if the current session has permission for a path and action.
   *
   * @param path - The resource path to check
   * @param action - The action to check (e.g., "tinycloud.kv/get")
   * @returns Result containing boolean permission status
   */
  async checkPermission(path: string, action: string): Promise<DelegationResult<boolean>> {
    return this.delegationManager.checkPermission(path, action);
  }

  // ===========================================================================
  // Capability-chain delegation (spec: .claude/specs/capability-chain.md)
  // ===========================================================================

  /**
   * Safety margin before the session's own expiry at which {@link delegateTo}
   * will refuse to issue a derived delegation. Prevents issuing sub-delegations
   * that would be invalid by the time the recipient used them. Spec: 60 seconds.
   *
   * @internal
   */
  private static readonly SESSION_EXPIRY_SAFETY_MARGIN_MS = 60_000;

  /**
   * Issue a delegation using the capability-chain flow.
   *
   * When every requested permission is a subset of the current
   * session's recap, or of one installed runtime permission delegation,
   * the delegation is signed by the session key via WASM — no wallet
   * prompt. When at least one is NOT derivable, a
   * {@link PermissionNotInManifestError} is raised (carrying the
   * missing entries) so the caller can trigger an escalation flow
   * (e.g. `TinyCloudWeb.requestPermissions`). Passing
   * `forceWalletSign: true` bypasses the derivability check and
   * always uses the wallet-signed SIWE path — used by the legacy
   * `createDelegation` fallback and by callers that want explicit
   * wallet confirmation.
   *
   * Multi-entry delegations are now emitted as **one** signed UCAN:
   * the underlying WASM `createDelegation` takes a full
   * `HashMap<Service, HashMap<Path, Vec<Ability>>>` abilities map
   * and produces a single attenuation carrying every
   * `(service, path, actions)` entry. The returned
   * {@link DelegateToResult.delegation} is that single blob, and
   * apps can POST it to their backend exactly like a single-entry
   * delegation (the server verifies all granted resources from one
   * UCAN).
   *
   * For single-entry requests the `PortableDelegation.path` and
   * `.actions` fields mirror the one granted entry. For
   * multi-entry requests they mirror the **first** entry (stable
   * lexicographic order from the Rust side); consumers that need
   * the full picture read `PortableDelegation.resources`.
   *
   * @throws {@link SessionExpiredError} when there is no session or
   *   the current session has expired (or will within the 60s
   *   safety margin).
   * @throws {@link PermissionNotInManifestError} when any requested
   *   entry is not a subset of the granted session capabilities and
   *   `forceWalletSign` is not set.
   */
  async delegateTo(
    did: string,
    permissions: PermissionEntry[],
    options?: DelegateToOptions,
  ): Promise<DelegateToResult> {
    // 1. Session validity check — fail fast with a clear error class so
    //    callers can catch and trigger a fresh sign-in.
    const session = this.currentTinyCloudSession();
    if (!session) {
      throw new SessionExpiredError(new Date(0));
    }
    const sessionExpiry = extractSiweExpiration(session.siwe);
    if (sessionExpiry !== undefined) {
      const now = Date.now();
      const marginMs = TinyCloudNode.SESSION_EXPIRY_SAFETY_MARGIN_MS;
      if (sessionExpiry.getTime() <= now + marginMs) {
        throw new SessionExpiredError(sessionExpiry);
      }
    }

    // 2. Input validation. Empty arrays and non-arrays both fail here so
    //    downstream code can safely assume at least one entry.
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error(
        "delegateTo requires a non-empty permissions array",
      );
    }

    // 3. Defensively expand any short-form action names into full URNs
    //    for every entry so the subset check and downstream WASM call
    //    both see canonical form. This also deep-copies the entries so
    //    we don't mutate caller-owned data.
    const expandedEntries = this.expandPermissionEntries(permissions);

    // 4. Compute expiration. `options.expiry` overrides the default 1h.
    //    ms-format ("7d") or raw millisecond count both accepted. Cap
    //    at the session's own expiry so we never emit a UCAN whose
    //    validity exceeds the parent chain.
    const now = new Date();
    const expiryMs = resolveExpiryMs(options?.expiry);
    const expirationTime = new Date(now.getTime() + expiryMs);
    let effectiveExpiration = expirationTime;
    if (sessionExpiry !== undefined && sessionExpiry < expirationTime) {
      effectiveExpiration = sessionExpiry;
    }

    // 5. forceWalletSign short-circuit → always legacy path. The
    //    legacy wallet path currently handles one `(space, path)` at
    //    a time, so we only support single-entry when forced. Callers
    //    that need multi-entry wallet-signed delegations should issue
    //    them via the legacy `createDelegation` which loops internally
    //    (or just not pass `forceWalletSign: true`).
    if (options?.forceWalletSign) {
      if (expandedEntries.length > 1) {
        throw new Error(
          "delegateTo with forceWalletSign=true supports at most one " +
            "PermissionEntry. Multi-entry requests must go through the " +
            "session-key UCAN path (drop forceWalletSign) or the legacy " +
            "createDelegation method.",
        );
      }
      this.assertDelegationCaveatsPreservable(expandedEntries);
      const delegation = await this.createDelegationLegacyWalletPath(
        did,
        expandedEntries[0],
        effectiveExpiration,
      );
      return { delegation, prompted: true };
    }

    // 6. Derivability check across ALL entries. If any entry is not a
    //    subset of the granted session capabilities, the whole call
    //    fails with a typed error carrying the missing entries — we do
    //    NOT partially issue and drop the failing ones, because that
    //    would produce a delegation the caller didn't ask for.
    //
    //    `parseRecapCapabilities` is a thin wrapper around the
    //    injected WASM binding; the binding is required because
    //    `IWasmBindings` declares `parseRecapFromSiwe` as mandatory.
    //    If the runtime binding hasn't been updated, this call will
    //    surface a clear TypeError rather than silently falling
    //    through.
    const granted = parseRecapCapabilities(
      (siwe: string) => this.parseRecapWithCaveats(siwe),
      session.siwe,
    );
    const { subset, missing } = isCapabilitySubset(expandedEntries, granted);

    if (!subset) {
      // This branch only runs when the session recap is NOT a superset of the
      // requested entries. The synthetic primary grant is built from that same
      // recap, so it should never cover an entry the recap itself doesn't —
      // but `operationCovers` is strictly more permissive than
      // `isCapabilitySubset` (action `/*` and path `/*`/`/**` wildcards), so a
      // wildcard-bearing recap could slip through and mint a delegation with
      // the primary session's spaceId (the wrong-space class). Exclude the
      // primary explicitly; failure then degrades to
      // PermissionNotInManifestError instead of a wrong-space delegation.
      const runtimeOperations = this.permissionEntriesToOperations(expandedEntries, session);
      const runtimeGrant = this.findGrantForOperations(
        runtimeOperations,
        { excludePrimary: true },
      );
      if (runtimeGrant) {
        const marginMs = TinyCloudNode.SESSION_EXPIRY_SAFETY_MARGIN_MS;
        if (runtimeGrant.expiresAt.getTime() <= Date.now() + marginMs) {
          throw new SessionExpiredError(runtimeGrant.expiresAt);
        }
        const runtimeExpiration =
          runtimeGrant.expiresAt < effectiveExpiration
            ? runtimeGrant.expiresAt
            : effectiveExpiration;
        const delegation = await this.createDelegationViaRuntimeGrant(
          did,
          expandedEntries,
          runtimeExpiration,
          runtimeGrant,
          runtimeOperations,
        );
        return { delegation, prompted: false };
      }
      throw new PermissionNotInManifestError(missing, granted);
    }

    // 7. Subset path — sign ONE sub-delegation with the session key
    //    via WASM that carries every requested entry. No wallet
    //    prompt. `createDelegationViaWasmPath` builds the
    //    multi-resource abilities map and returns a single
    //    PortableDelegation whose `.resources` field lists every
    //    granted entry.
    const delegation = await this.createDelegationViaWasmPath(
      did,
      expandedEntries,
      effectiveExpiration,
      session,
    );
    return { delegation, prompted: false };
  }

  /**
   * Materialize one manifest-declared delegation using the current session key.
   * Delivery is intentionally out of band; callers decide how to transmit the
   * returned UCAN to the delegate.
   */
  async materializeDelegation(
    did: string,
    request: ComposedManifestRequest | undefined = this.capabilityRequest,
  ): Promise<DelegateToResult & { target: ResolvedDelegate }> {
    if (!request) {
      throw new Error(
        "materializeDelegation requires a composed manifest request",
      );
    }
    const target = request.delegationTargets.find((entry) =>
      didPrincipalMatches(entry.did, did),
    );
    if (!target) {
      throw new Error(`No manifest delegation target found for DID ${did}`);
    }
    const result = await this.delegateTo(target.did, target.permissions, {
      expiry: target.expiryMs,
    });
    return { ...result, target };
  }

  /**
   * Materialize every delegation target declared by the composed manifest
   * request. This does not deliver the delegations anywhere.
   */
  async materializeDelegations(
    request: ComposedManifestRequest | undefined = this.capabilityRequest,
  ): Promise<Array<DelegateToResult & { target: ResolvedDelegate }>> {
    if (!request) {
      throw new Error(
        "materializeDelegations requires a composed manifest request",
      );
    }
    const out: Array<DelegateToResult & { target: ResolvedDelegate }> = [];
    for (const target of request.delegationTargets) {
      out.push(await this.materializeDelegation(target.did, request));
    }
    return out;
  }

  /**
   * Issue a delegation via the session-key UCAN WASM path.
   *
   * The caller has already verified every entry is derivable from
   * the current session; we build one multi-resource abilities map
   * and emit one signed UCAN covering them all.
   *
   * Non-encryption entries must share the same target space. Encryption
   * entries are raw network URNs and do not participate in space grouping.
   *
   * @internal
   */
  private async createDelegationViaWasmPath(
    did: string,
    entries: PermissionEntry[],
    expirationTime: Date,
    session: TinyCloudSession,
  ): Promise<PortableDelegation> {
    if (entries.length === 0) {
      throw new Error(
        "createDelegationViaWasmPath requires a non-empty entries array",
      );
    }
    this.assertDelegationCaveatsPreservable(entries);

    // Translate non-raw manifest `space` fields into the server-side
    // spaceId. Encryption entries target raw network URNs, not spaces.
    const resolvedSpaces = new Set<string>();
    for (const entry of entries) {
      if (this.isEncryptionPermissionEntry(entry)) {
        continue;
      }
      const spaceId = this.resolvePermissionSpace(entry.space, session);
      resolvedSpaces.add(spaceId);
    }
    if (resolvedSpaces.size > 1) {
      throw new Error(
        `delegateTo: all permission entries must target the same space, got ${resolvedSpaces.size}: ${JSON.stringify([...resolvedSpaces])}`,
      );
    }
    const spaceId = resolvedSpaces.size === 1
      ? [...resolvedSpaces][0]
      : session.spaceId;

    // Convert entries to the WASM abilities shape. Each entry's
    // `service` is the long form (e.g. "tinycloud.kv") which we
    // translate to the short form keyed by the abilities map. Raw
    // encryption network entries stay in this map because the Rust
    // create_delegation boundary special-cases network URNs into raw
    // resources while preserving the legacy spaceId parameter.
    // Multiple entries on the same (service, path) merge and dedupe
    // their action lists — unusual in practice (the subset check
    // should have pruned dupes already) but cheap and safe.
    const abilities: AbilitiesMap = {};
    for (const entry of entries) {
      const shortService = SERVICE_LONG_TO_SHORT[entry.service];
      if (shortService === undefined) {
        throw new Error(
          `delegateTo: unknown service '${entry.service}' — no short-form mapping`,
        );
      }
      if (abilities[shortService] === undefined) {
        abilities[shortService] = {};
      }
      const pathsMap = abilities[shortService];
      const existing = pathsMap[entry.path];
      if (existing === undefined) {
        pathsMap[entry.path] = [...entry.actions];
      } else {
        const seen = new Set(existing);
        for (const action of entry.actions) {
          if (!seen.has(action)) {
            existing.push(action);
            seen.add(action);
          }
        }
      }
    }

    // Build ServiceSession from TinyCloudSession. This mirrors how
    // SharingService hands sessions to createDelegationWrapper.
    const serviceSession: ServiceSession = {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      jwk: session.jwk,
      spaceId,
      verificationMethod: session.verificationMethod,
    };

    const expirationSecs = Math.floor(expirationTime.getTime() / 1000);
    const result = this.createDelegationWrapper({
      session: serviceSession,
      delegateDID: did,
      spaceId,
      abilities,
      expirationSecs,
    });

    // Translate the WASM result into a PortableDelegation. We don't
    // have a structured delegation header from the WASM path, so we
    // synthesize one from the serialized delegation (the recipient
    // decodes it via `deserializeDelegation`).
    //
    // The flat `.path` and `.actions` fields mirror the first
    // resource — stable because the Rust side sorts by
    // (service, path) before signing. Consumers that need the full
    // multi-resource picture read `.resources`.
    const primary = result.resources[0];
    // Use the raw JWT without a "Bearer " prefix. The host's HeaderEncode
    // decoder passes the header value directly to Ucan::decode(), which
    // expects a bare JWT string. The wallet-signed CACAO path also uses
    // raw base64 without any prefix. Adding "Bearer " causes a parse
    // failure that surfaces as a 401 from the host.
    const delegationHeader = { Authorization: result.delegation };

    // Activate the delegation with the host so downstream consumers (e.g.
    // a backend calling useDelegation) can find it by CID when building
    // their invoker SIWE. The host validates the UCAN's parent chain
    // (session key → wallet SIWE) to confirm authority.
    const activateResult = await activateSessionWithHost(
      this.config.host!,
      delegationHeader,
    );
    if (!activateResult.success) {
      throw new Error(
        `Failed to activate delegation with host: ${activateResult.error}`,
      );
    }

    return {
      cid: result.cid,
      delegationHeader,
      spaceId,
      path: primary.path,
      actions: primary.actions,
      resources: result.resources,
      disableSubDelegation: false,
      expiry: result.expiry,
      delegateDID: did,
      ownerAddress: session.address,
      chainId: session.chainId,
      host: this.config.host,
    };
  }

  private async createDelegationViaRuntimeGrant(
    did: string,
    entries: PermissionEntry[],
    expirationTime: Date,
    grant: RuntimePermissionGrant,
    requestedOperations: RuntimePermissionOperation[],
  ): Promise<PortableDelegation> {
    this.assertRuntimeGrantCaveatsPreservable(entries, requestedOperations, grant);
    this.assertDelegationCaveatsPreservable(entries);
    const result = this.createDelegationWrapper({
      session: grant.session,
      delegateDID: did,
      spaceId: grant.session.spaceId,
      abilities: this.permissionsToAbilities(entries),
      expirationSecs: Math.floor(expirationTime.getTime() / 1000),
    });

    const primary = result.resources[0];
    const delegationHeader = { Authorization: result.delegation };
    const targetHost = grant.delegation.host ?? this.config.host!;
    const activateResult = await activateSessionWithHost(
      targetHost,
      delegationHeader,
    );
    if (!activateResult.success) {
      throw new Error(
        `Failed to activate delegation with host: ${activateResult.error}`,
      );
    }

    return {
      cid: result.cid,
      delegationHeader,
      spaceId: grant.session.spaceId,
      path: primary.path,
      actions: primary.actions,
      resources: result.resources,
      disableSubDelegation: false,
      expiry: result.expiry,
      delegateDID: did,
      ownerAddress: grant.delegation.ownerAddress,
      chainId: grant.delegation.chainId,
      host: targetHost,
    };
  }

  private resolvePermissionSpace(
    space: string | undefined,
    session: TinyCloudSession,
  ): string {
    if (space === undefined) {
      return this.wasmBindings.makeSpaceId(
        session.address,
        session.chainId,
        "applications",
      );
    }
    if (space === "default") {
      return session.spaceId;
    }
    if (space.startsWith("tinycloud:")) {
      return space;
    }
    return this.wasmBindings.makeSpaceId(session.address, session.chainId, space);
  }

  private expandPermissionEntries(
    permissions: PermissionEntry[],
  ): PermissionEntry[] {
    return expandPermissionEntriesCore(permissions);
  }

  /**
   * The current WASM child-delegation APIs accept action-only maps. Refuse any
   * constrained branch rather than signing a broader action-only child UCAN.
   */
  private assertDelegationCaveatsPreservable(entries: PermissionEntry[]): void {
    const caveated = entries.filter((entry) =>
      !recapCaveatsEqual(entry.caveats, undefined)
    );
    if (caveated.length > 0) {
      throw new CaveatedDelegationUnsupportedError(caveated);
    }
  }

  /**
   * Runtime grant selection intentionally allows an uncaveated operation to
   * select a caveated grant so invocation can restore the signed caveat before
   * crossing the caveat-aware WASM boundary. Child delegation cannot do that:
   * it only accepts action maps, so reject the selected constrained branch.
   */
  private assertRuntimeGrantCaveatsPreservable(
    entries: PermissionEntry[],
    requestedOperations: RuntimePermissionOperation[],
    grant: RuntimePermissionGrant,
  ): void {
    let operationIndex = 0;
    const caveated: PermissionEntry[] = [];
    for (const entry of entries) {
      for (const action of entry.actions) {
        const requested = requestedOperations[operationIndex++];
        if (!requested) continue;
        const constrained = grant.operations.find((granted) =>
          this.operationCovers(granted, requested) &&
          !recapCaveatsEqual(granted.caveats, undefined),
        );
        if (constrained) {
          caveated.push({
            ...entry,
            actions: [action],
            caveats: cloneRecapCaveats(constrained.caveats),
          });
        }
      }
    }
    if (caveated.length > 0) {
      throw new CaveatedDelegationUnsupportedError(caveated);
    }
  }

  /** Reject caveated parent branches before action-only child signing. */
  private assertPortableDelegationCaveatsPreservable(
    delegation: PortableDelegation,
  ): void {
    const entries: PermissionEntry[] = [];
    const add = (
      service: string,
      space: string,
      path: string,
      actions: string[],
      caveats: readonly Record<string, unknown>[] | undefined,
    ): void => {
      if (recapCaveatsEqual(caveats, undefined)) return;
      entries.push({
        service: service.startsWith("tinycloud.") ? service : `tinycloud.${service}`,
        space,
        path,
        actions: [...actions],
        caveats: cloneRecapCaveats(caveats),
      });
    };

    add(
      delegation.actions[0]?.split("/", 1)[0] ?? "tinycloud.unknown",
      delegation.spaceId,
      delegation.path,
      delegation.actions,
      delegation.caveats,
    );
    for (const resource of delegation.resources ?? []) {
      add(resource.service, resource.space, resource.path, resource.actions, resource.caveats);
    }
    if (entries.length > 0) {
      throw new CaveatedDelegationUnsupportedError(entries);
    }
  }

  private shortServiceName(service: string): string {
    const short = SERVICE_LONG_TO_SHORT[service];
    if (short === undefined) {
      throw new Error(
        `unknown service '${service}' — no short-form mapping`,
      );
    }
    return short;
  }

  private permissionsToAbilities(entries: PermissionEntry[]): AbilitiesMap {
    const abilities: AbilitiesMap = {};
    for (const entry of entries) {
      const service = this.shortServiceName(entry.service);
      abilities[service] ??= {};
      const existing = abilities[service][entry.path] ?? [];
      const seen = new Set(existing);
      for (const action of entry.actions) {
        if (!seen.has(action)) {
          existing.push(action);
          seen.add(action);
        }
      }
      abilities[service][entry.path] = existing;
    }
    return abilities;
  }

  private isEncryptionPermissionEntry(entry: PermissionEntry): boolean {
    return entry.service === ENCRYPTION_PERMISSION_SERVICE &&
      entry.path.startsWith("urn:tinycloud:encryption:");
  }

  private permissionsToRawAbilities(
    entries: PermissionEntry[],
  ): Record<string, string[]> {
    const rawAbilities: Record<string, string[]> = {};
    for (const entry of entries) {
      if (!this.isEncryptionPermissionEntry(entry)) {
        continue;
      }
      const existing = rawAbilities[entry.path] ?? [];
      const seen = new Set(existing);
      for (const action of entry.actions) {
        if (!seen.has(action)) {
          existing.push(action);
          seen.add(action);
        }
      }
      rawAbilities[entry.path] = existing;
    }
    return rawAbilities;
  }

  private permissionOperations(
    entries: PermissionEntry[],
    spaceId: string,
  ): RuntimePermissionOperation[] {
    return entries.flatMap((entry) => {
      const service = this.shortServiceName(entry.service);
      return entry.actions.map((action) => ({
        ...(this.isEncryptionNetworkOperation(service, entry.path)
          ? { resource: entry.path }
          : { spaceId }),
        service,
        path: entry.path,
        action,
        ...(entry.caveats === undefined ? {} : { caveats: cloneRecapCaveats(entry.caveats) }),
      }));
    });
  }

  private sessionCoversPermissionEntries(
    session: TinyCloudSession,
    entries: PermissionEntry[],
  ): boolean {
    try {
      const granted = parseRecapCapabilities(
        (siwe: string) => this.parseRecapWithCaveats(siwe),
        session.siwe,
      );
      return isCapabilitySubset(entries, granted).subset;
    } catch {
      return false;
    }
  }

  private permissionEntriesToOperations(
    entries: PermissionEntry[],
    session: TinyCloudSession,
  ): RuntimePermissionOperation[] {
    return entries.flatMap((entry) => {
      const spaceId = this.resolvePermissionSpace(entry.space, session);
      const service = this.shortServiceName(entry.service);
      return entry.actions.map((action) => ({
        ...(this.isEncryptionNetworkOperation(service, entry.path)
          ? { resource: entry.path }
          : { spaceId }),
        service,
        path: entry.path,
        action,
        ...(entry.caveats === undefined ? {} : { caveats: cloneRecapCaveats(entry.caveats) }),
      }));
    });
  }

  private findRuntimeGrantsForPermissionEntries(
    entries: PermissionEntry[],
    session: TinyCloudSession,
  ): RuntimePermissionGrant[] {
    const grants: RuntimePermissionGrant[] = [];
    const operations = this.permissionEntriesToOperations(entries, session);
    if (operations.length === 0) {
      return grants;
    }

    for (const operation of operations) {
      // Public surface: never surface the synthetic primary grant. It exists
      // only to win runtime invocation selection; the base session's own recap
      // is not an installed runtime delegation, so excluding it keeps the
      // `getRuntimePermissionDelegations` contract (base-session manifest
      // permissions are not represented here) airtight.
      const grant = this.findGrantForOperation(operation, { excludePrimary: true });
      if (!grant) {
        return [];
      }
      if (!grants.includes(grant)) {
        grants.push(grant);
      }
    }
    return grants;
  }

  private runtimeDelegationFromSession(
    delegatedSession: {
      delegationHeader: { Authorization: string };
      delegationCid: string;
    },
    entries: PermissionEntry[],
    spaceId: string,
    session: TinyCloudSession,
    expiresAt: Date,
  ): PortableDelegation {
    const resources = this.delegatedResourcesForEntries(entries, spaceId);
    const primary = resources[0];
    return {
      cid: delegatedSession.delegationCid,
      delegationHeader: delegatedSession.delegationHeader,
      spaceId,
      path: primary.path,
      actions: primary.actions,
      resources,
      disableSubDelegation: false,
      expiry: expiresAt,
      delegateDID: session.verificationMethod,
      ownerAddress: session.address,
      chainId: session.chainId,
      host: this.config.host,
    };
  }

  private runtimeGrantFromDelegation(
    delegation: PortableDelegation,
    session: TinyCloudSession,
  ): RuntimePermissionGrant {
    const operations = this.operationsFromDelegation(delegation);
    return {
      session: {
        delegationHeader: delegation.delegationHeader,
        delegationCid: delegation.cid,
        spaceId: delegation.spaceId,
        verificationMethod: session.verificationMethod,
        jwk: session.jwk,
      },
      delegation,
      operations,
      expiresAt: delegation.expiry,
      provenance: "delegated",
    };
  }

  private installRuntimeGrantFromServiceSession(
    delegation: PortableDelegation,
    session: ServiceSession,
    expiresAt: Date,
  ): void {
    const operations = this.operationsFromDelegation(delegation);
    if (operations.length === 0) {
      return;
    }
    this.runtimePermissionGrants = this.runtimePermissionGrants.filter(
      (grant) =>
        grant.delegation.cid !== delegation.cid &&
        grant.session.delegationCid !== session.delegationCid,
    );
    this.runtimePermissionGrants.push({
      session,
      delegation,
      operations,
      expiresAt,
      provenance: "delegated",
    });
  }

  private delegatedResourcesForEntries(
    entries: PermissionEntry[],
    spaceId: string,
  ): DelegatedResource[] {
    return entries.map((entry) => ({
      service: this.shortServiceName(entry.service),
      space: this.isEncryptionPermissionEntry(entry) ? "encryption" : spaceId,
      path: entry.path,
      actions: [...entry.actions],
      ...(entry.caveats === undefined ? {} : { caveats: cloneRecapCaveats(entry.caveats) }),
    }));
  }

  private operationsFromDelegation(
    delegation: PortableDelegation,
  ): RuntimePermissionOperation[] {
    const resources =
      delegation.resources !== undefined && delegation.resources.length > 0
        ? delegation.resources
        : this.flatDelegationResources(delegation);

    return resources.flatMap((resource) => {
      const service = this.invocationServiceName(resource.service);
      return resource.actions.map((action) => ({
        ...(this.isEncryptionNetworkOperation(service, resource.path)
          ? { resource: resource.path }
          : { spaceId: resource.space }),
        service,
        path: resource.path,
        action,
        caveats: cloneRecapCaveats(resource.caveats),
      }));
    });
  }

  private flatDelegationResources(
    delegation: PortableDelegation,
  ): DelegatedResource[] {
    const byService = new Map<string, string[]>();
    for (const action of delegation.actions) {
      const service = this.shortServiceName(action.split("/")[0]);
      const actions = byService.get(service) ?? [];
      actions.push(action);
      byService.set(service, actions);
    }
    return [...byService.entries()].map(([service, actions]) => ({
      service,
      space: delegation.spaceId,
      path: delegation.path,
      actions,
      ...(delegation.caveats === undefined ? {} : { caveats: cloneRecapCaveats(delegation.caveats) }),
    }));
  }

  /**
   * Build the abilities/rawAbilities maps for a wallet-mode activation
   * sub-delegation from the FULL resource set of a received delegation.
   *
   * Each entry in `delegation.resources[]` is one `(service, space, path,
   * actions)` grant; the flat top-level `path`/`actions` mirror only the
   * first resource. We must reconstruct every grant so the activated
   * session carries all of them (e.g. both `tinycloud.kv/get` and
   * `tinycloud.encryption/decrypt`) — not just the primary one.
   *
   * Encryption resources are raw network URNs (space-independent) and go
   * into `rawAbilities`. All other resources are space-scoped and go into
   * `abilities` keyed by short service name. The activation `prepareSession`
   * call uses a single `spaceId` (`delegation.spaceId`), so every
   * non-encryption resource must target that same space — which is exactly
   * what the multi-resource issuance path enforces. A resource targeting a
   * different space cannot be activated in one call, so we fail loudly
   * rather than silently dropping it.
   *
   * @internal
   */
  private buildActivationAbilities(delegation: PortableDelegation): {
    abilities: Record<string, Record<string, string[]>>;
    rawAbilities: Record<string, string[]>;
  } {
    const resources =
      delegation.resources !== undefined && delegation.resources.length > 0
        ? delegation.resources
        : this.flatDelegationResources(delegation);

    const abilities: Record<string, Record<string, string[]>> = {};
    const rawAbilities: Record<string, string[]> = {};

    const addActions = (target: string[], actions: string[]): void => {
      const seen = new Set(target);
      for (const action of actions) {
        if (!seen.has(action)) {
          target.push(action);
          seen.add(action);
        }
      }
    };

    for (const resource of resources) {
      const service = this.invocationServiceName(resource.service);
      if (this.isEncryptionNetworkOperation(service, resource.path)) {
        rawAbilities[resource.path] ??= [];
        addActions(rawAbilities[resource.path], resource.actions);
        continue;
      }

      if (resource.space !== delegation.spaceId) {
        throw new Error(
          `useDelegation: resource targets space '${resource.space}' but the ` +
            `delegation activates space '${delegation.spaceId}'. Multi-space ` +
            `delegations cannot be activated in a single useDelegation call.`,
        );
      }

      abilities[service] ??= {};
      abilities[service][resource.path] ??= [];
      addActions(abilities[service][resource.path], resource.actions);
    }

    return { abilities, rawAbilities };
  }

  private selectInvocationSession(
    fallback: ServiceSession,
    service: string,
    path: string,
    action: string,
  ): ServiceSession {
    const grant = this.findGrantForOperation({
      spaceId: fallback.spaceId,
      service: this.invocationServiceName(service),
      path,
      action,
    });
    if (!grant) {
      return fallback;
    }
    // "Primary wins" means the caller's own session already authorizes the op:
    // use the PASSED session, not the stored primary `ServiceSession`. The stored
    // primary carries the primary space's `spaceId`, but a multi-space recap can
    // cover scoped ops on OTHER spaces whose fallback session carries the correct
    // target `spaceId`. Returning `grant.session` there would mint the invocation
    // against the wrong space (TC-111 follow-up). Non-primary grants keep their
    // own session.
    return grant.provenance === "primary" ? fallback : grant.session;
  }

  private findGrantForOperations(
    operations: RuntimePermissionOperation[],
    options?: { excludePrimary?: boolean },
  ): RuntimePermissionGrant | undefined {
    if (operations.length === 0) {
      return undefined;
    }
    this.pruneExpiredRuntimePermissionGrants();
    const covering = this.runtimePermissionGrants.filter((grant) => {
      if (options?.excludePrimary && grant.provenance === "primary") {
        return false;
      }
      return operations.every((operation) =>
        grant.operations.some((granted) =>
          this.operationCovers(granted, operation),
        ),
      );
    });
    if (covering.length === 0) {
      return undefined;
    }
    // Provenance ranking: the synthetic primary grant (the base session's own
    // recap) always wins when it covers every op, so a broad bootstrap or
    // delegated grant can never hijack an operation the primary session itself
    // authorizes (TC-111). Otherwise fall back to insertion order — the same
    // semantics as the previous `.find`.
    return covering.find((grant) => grant.provenance === "primary") ?? covering[0];
  }

  private findGrantForOperation(
    operation: RuntimePermissionOperation,
    options?: { excludePrimary?: boolean },
  ): RuntimePermissionGrant | undefined {
    return this.findGrantForOperations([operation], options);
  }

  private pruneExpiredRuntimePermissionGrants(): void {
    const now = Date.now();
    this.runtimePermissionGrants = this.runtimePermissionGrants.filter(
      (grant) => grant.expiresAt.getTime() > now,
    );
  }

  private operationCovers(
    granted: RuntimePermissionOperation,
    requested: RuntimePermissionOperation,
  ): boolean {
    if (granted.service !== requested.service ||
      !this.actionContains(granted.action, requested.action)
    ) {
      return false;
    }

    // A caller that already carries a caveat can only be covered by the exact
    // same signed attenuation.  An uncaveated request is decorated with the
    // grant's caveat immediately before WASM signs it.
    if (requested.caveats !== undefined &&
      !recapCaveatsEqual(granted.caveats, requested.caveats)
    ) {
      return false;
    }

    if (granted.resource !== undefined || requested.resource !== undefined) {
      return granted.resource !== undefined &&
        requested.resource !== undefined &&
        granted.resource === requested.resource &&
        this.pathContains(granted.path, requested.path);
    }

    return granted.spaceId !== undefined &&
      requested.spaceId !== undefined &&
      this.spaceIdsEqual(granted.spaceId, requested.spaceId) &&
      this.pathContains(granted.path, requested.path);
  }

  // Space IDs are `tinycloud:pkh:eip155:<chain>:<0xADDR>:<name>`. The embedded
  // EIP-155 address is case-insensitive, but the CLI canonicalizes it to
  // lowercase when building a space URI while stored runtime delegations keep
  // the EIP-55 checksummed form — so a byte-for-byte compare spuriously rejects
  // an otherwise-valid grant. Lowercase ONLY the `eip155:<chain>:0x<addr>`
  // segment and leave everything else (crucially the case-sensitive space NAME)
  // byte-exact. Mirrors the CLI's `normalizeSpaceForCompare` (OPENKEY_SCOPE_MISMATCH fix).
  private spaceIdsEqual(a: string, b: string): boolean {
    return this.normalizeSpaceAddress(a) === this.normalizeSpaceAddress(b);
  }

  private normalizeSpaceAddress(space: string): string {
    return space.replace(
      /(eip155:\d+:)(0x[0-9a-fA-F]{40})/,
      (_match, prefix: string, addr: string) => prefix + addr.toLowerCase(),
    );
  }

  private actionContains(grantedAction: string, requestedAction: string): boolean {
    if (grantedAction === requestedAction) {
      return true;
    }
    if (grantedAction.endsWith("/*")) {
      const prefix = grantedAction.slice(0, -2);
      return requestedAction.startsWith(`${prefix}/`);
    }
    return false;
  }

  private invocationServiceName(service: string): string {
    return service.startsWith("tinycloud.")
      ? this.shortServiceName(service)
      : service;
  }

  /** Prefer the v2 caveat-preserving parser while retaining old custom WASM. */
  private parseRecapWithCaveats(siwe: string): WasmRecapEntry[] {
    return this.wasmBindings.parseVerifiedRecapFromSiwe?.(siwe)
      ?? this.wasmBindings.parseRecapFromSiwe(siwe);
  }

  private isEncryptionNetworkOperation(service: string, path: string): boolean {
    return service === "encryption" &&
      path.startsWith("urn:tinycloud:encryption:");
  }

  private operationFromInvokeAnyEntry(entry: {
    spaceId?: string;
    resource?: string;
    service: string;
    path: string;
    action: string;
    caveats?: Record<string, unknown>[];
  }): RuntimePermissionOperation | undefined {
    const service = this.invocationServiceName(entry.service);
    if (typeof entry.resource === "string") {
      return {
        resource: entry.resource,
        service,
        path: entry.path,
        action: entry.action,
        ...(entry.caveats === undefined ? {} : { caveats: cloneRecapCaveats(entry.caveats) }),
      };
    }
    if (this.isEncryptionNetworkOperation(service, entry.path)) {
      return {
        resource: entry.path,
        service,
        path: entry.path,
        action: entry.action,
        ...(entry.caveats === undefined ? {} : { caveats: cloneRecapCaveats(entry.caveats) }),
      };
    }
    if (typeof entry.spaceId === "string") {
      return {
        spaceId: entry.spaceId,
        service,
        path: entry.path,
        action: entry.action,
        ...(entry.caveats === undefined ? {} : { caveats: cloneRecapCaveats(entry.caveats) }),
      };
    }
    return undefined;
  }

  private pathContains(grantedPath: string, requestedPath: string): boolean {
    if (grantedPath === "" || grantedPath === "/") {
      return true;
    }
    if (grantedPath.endsWith("/**")) {
      return requestedPath.startsWith(grantedPath.slice(0, -3));
    }
    if (grantedPath.endsWith("/*")) {
      const prefix = grantedPath.slice(0, -2);
      if (!requestedPath.startsWith(prefix)) {
        return false;
      }
      const remainder = requestedPath.slice(prefix.length);
      return !remainder.includes("/") || remainder === "/";
    }
    if (grantedPath.endsWith("/")) {
      return requestedPath.startsWith(grantedPath);
    }
    return grantedPath === requestedPath;
  }

  /**
   * Issue a delegation via the legacy wallet-signed SIWE path for a single
   * {@link PermissionEntry}. Shares the implementation with the public
   * `createDelegation` method via {@link createDelegationWalletPath} so
   * both entry points hit exactly the same SIWE / signer / public-space
   * logic without mutual recursion.
   *
   * @internal
   */
  private async createDelegationLegacyWalletPath(
    delegateDID: string,
    entry: PermissionEntry,
    expirationTime: Date,
  ): Promise<PortableDelegation> {
    const session = this.auth?.tinyCloudSession;
    const spaceIdOverride =
      session === undefined || entry.space === "default"
        ? undefined
        : this.resolvePermissionSpace(entry.space, session);
    return this.createDelegationWalletPath({
      path: entry.path,
      actions: entry.actions,
      delegateDID,
      includePublicSpace: true,
      expiryMs: Math.max(0, expirationTime.getTime() - Date.now()),
      spaceIdOverride,
    });
  }

  /**
   * Create a delegation from this user to another user.
   *
   * The delegation grants the recipient access to a specific path and actions
   * within this user's space.
   *
   * @param params - Delegation parameters
   * @returns A portable delegation that can be sent to the recipient
   */
  async createDelegation(params: {
    /** Path within the space to delegate access to */
    path: string;
    /** Actions to allow (e.g., ["tinycloud.kv/get", "tinycloud.kv/put"]) */
    actions: string[];
    /** DID of the recipient (from their TinyCloudNode.did) */
    delegateDID: string;
    /** Whether to prevent the recipient from creating sub-delegations (default: false) */
    disableSubDelegation?: boolean;
    /** Expiration time in milliseconds from now (default: 1 hour) */
    expiryMs?: number;
    /** Override space ID (for creating delegations to non-primary spaces like public) */
    spaceIdOverride?: string;
    /** Include a companion delegation for the user's public space (default: true) */
    includePublicSpace?: boolean;
  }): Promise<PortableDelegation> {
    // Legacy compatibility shim.
    //
    // Route through delegateTo so that callers whose requested capabilities
    // are a subset of their current session get the session-key UCAN path
    // (no wallet prompt). Fall back to the legacy wallet-sign path on
    // PermissionNotInManifestError, preserving today's behaviour for
    // callers that request scope outside their session.
    //
    // SessionExpiredError propagates — an expired session can't be fixed
    // by re-signing the SIWE, the caller needs to run signIn() again.
    if (!this.signer) {
      throw new Error("Cannot createDelegation() in session-only mode. Requires wallet mode.");
    }
    if (!this.auth?.tinyCloudSession) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    // Resolve ENS names to PKH DIDs up front so both paths see the resolved
    // DID. The wallet path mutates params further below; we do it here so
    // the fast path (delegateTo) also picks up the resolved DID.
    let resolvedDelegateDID = params.delegateDID;
    if (resolvedDelegateDID.endsWith('.eth') && this.config.ensResolver) {
      const address = await this.config.ensResolver.resolveAddress(resolvedDelegateDID);
      if (!address) throw new Error(`Could not resolve ENS name: ${resolvedDelegateDID}`);
      resolvedDelegateDID = pkhDid(address, 1);
    }

    // Legacy params lump multiple services' actions under one path. We
    // now emit ONE multi-resource UCAN for any number of entries via
    // the fast path, so there's no longer a "single-entry only" gate
    // here — the fast path handles N entries and returns a single
    // PortableDelegation whose `.resources` describes the full set.
    //
    // Fall back to the wallet path when the capabilities aren't
    // derivable from the current session (PermissionNotInManifestError)
    // so legacy callers requesting scope outside their session continue
    // to see a wallet prompt, matching today's behaviour.
    const entries = legacyParamsToPermissionEntries(
      params.actions,
      params.path,
      params.spaceIdOverride,
    );
    try {
      const result = await this.delegateTo(
        resolvedDelegateDID,
        entries,
        params.expiryMs !== undefined ? { expiry: params.expiryMs } : undefined,
      );
      return result.delegation;
    } catch (err) {
      if (err instanceof PermissionNotInManifestError) {
        // Expected — fall through to the wallet path below. Legacy
        // callers that request scope outside their current session
        // continue to see a wallet prompt, matching today's behaviour.
      } else {
        // SessionExpiredError and any other error class must propagate.
        // An expired session can't be rescued by re-signing the SIWE
        // here — the caller needs to run signIn() again.
        throw err;
      }
    }

    // Legacy wallet-signed SIWE path — same implementation as before the
    // delegateTo refactor. Callers that request scope outside their
    // current session land here and see the familiar wallet prompt.
    return this.createDelegationWalletPath({
      ...params,
      delegateDID: resolvedDelegateDID,
    });
  }

  /**
   * Legacy wallet-signed SIWE delegation path. Lifted from the original
   * `createDelegation` body verbatim so both the legacy public method and
   * `delegateTo({ forceWalletSign: true })` hit the same code.
   *
   * @internal
   */
  private async createDelegationWalletPath(params: {
    path: string;
    actions: string[];
    delegateDID: string;
    disableSubDelegation?: boolean;
    expiryMs?: number;
    spaceIdOverride?: string;
    includePublicSpace?: boolean;
  }): Promise<PortableDelegation> {
    if (!this.signer) {
      throw new Error("Cannot createDelegation() in session-only mode. Requires wallet mode.");
    }
    const session = this.auth?.tinyCloudSession;
    if (!session) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    // Build abilities for the delegation
    const abilities: Record<string, Record<string, string[]>> = {};
    const kvActions = params.actions.filter(a => a.startsWith("tinycloud.kv/"));
    const sqlActions = params.actions.filter(a => a.startsWith("tinycloud.sql/"));
    const duckdbActions = params.actions.filter(a => a.startsWith("tinycloud.duckdb/"));
    if (kvActions.length > 0) {
      abilities.kv = { [params.path]: kvActions };
    }
    if (sqlActions.length > 0) {
      abilities.sql = { [params.path]: sqlActions };
    }
    if (duckdbActions.length > 0) {
      abilities.duckdb = { [params.path]: duckdbActions };
    }

    const now = new Date();
    const expiryMs = params.expiryMs ?? 60 * 60 * 1000; // Default 1 hour
    const expirationTime = new Date(now.getTime() + expiryMs);

    // Prepare the delegation session with:
    // - delegateUri: target the recipient's DID directly (for user-to-user delegation)
    // - parents: reference our session CID for chain validation
    const prepared = this.wasmBindings.prepareSession({
      abilities,
      address: this.wasmBindings.ensureEip55(session.address),
      chainId: session.chainId,
      domain: this.siweDomain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId: params.spaceIdOverride ?? session.spaceId,
      delegateUri: params.delegateDID,
      parents: [session.delegationCid],
    });

    // Sign the SIWE message with this user's signer
    const signature = await this.signer.signMessage(prepared.siwe);

    // Complete the session setup
    const delegationSession = this.wasmBindings.completeSessionSetup({
      ...prepared,
      signature,
    });

    // Activate the delegation with the server
    const activateResult = await activateSessionWithHost(
      this.config.host!,
      delegationSession.delegationHeader
    );

    if (!activateResult.success) {
      throw new Error(`Failed to activate delegation: ${activateResult.error}`);
    }

    const result: PortableDelegation = {
      cid: delegationSession.delegationCid,
      delegationHeader: delegationSession.delegationHeader,
      spaceId: params.spaceIdOverride ?? session.spaceId,
      path: params.path,
      actions: params.actions,
      disableSubDelegation: params.disableSubDelegation ?? false,
      expiry: expirationTime,
      delegateDID: params.delegateDID,
      ownerAddress: session.address,
      chainId: session.chainId,
      host: this.config.host,
    };

    // Auto-create public-space delegation for vault key publishing
    const hasKvActions = params.actions.some(a => a.startsWith("tinycloud.kv/"));
    if (hasKvActions && params.includePublicSpace !== false) {
      const publicSpaceId = makePublicSpaceId(
        this.wasmBindings.ensureEip55(session.address), session.chainId
      );
      const publicAbilities: Record<string, Record<string, string[]>> = {
        kv: { "": [KV.GET, KV.PUT, KV.METADATA] },
      };
      const publicPrepared = this.wasmBindings.prepareSession({
        abilities: publicAbilities,
        address: this.wasmBindings.ensureEip55(session.address),
        chainId: session.chainId,
        domain: this.siweDomain,
        issuedAt: now.toISOString(),
        expirationTime: expirationTime.toISOString(),
        spaceId: publicSpaceId,
        delegateUri: params.delegateDID,
        parents: [session.delegationCid],
      });
      const publicSignature = await this.signer.signMessage(publicPrepared.siwe);
      const publicSession = this.wasmBindings.completeSessionSetup({
        ...publicPrepared,
        signature: publicSignature,
      });

      const publicActivateResult = await activateSessionWithHost(
        this.config.host!,
        publicSession.delegationHeader
      );

      if (publicActivateResult.success) {
        result.publicDelegation = {
          cid: publicSession.delegationCid,
          delegationHeader: publicSession.delegationHeader,
          spaceId: publicSpaceId,
          path: "",
          actions: [KV.GET, KV.PUT, KV.METADATA],
          disableSubDelegation: params.disableSubDelegation ?? false,
          expiry: expirationTime,
          delegateDID: params.delegateDID,
          ownerAddress: session.address,
          chainId: session.chainId,
          host: this.config.host,
        };
      }
    }

    return result;
  }

  /**
   * Use a delegation received from another user.
   *
   * This creates a new session key for this user that chains from the
   * received delegation, allowing operations on the delegator's space.
   *
   * Works in both modes:
   * - **Wallet mode**: Creates a SIWE sub-delegation from PKH to session key
   * - **Session-only mode**: Uses the delegation directly (must target session key DID)
   *
   * @param delegation - The PortableDelegation to use (from createDelegation or transport)
   * @returns A DelegatedAccess instance for performing operations
   */
  async useDelegation(delegation: PortableDelegation): Promise<DelegatedAccess> {
    const delegationHeader = delegation.delegationHeader;

    // Use the host from the delegation if provided, otherwise fall back to config
    const targetHost = delegation.host ?? this.config.host!;

    // Session-only mode: use the delegation directly
    // The delegation must target this user's session key DID
    if (this.isSessionOnly) {
      // Verify the delegation targets our session key DID
      const myDid = this.did; // In session-only mode, this is the session key DID
      if (!didPrincipalMatches(delegation.delegateDID, myDid)) {
        throw new Error(
          `Delegation targets ${delegation.delegateDID} but this user's DID is ${myDid}. ` +
          `The delegation must target this user's DID.`
        );
      }

      // Create a session using the delegation directly
      // In session-only mode, we use the received delegation as-is
      const session: TinyCloudSession = {
        address: delegation.ownerAddress,
        chainId: delegation.chainId,
        sessionKey: JSON.stringify(this.sessionKeyJwk),
        spaceId: delegation.spaceId,
        delegationCid: delegation.cid,
        delegationHeader,
        verificationMethod: this.sessionDid,
        jwk: this.sessionKeyJwk as unknown as JWK,
        siwe: "", // Not used in session-only mode
        signature: "", // Not used in session-only mode
      };

      // Track received delegation in registry
      this.trackReceivedDelegation(delegation, this.sessionKeyJwk as unknown as JWK);
      this.installRuntimeGrantFromServiceSession(
        delegation,
        {
          delegationHeader: session.delegationHeader,
          delegationCid: session.delegationCid,
          spaceId: session.spaceId,
          verificationMethod: session.verificationMethod,
          jwk: session.jwk,
        },
        delegation.expiry,
      );

      return new DelegatedAccess(
        session,
        delegation,
        targetHost,
        this.wasmBindings.invoke,
        this.wasmBindings.invokeAny,
        this.config.telemetry,
      );
    }

    // Wallet mode: create a SIWE sub-delegation
    const mySession = this.auth?.tinyCloudSession;
    if (!mySession) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    // Use our existing session key - the delegation targets our DID from signIn
    // We must use the same key that the delegation was created for
    const jwk = mySession.jwk;

    // Build the activation abilities from the FULL resource set, not just
    // the flat top-level path/actions. A multi-resource delegation (e.g.
    // [{kv get vault/secrets/X}, {encryption decrypt <networkId>}]) carries
    // every grant in `delegation.resources[]`; the flat `path`/`actions`
    // mirror only the first resource. Building from the flat fields alone
    // silently drops every other resource from the activated session.
    const { abilities, rawAbilities } = this.buildActivationAbilities(delegation);

    const now = new Date();
    // Use delegation expiry or 1 hour, whichever is sooner
    const maxExpiry = new Date(now.getTime() + 60 * 60 * 1000);
    const expirationTime = delegation.expiry < maxExpiry ? delegation.expiry : maxExpiry;

    // Prepare the session with:
    // - THIS user's address (we are the invoker)
    // - The delegation owner's space (where we're accessing data)
    // - Our existing session key (must match the DID the delegation targets)
    // - Parent reference to the received delegation
    const prepared = this.wasmBindings.prepareSession({
      abilities,
      address: this.wasmBindings.ensureEip55(mySession.address),
      chainId: mySession.chainId,
      domain: this.siweDomain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId: delegation.spaceId,
      jwk,
      parents: [delegation.cid],
      ...(Object.keys(rawAbilities).length > 0 ? { rawAbilities } : {}),
    });

    // Sign with THIS user's signer
    const signature = await this.signer!.signMessage(prepared.siwe);

    // Complete the session setup
    const invokerSession = this.wasmBindings.completeSessionSetup({
      ...prepared,
      signature,
    });

    // Activate with server
    const activateResult = await activateSessionWithHost(
      targetHost,
      invokerSession.delegationHeader
    );

    if (!activateResult.success) {
      throw new Error(`Failed to activate delegated session: ${activateResult.error}`);
    }

    // Create TinyCloudSession for the delegated access
    const session: TinyCloudSession = {
      address: mySession.address,
      chainId: mySession.chainId,
      sessionKey: mySession.sessionKey,
      spaceId: delegation.spaceId,
      delegationCid: invokerSession.delegationCid,
      delegationHeader: invokerSession.delegationHeader,
      verificationMethod: mySession.verificationMethod,
      jwk,
      siwe: prepared.siwe,
      signature,
    };

    // Track received delegation in registry
    this.trackReceivedDelegation(delegation, jwk as unknown as JWK);
    this.installRuntimeGrantFromServiceSession(
      delegation,
      {
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: session.spaceId,
        verificationMethod: session.verificationMethod,
        jwk: session.jwk,
      },
      expirationTime,
    );

    return new DelegatedAccess(
      session,
      delegation,
      targetHost,
      this.wasmBindings.invoke,
      this.wasmBindings.invokeAny,
      this.config.telemetry,
    );
  }

  /**
   * Create a sub-delegation from a received delegation.
   *
   * This allows further delegating access that was received from another user,
   * if the original delegation allows sub-delegation.
   *
   * @param parentDelegation - The delegation received from another user
   * @param params - Sub-delegation parameters (must be within parent's scope)
   * @returns A portable delegation for the sub-delegate
   */
  async createSubDelegation(
    parentDelegation: PortableDelegation,
    params: {
      /** Path within the delegated path to sub-delegate */
      path: string;
      /** Actions to allow (must be subset of parent's actions) */
      actions: string[];
      /** DID of the recipient */
      delegateDID: string;
      /** Whether to prevent the recipient from creating further sub-delegations */
      disableSubDelegation?: boolean;
      /** Expiration time in milliseconds from now (must be before parent's expiry) */
      expiryMs?: number;
    }
  ): Promise<PortableDelegation> {
    this.assertPortableDelegationCaveatsPreservable(parentDelegation);

    if (!this.signer) {
      throw new Error("Cannot createSubDelegation() in session-only mode. Requires wallet mode.");
    }
    if (!this._address) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    // Validate sub-delegation is allowed
    if (parentDelegation.disableSubDelegation) {
      throw new Error("Parent delegation does not allow sub-delegation");
    }

    // Validate path is within parent's path
    if (!params.path.startsWith(parentDelegation.path)) {
      throw new Error(
        `Sub-delegation path "${params.path}" must be within parent path "${parentDelegation.path}"`
      );
    }

    // Validate actions are subset of parent's actions
    const parentActions = new Set(parentDelegation.actions);
    for (const action of params.actions) {
      if (!parentActions.has(action)) {
        throw new Error(
          `Sub-delegation action "${action}" is not in parent's actions: ${parentDelegation.actions.join(", ")}`
        );
      }
    }

    // Calculate expiry - cap at parent's expiry
    const now = new Date();
    const expiryMs = params.expiryMs ?? 60 * 60 * 1000;
    const requestedExpiry = new Date(now.getTime() + expiryMs);
    // Sub-delegation cannot outlive parent, so cap at parent's expiry
    const actualExpiry =
      requestedExpiry > parentDelegation.expiry ? parentDelegation.expiry : requestedExpiry;

    // Build abilities for the sub-delegation
    const abilities: Record<string, Record<string, string[]>> = {};
    const kvActions = params.actions.filter(a => a.startsWith("tinycloud.kv/"));
    const sqlActions = params.actions.filter(a => a.startsWith("tinycloud.sql/"));
    const duckdbActions = params.actions.filter(a => a.startsWith("tinycloud.duckdb/"));
    if (kvActions.length > 0) {
      abilities.kv = { [params.path]: kvActions };
    }
    if (sqlActions.length > 0) {
      abilities.sql = { [params.path]: sqlActions };
    }
    if (duckdbActions.length > 0) {
      abilities.duckdb = { [params.path]: duckdbActions };
    }

    // Use parent's host or fall back to config
    const targetHost = parentDelegation.host ?? this.config.host!;

    // Prepare the sub-delegation session
    // Uses THIS user's address (who received the delegation and is now sub-delegating)
    // Targets the recipient's PKH DID (delegateUri)
    // References the parent delegation as the chain
    const prepared = this.wasmBindings.prepareSession({
      abilities,
      address: this.wasmBindings.ensureEip55(this._address),
      chainId: this._chainId,
      domain: this.siweDomain,
      issuedAt: now.toISOString(),
      expirationTime: actualExpiry.toISOString(),
      spaceId: parentDelegation.spaceId,
      delegateUri: params.delegateDID,
      parents: [parentDelegation.cid],
    });

    // Sign with THIS user's signer
    const signature = await this.signer.signMessage(prepared.siwe);

    // Complete the session setup
    const subDelegationSession = this.wasmBindings.completeSessionSetup({
      ...prepared,
      signature,
    });

    // Activate the sub-delegation with the server
    const activateResult = await activateSessionWithHost(
      targetHost,
      subDelegationSession.delegationHeader
    );

    if (!activateResult.success) {
      throw new Error(`Failed to activate sub-delegation: ${activateResult.error}`);
    }

    // Return the portable sub-delegation
    return {
      cid: subDelegationSession.delegationCid,
      delegationHeader: subDelegationSession.delegationHeader,
      spaceId: parentDelegation.spaceId,
      path: params.path,
      actions: params.actions,
      disableSubDelegation: params.disableSubDelegation ?? false,
      expiry: actualExpiry,
      delegateDID: params.delegateDID,
      ownerAddress: parentDelegation.ownerAddress!,
      chainId: parentDelegation.chainId!,
      host: targetHost,
    };
  }
}
