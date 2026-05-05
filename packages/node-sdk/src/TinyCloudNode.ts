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
  SecretsService,
  ISecretsService,
  IHooksService,
  createVaultCrypto,
  ServiceSession,
  ServiceContext,
  ISessionStorage,
  ISigner,
  type InvokeAnyFunction,
  type InvokeFunction,
  INotificationHandler,
  SilentNotificationHandler,
  IENSResolver,
  IWasmBindings,
  ISessionManager,
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
  type ComposedManifestRequest,
  type ResolvedDelegate,
  // Capability-chain delegation
  type PermissionEntry,
  PermissionNotInManifestError,
  SessionExpiredError,
  expandPermissionEntries as expandPermissionEntriesCore,
  isCapabilitySubset,
  parseRecapCapabilities,
  // Manifest-driven sign-in
  type Manifest,
  type AbilitiesMap,
  resourceCapabilitiesToAbilitiesMap,
  SERVICE_LONG_TO_SHORT,
} from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
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

/**
 * Configuration for TinyCloudNode.
 * All fields are optional - TinyCloudNode can work with zero configuration.
 */
export interface TinyCloudNodeConfig {
  /** Hex-encoded private key (with or without 0x prefix). Optional - only needed for wallet mode and signIn() */
  privateKey?: string;
  /** Custom signer implementation. If provided, takes precedence over privateKey. */
  signer?: ISigner;
  /** Explicit TinyCloud server URL. When omitted, signIn resolves the user's host. */
  host?: string;
  /** TinyCloud location registry URL. Default: https://registry.tinycloud.xyz. */
  tinycloudRegistryUrl?: string | null;
  /** Fallback TinyCloud hosts. Default: hosted TinyCloud node. */
  tinycloudFallbackHosts?: string[] | null;
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
  spaceId: string;
  service: string;
  path: string;
  action: string;
}

interface RuntimePermissionGrant {
  session: ServiceSession;
  delegation: PortableDelegation;
  operations: RuntimePermissionOperation[];
  expiresAt: Date;
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
  private _serviceContext?: ServiceContext;
  private _kv?: KVService;
  private _sql?: SQLService;
  private _duckdb?: DuckDbService;
  private _hooks?: HooksService;
  private _vault?: DataVaultService;
  private _baseSecrets?: ISecretsService;
  private _secrets?: ISecretsService;
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
    return this.wasmBindings.invoke(
      this.selectInvocationSession(session, service, path, action),
      service,
      path,
      action,
      facts,
    );
  };

  private readonly invokeAnyWithRuntimePermissions: InvokeAnyFunction = (
    session,
    entries,
    facts,
  ) => {
    if (!this.wasmBindings.invokeAny) {
      throw new Error("WASM binding does not support invokeAny");
    }
    const grant = this.findGrantForOperations(
      entries.map((entry) => ({
        spaceId: entry.spaceId,
        service: this.invocationServiceName(entry.service),
        path: entry.path,
        action: entry.action,
      })),
    );
    return this.wasmBindings.invokeAny(grant?.session ?? session, entries, facts);
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
    this._sharingService = new SharingService({
      hosts: [this.config.host!],
      // session: undefined - not needed for receive()
      invoke: this.invokeWithRuntimePermissions,
      fetch: globalThis.fetch.bind(globalThis),
      keyProvider: this._keyProvider,
      registry: this._capabilityRegistry,
      // delegationManager: undefined - not needed for receive()
      createKVService: (config) => {
        // Use pathPrefix as the KV service prefix for sharing links
        // Strip trailing slash to match DelegatedAccess behavior
        const prefix = config.pathPrefix?.replace(/\/$/, '');
        const kvService = new KVService({ prefix });
        // Create a new service context for the KV service
        const kvContext = new ServiceContext({
          invoke: config.invoke,
          fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
          hosts: config.hosts,
        });
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
    this.auth = new NodeUserAuthorization({
      signer: this.signer!,
      signStrategy: { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionStorage: config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: config.prefix,
      sessionExpirationMs: config.sessionExpirationMs ?? 60 * 60 * 1000,
      tinycloudHosts: this.explicitHost ? [this.explicitHost] : undefined,
      tinycloudRegistryUrl: config.tinycloudRegistryUrl,
      tinycloudFallbackHosts: config.tinycloudFallbackHosts,
      autoCreateSpace: config.autoCreateSpace,
      enablePublicSpace: config.enablePublicSpace ?? true,
      spaceCreationHandler: config.spaceCreationHandler,
      nonce: config.nonce,
      siweConfig: config.siweConfig,
      manifest: config.manifest,
      capabilityRequest: config.capabilityRequest,
      includeAccountRegistryPermissions: config.includeAccountRegistryPermissions,
    });

    this.tc = new TinyCloud(this.auth, {
      invokeAny: this.invokeAnyWithRuntimePermissions,
    });
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
      return `did:pkh:eip155:${this._chainId}:${this._address}`;
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
   * Get the Ethereum address for this user.
   */
  get address(): string | undefined {
    return this._address;
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
   * Get the current TinyCloud session.
   * Available after signIn().
   */
  get session(): TinyCloudSession | undefined {
    return this.auth?.tinyCloudSession;
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

    this._address = await this.signer.getAddress();
    this._chainId = await this.signer.getChainId();

    // Reset services so they get recreated with new session
    this._kv = undefined;
    this._sql = undefined;
    this._duckdb = undefined;
    this._hooks = undefined;
    this._vault = undefined;
    this._baseSecrets = undefined;
    this._secrets = undefined;
    this._spaceService = undefined;
    this._serviceContext = undefined;
    this.runtimePermissionGrants = [];

    await this.tc.signIn(options);
    this.syncResolvedHostFromAuth();

    // Initialize service context with session
    this.initializeServices();

    await this.writeManifestRegistryRecords();

    this.notificationHandler.success("Successfully signed in");
  }

  private ownedSpaceId(name: string): string {
    if (!this._address) {
      throw new Error("Cannot resolve owned space before sign-in");
    }
    return this.wasmBindings.makeSpaceId(this._address, this._chainId, name);
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
    await this.ensureOwnedSpaceHosted(accountSpaceId);

    const accountKV = this.spaces.get(accountSpaceId).kv;
    for (const record of request.registryRecords) {
      const result = await accountKV.put(record.key, {
        app_id: record.app_id,
        manifests: record.manifests,
        updated_at: new Date().toISOString(),
      });
      if (!result.ok) {
        throw new Error(
          `Failed to write manifest registry record ${record.key}: ${result.error.message}`,
        );
      }
    }
  }

  private async ensureOwnedSpaceHosted(spaceId: string): Promise<void> {
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
    jwk: object;
    verificationMethod: string;
    address?: string;
    chainId?: number;
  }): Promise<void> {
    // Ensure WASM is ready (critical for browser where WASM loads asynchronously)
    await this.wasmBindings.ensureInitialized?.();

    // Reset services so they get recreated with new session
    this._kv = undefined;
    this._sql = undefined;
    this._duckdb = undefined;
    this._hooks = undefined;
    this._vault = undefined;
    this._baseSecrets = undefined;
    this._secrets = undefined;
    this._spaceService = undefined;
    this._serviceContext = undefined;
    this.runtimePermissionGrants = [];

    if (sessionData.address) {
      this._address = sessionData.address;
    }
    if (sessionData.chainId) {
      this._chainId = sessionData.chainId;
    }

    // Create service context
    this._serviceContext = new ServiceContext({
      invoke: this.invokeWithRuntimePermissions,
      invokeAny: this.invokeAnyWithRuntimePermissions,
      fetch: globalThis.fetch.bind(globalThis),
      hosts: [this.config.host!],
    });

    // Create and register KV service
    this._kv = new KVService({});
    this._kv.initialize(this._serviceContext);
    this._serviceContext.registerService('kv', this._kv);

    // Create and register SQL service
    this._sql = new SQLService({});
    this._sql.initialize(this._serviceContext);
    this._serviceContext.registerService('sql', this._sql);

    // Create and register DuckDB service
    this._duckdb = new DuckDbService({});
    this._duckdb.initialize(this._serviceContext);
    this._serviceContext.registerService('duckdb', this._duckdb);

    this._hooks = new HooksService({});
    this._hooks.initialize(this._serviceContext);
    this._serviceContext.registerService('hooks', this._hooks);

    // Set session on context
    const serviceSession: ServiceSession = {
      delegationHeader: sessionData.delegationHeader,
      delegationCid: sessionData.delegationCid,
      spaceId: sessionData.spaceId,
      verificationMethod: sessionData.verificationMethod,
      jwk: sessionData.jwk,
    };
    this._serviceContext.setSession(serviceSession);

    // Create and register Vault service (matches initializeServices behavior)
    this._vault = this.createVaultService(sessionData.spaceId, this._kv!);
    this._vault.initialize(this._serviceContext);
    this._serviceContext.registerService('vault', this._vault);

    // Initialize v2 services
    this.initializeV2Services(serviceSession);
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
    this.auth = new NodeUserAuthorization({
      signer: this.signer,
      signStrategy: { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionStorage: options?.sessionStorage ?? this.config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: prefix,
      sessionExpirationMs: this.config.sessionExpirationMs ?? 60 * 60 * 1000,
      tinycloudHosts: this.explicitHost ? [this.explicitHost] : undefined,
      tinycloudRegistryUrl: this.config.tinycloudRegistryUrl,
      tinycloudFallbackHosts: this.config.tinycloudFallbackHosts,
      autoCreateSpace: this.config.autoCreateSpace,
      enablePublicSpace: this.config.enablePublicSpace ?? true,
      spaceCreationHandler: this.config.spaceCreationHandler,
      nonce: this.config.nonce,
      siweConfig: this.config.siweConfig,
      manifest: this.config.manifest,
      capabilityRequest: this.config.capabilityRequest,
      includeAccountRegistryPermissions: this.config.includeAccountRegistryPermissions,
    });

    // Create TinyCloud instance
    this.tc = new TinyCloud(this.auth, {
      invokeAny: this.invokeAnyWithRuntimePermissions,
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

    this.auth = new NodeUserAuthorization({
      signer: this.signer,
      signStrategy: { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionStorage: options?.sessionStorage ?? this.config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: prefix,
      sessionExpirationMs: this.config.sessionExpirationMs ?? 60 * 60 * 1000,
      tinycloudHosts: this.explicitHost ? [this.explicitHost] : undefined,
      tinycloudRegistryUrl: this.config.tinycloudRegistryUrl,
      tinycloudFallbackHosts: this.config.tinycloudFallbackHosts,
      autoCreateSpace: this.config.autoCreateSpace,
      enablePublicSpace: this.config.enablePublicSpace ?? true,
      spaceCreationHandler: this.config.spaceCreationHandler,
      nonce: this.config.nonce,
      siweConfig: this.config.siweConfig,
      manifest: this.config.manifest,
      capabilityRequest: this.config.capabilityRequest,
      includeAccountRegistryPermissions: this.config.includeAccountRegistryPermissions,
    });

    this.tc = new TinyCloud(this.auth, {
      invokeAny: this.invokeAnyWithRuntimePermissions,
    });
    this.config.prefix = prefix;
  }

  /**
   * Initialize the service context and KV service after sign-in.
   * @internal
   */
  private initializeServices(): void {
    const session = this.auth?.tinyCloudSession;
    if (!session) {
      return;
    }

    // Initialize TinyCloud core services (needed for publicKV, ensurePublicSpace)
    this.tc!.initializeServices(this.invokeWithRuntimePermissions, [this.config.host!]);

    // Create service context
    this._serviceContext = new ServiceContext({
      invoke: this.invokeWithRuntimePermissions,
      invokeAny: this.invokeAnyWithRuntimePermissions,
      fetch: globalThis.fetch.bind(globalThis),
      hosts: [this.config.host!],
    });

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
      const spaceScopedContext = new ServiceContext({
        invoke: this._serviceContext.invoke,
        fetch: this._serviceContext.fetch,
        hosts: this._serviceContext.hosts,
      });
      const session = this._serviceContext.session;
      if (session) {
        spaceScopedContext.setSession({ ...session, spaceId });
      }
      kvService.initialize(spaceScopedContext);
    }
    return kvService;
  }

  private createVaultService(spaceId: string, kv: IKVService): DataVaultService {
    const wasm = this.wasmBindings;
    const vaultCrypto = createVaultCrypto({
      vault_encrypt: wasm.vault_encrypt, vault_decrypt: wasm.vault_decrypt, vault_derive_key: wasm.vault_derive_key,
      vault_x25519_from_seed: wasm.vault_x25519_from_seed, vault_x25519_dh: wasm.vault_x25519_dh,
      vault_random_bytes: wasm.vault_random_bytes, vault_sha256: wasm.vault_sha256,
    });
    const self = this;
    return new DataVaultService({
      spaceId,
      crypto: vaultCrypto,
      tc: {
        kv,
        ensurePublicSpace: async () => {
          try {
            await self.ensurePublicSpace();
            return { ok: true as const, data: undefined };
          } catch (error) {
            return { ok: false as const, error: { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : String(error), service: "vault" } };
          }
        },
        get publicKV() { return self._publicKV ?? self.tc!.publicKV; },
        readPublicSpace: <T>(host: string, targetSpaceId: string, key: string) =>
          TinyCloud.readPublicSpace<T>(host, targetSpaceId, key),
        makePublicSpaceId: TinyCloud.makePublicSpaceId,
        did: this.did,
        address: this._address ?? "",
        chainId: this._chainId,
        hosts: [this.config.host!],
      },
    });
  }

  /**
   * Initialize the v2 delegation system services.
   * @internal
   */
  private initializeV2Services(serviceSession: ServiceSession): void {
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
        actions: [
          "tinycloud.kv/put",
          "tinycloud.kv/get",
          "tinycloud.kv/del",
          "tinycloud.kv/list",
          "tinycloud.kv/metadata",
          "tinycloud.sql/read",
          "tinycloud.sql/write",
          "tinycloud.sql/admin",
          "tinycloud.sql/*",
          "tinycloud.duckdb/read",
          "tinycloud.duckdb/write",
          "tinycloud.duckdb/admin",
          "tinycloud.duckdb/describe",
          "tinycloud.duckdb/export",
          "tinycloud.duckdb/import",
          "tinycloud.duckdb/*",
        ],
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
            actions: [
              "tinycloud.kv/put",
              "tinycloud.kv/get",
              "tinycloud.kv/del",
              "tinycloud.kv/list",
              "tinycloud.kv/metadata",
              "tinycloud.sql/read",
              "tinycloud.sql/write",
              "tinycloud.sql/admin",
              "tinycloud.sql/*",
              "tinycloud.duckdb/read",
              "tinycloud.duckdb/write",
              "tinycloud.duckdb/admin",
              "tinycloud.duckdb/describe",
              "tinycloud.duckdb/export",
              "tinycloud.duckdb/import",
              "tinycloud.duckdb/*",
            ],
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
      session: serviceSession,
      invoke: this.invokeWithRuntimePermissions,
      fetch: globalThis.fetch.bind(globalThis),
    });

    // Initialize SpaceService
    this._spaceService = new SpaceService({
      hosts: [this.config.host!],
      session: serviceSession,
      invoke: this.wasmBindings.invoke,
      fetch: globalThis.fetch.bind(globalThis),
      capabilityRegistry: this._capabilityRegistry,
      userDid: this.did,
      createKVService: (spaceId: string) => {
        return this.createSpaceScopedKVService(spaceId);
      },
      createVaultService: (spaceId: string) => {
        const kvService = this.createSpaceScopedKVService(spaceId);
        const vaultService = this.createVaultService(spaceId, kvService);
        if (this._serviceContext) {
          vaultService.initialize(this._serviceContext);
        }
        return vaultService;
      },
      // Enable space.delegations.create() via SIWE-based delegation
      createDelegation: async (params) => {
        try {
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
    });

    // Update SharingService with full capabilities (session + createDelegation)
    // SharingService was initialized in constructor for receive-only access
    this._sharingService.updateConfig({
      session: serviceSession,
      delegationManager: this._delegationManager,
      sessionExpiry: this.getSessionExpiry(),
      // WASM-based delegation creation (preferred - no server roundtrip)
      createDelegationWasm: (params) => this.createDelegationWrapper(params),
      // Root delegation for long-lived share links (bypasses session expiry)
      // In node-sdk we have direct signer access, so no popup needed
      onRootDelegationNeeded: this.signer
        ? async (params) => this.createRootDelegationForSharing(params)
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
    const expirationMs = this.config.sessionExpirationMs ?? 60 * 60 * 1000;
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
      verificationMethod: params.session.verificationMethod,
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
  private async createRootDelegationForSharing(params: {
    shareKeyDID: string;
    spaceId: string;
    path: string;
    actions: string[];
    requestedExpiry: Date;
  }): Promise<Delegation | undefined> {
    if (!this.signer) {
      return undefined;
    }

    const session = this.auth?.tinyCloudSession;
    if (!session) {
      return undefined;
    }

    try {
      const host = this.config.host!;
      const now = new Date();

      // Build abilities for the share key
      const abilities: Record<string, Record<string, string[]>> = {
        kv: {
          [params.path]: params.actions,
        },
      };

      // Prepare a direct delegation to the share key (no parents = root delegation)
      const prepared = this.wasmBindings.prepareSession({
        abilities,
        address: this.wasmBindings.ensureEip55(session.address),
        chainId: session.chainId,
        domain: this.siweDomain,
        issuedAt: now.toISOString(),
        expirationTime: params.requestedExpiry.toISOString(),
        spaceId: params.spaceId,
        delegateUri: params.shareKeyDID,
      });

      // Sign with the signer (no popup in node-sdk)
      const signature = await this.signer.signMessage(prepared.siwe);

      const delegationSession = this.wasmBindings.completeSessionSetup({
        ...prepared,
        signature,
      });

      // Activate the delegation with the server
      const activateResult = await activateSessionWithHost(
        host,
        delegationSession.delegationHeader
      );

      if (!activateResult.success) {
        return undefined;
      }

      return {
        cid: delegationSession.delegationCid,
        delegateDID: params.shareKeyDID,
        delegatorDID: `did:pkh:eip155:${session.chainId}:${session.address}`,
        spaceId: params.spaceId,
        path: params.path,
        actions: params.actions,
        expiry: params.requestedExpiry,
        isRevoked: false,
        allowSubDelegation: true,
        createdAt: now,
        authHeader: delegationSession.delegationHeader.Authorization,
      };
    } catch {
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
   * App-facing secrets API backed by the `secrets` space vault.
   */
  get secrets(): ISecretsService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    if (!this._secrets) {
      this._secrets = new NodeSecretsService({
        getService: () => this.getBaseSecrets(),
        getManifest: () => this.manifest,
        grantPermissions: (additional) => this.grantRuntimePermissions(additional),
        canEscalate: () => this.signer !== undefined && this.tc !== undefined,
        getUnlockSigner: () => this.signer ?? undefined,
      });
    }
    return this._secrets;
  }

  private getBaseSecrets(): ISecretsService {
    if (!this._spaceService) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    if (!this._baseSecrets) {
      this._baseSecrets = new SecretsService(() => this.space("secrets").vault);
    }
    return this._baseSecrets;
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
    const session = this.auth?.tinyCloudSession;
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
      return this.runtimePermissionGrants.map((grant) => grant.delegation);
    }

    const session = this.auth?.tinyCloudSession;
    if (!session || !Array.isArray(permissions) || permissions.length === 0) {
      return [];
    }
    const expanded = this.expandPermissionEntries(permissions);
    return this.findRuntimeGrantsForPermissionEntries(expanded, session).map(
      (grant) => grant.delegation,
    );
  }

  /**
   * Install a portable runtime permission delegation into this SDK instance so
   * matching service calls and downstream `delegateTo()` calls can use it.
   */
  async useRuntimeDelegation(delegation: PortableDelegation): Promise<void> {
    const session = this.auth?.tinyCloudSession;
    if (!session) {
      throw new SessionExpiredError(new Date(0));
    }
    if (delegation.expiry.getTime() <= Date.now()) {
      throw new SessionExpiredError(delegation.expiry);
    }

    const expectedDids = new Set([session.verificationMethod, this.sessionDid]);
    if (!expectedDids.has(delegation.delegateDID)) {
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
    const session = this.auth?.tinyCloudSession;
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

    const bySpace = new Map<string, PermissionEntry[]>();
    for (const entry of expanded) {
      const spaceId = this.resolvePermissionSpace(entry.space, session);
      const current = bySpace.get(spaceId) ?? [];
      current.push(entry);
      bySpace.set(spaceId, current);
    }

    const now = new Date();
    const requestedExpiryMs = resolveExpiryMs(options?.expiry);
    let expiresAt = new Date(now.getTime() + requestedExpiryMs);
    if (sessionExpiry !== undefined && sessionExpiry < expiresAt) {
      expiresAt = sessionExpiry;
    }

    const delegations: PortableDelegation[] = [];
    for (const [spaceId, entries] of bySpace) {
      const abilities = this.permissionsToAbilities(entries);
      const prepared = this.wasmBindings.prepareSession({
        abilities,
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
        entries,
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
        operations: this.permissionOperations(entries, spaceId),
        expiresAt,
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
    const kvActions = [
      "tinycloud.kv/put",
      "tinycloud.kv/get",
      "tinycloud.kv/del",
      "tinycloud.kv/list",
      "tinycloud.kv/metadata",
    ];
    const abilities = { kv: { "": kvActions } };
    const now = new Date();
    const expiryMs = 60 * 60 * 1000;
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
      const publicContext = new ServiceContext({
        invoke: this.invokeWithRuntimePermissions,
        fetch: this._serviceContext.fetch,
        hosts: this._serviceContext.hosts,
      });
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
  async revokeDelegation(cid: string): Promise<DelegationResult<void>> {
    return this.delegationManager.revoke(cid);
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
    const session = this.auth?.tinyCloudSession;
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
      (siwe: string) => this.wasmBindings.parseRecapFromSiwe(siwe),
      session.siwe,
    );
    const { subset, missing } = isCapabilitySubset(expandedEntries, granted);

    if (!subset) {
      const runtimeGrant = this.findGrantForOperations(
        this.permissionEntriesToOperations(expandedEntries, session),
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
    const target = request.delegationTargets.find((entry) => entry.did === did);
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
   * All entries must share the same target space (the UCAN is
   * scoped to a single space). If they don't, this throws — mixing
   * spaces in a single delegation is not supported by the underlying
   * Rust create_delegation call and the resulting UCAN would be
   * under-specified.
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

    // Translate the manifest `space` field into the server-side
    // spaceId. Full `tinycloud:` URIs pass through; short names are
    // resolved against the current wallet.
    const resolvedSpaces = new Set<string>();
    for (const entry of entries) {
      const spaceId = this.resolvePermissionSpace(entry.space, session);
      resolvedSpaces.add(spaceId);
    }
    if (resolvedSpaces.size !== 1) {
      throw new Error(
        `delegateTo: all permission entries must target the same space, got ${resolvedSpaces.size}: ${JSON.stringify([...resolvedSpaces])}`,
      );
    }
    const spaceId = [...resolvedSpaces][0];

    // Convert entries to the WASM abilities shape. Each entry's
    // `service` is the long form (e.g. "tinycloud.kv") which we
    // translate to the short form keyed by the abilities map.
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
  ): Promise<PortableDelegation> {
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

  private permissionOperations(
    entries: PermissionEntry[],
    spaceId: string,
  ): RuntimePermissionOperation[] {
    return entries.flatMap((entry) => {
      const service = this.shortServiceName(entry.service);
      return entry.actions.map((action) => ({
        spaceId,
        service,
        path: entry.path,
        action,
      }));
    });
  }

  private sessionCoversPermissionEntries(
    session: TinyCloudSession,
    entries: PermissionEntry[],
  ): boolean {
    try {
      const granted = parseRecapCapabilities(
        (siwe: string) => this.wasmBindings.parseRecapFromSiwe(siwe),
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
        spaceId,
        service,
        path: entry.path,
        action,
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
      const grant = this.findGrantForOperation(operation);
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
    };
  }

  private delegatedResourcesForEntries(
    entries: PermissionEntry[],
    spaceId: string,
  ): DelegatedResource[] {
    return entries.map((entry) => ({
      service: this.shortServiceName(entry.service),
      space: spaceId,
      path: entry.path,
      actions: [...entry.actions],
    }));
  }

  private operationsFromDelegation(
    delegation: PortableDelegation,
  ): RuntimePermissionOperation[] {
    const resources =
      delegation.resources !== undefined && delegation.resources.length > 0
        ? delegation.resources
        : this.flatDelegationResources(delegation);

    return resources.flatMap((resource) =>
      resource.actions.map((action) => ({
        spaceId: resource.space,
        service: this.invocationServiceName(resource.service),
        path: resource.path,
        action,
      })),
    );
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
    }));
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
    return grant?.session ?? fallback;
  }

  private findGrantForOperations(
    operations: RuntimePermissionOperation[],
  ): RuntimePermissionGrant | undefined {
    if (operations.length === 0) {
      return undefined;
    }
    this.pruneExpiredRuntimePermissionGrants();
    return this.runtimePermissionGrants.find((grant) => {
      return operations.every((operation) =>
        grant.operations.some((granted) =>
          this.operationCovers(granted, operation),
        ),
      );
    });
  }

  private findGrantForOperation(
    operation: RuntimePermissionOperation,
  ): RuntimePermissionGrant | undefined {
    return this.findGrantForOperations([operation]);
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
    return granted.spaceId === requested.spaceId &&
      granted.service === requested.service &&
      this.actionContains(granted.action, requested.action) &&
      this.pathContains(granted.path, requested.path);
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
      resolvedDelegateDID = `did:pkh:eip155:1:${address}`;
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
        kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/metadata"] },
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
          actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/metadata"],
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
      if (delegation.delegateDID !== myDid) {
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

      return new DelegatedAccess(session, delegation, targetHost, this.wasmBindings.invoke);
    }

    // Wallet mode: create a SIWE sub-delegation
    const mySession = this.auth?.tinyCloudSession;
    if (!mySession) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    // Use our existing session key - the delegation targets our DID from signIn
    // We must use the same key that the delegation was created for
    const jwk = mySession.jwk;

    // Build abilities from the delegation
    const abilities: Record<string, Record<string, string[]>> = {};
    const kvActions = delegation.actions.filter(a => a.startsWith("tinycloud.kv/"));
    const sqlActions = delegation.actions.filter(a => a.startsWith("tinycloud.sql/"));
    const duckdbActions = delegation.actions.filter(a => a.startsWith("tinycloud.duckdb/"));
    if (kvActions.length > 0) {
      abilities.kv = { [delegation.path]: kvActions };
    }
    if (sqlActions.length > 0) {
      abilities.sql = { [delegation.path]: sqlActions };
    }
    if (duckdbActions.length > 0) {
      abilities.duckdb = { [delegation.path]: duckdbActions };
    }

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

    return new DelegatedAccess(session, delegation, targetHost, this.wasmBindings.invoke);
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
