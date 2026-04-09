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
  DataVaultService,
  IDataVaultService,
  createVaultCrypto,
  ServiceSession,
  ServiceContext,
  ISessionStorage,
  ISigner,
  INotificationHandler,
  SilentNotificationHandler,
  IENSResolver,
  IWasmBindings,
  ISessionManager,
  ISpaceCreationHandler,
  // v2 services
  DelegationManager,
  SpaceService,
  ISpaceService,
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
  UnsupportedFeatureError,
  makePublicSpaceId,
} from "@tinycloud/sdk-core";
import {
  NodeUserAuthorization,
  type NodeUserAuthorizationConfig,
} from "./authorization/NodeUserAuthorization";
import { FileSessionStorage } from "./storage/FileSessionStorage";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { PortableDelegation } from "./delegation";
import { DelegatedAccess } from "./DelegatedAccess";
import { WasmKeyProvider } from "./keys/WasmKeyProvider";

/** Default TinyCloud host */
const DEFAULT_HOST = "https://node.tinycloud.xyz";

type AbilityMap = NonNullable<NodeUserAuthorizationConfig["defaultActions"]>;

/**
 * Configuration for TinyCloudNode.
 * All fields are optional - TinyCloudNode can work with zero configuration.
 */
export interface TinyCloudNodeConfig {
  /** Hex-encoded private key (with or without 0x prefix). Optional - only needed for wallet mode and signIn() */
  privateKey?: string;
  /** Custom signer implementation. If provided, takes precedence over privateKey. */
  signer?: ISigner;
  /** TinyCloud server URL (default: "https://node.tinycloud.xyz") */
  host?: string;
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
  /** Optional SIWE configuration overrides (e.g., nonce for server-provided nonces) */
  siweConfig?: SiweConfig;
  /** Optional default actions to grant on sign-in sessions. */
  defaultActions?: NodeUserAuthorizationConfig["defaultActions"];
}

export interface TinyCloudKVReplicationScope {
  service: "kv";
  prefix: string;
}

export interface TinyCloudSqlReplicationScope {
  service: "sql";
  dbName: string;
}

export type TinyCloudReplicationScope =
  | TinyCloudKVReplicationScope
  | TinyCloudSqlReplicationScope;

export interface OpenReplicationSessionParams {
  host?: string;
  scope: TinyCloudReplicationScope;
  spaceIdOverride?: string;
}

export interface TinyCloudReplicationSession {
  host: string;
  scope: TinyCloudReplicationScope;
  delegationHeader: { Authorization: string };
  supportingDelegations: string[];
  delegationCid: string;
  spaceId: string;
  verificationMethod: string;
  expiresAt: Date;
}

export type OpenReplicationSessionResult = TinyCloudReplicationSession;

function buildReplicationScopeResource(scope: TinyCloudReplicationScope): string {
  if (scope.service === "kv") {
    const normalizedPrefix = scope.prefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return normalizedPrefix.length > 0 ? `kv/${normalizedPrefix}` : "kv";
  }

  const normalizedDbName = scope.dbName.replace(/^\/+/, "").replace(/\/+$/, "");
  return `sql/${normalizedDbName}`;
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
  private _vault?: DataVaultService;
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

  private get nodeFeatures(): string[] {
    return this.auth?.nodeFeatures ?? [];
  }

  /** SIWE domain — uses config override or defaults to app.tinycloud.xyz */
  private get siweDomain(): string {
    return this.config.domain ?? 'app.tinycloud.xyz';
  }

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
      invoke: this.wasmBindings.invoke,
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
    const host = this.config.host!;

    this.auth = new NodeUserAuthorization({
      signer: this.signer!,
      signStrategy: { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionStorage: config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: config.prefix,
      defaultActions: config.defaultActions,
      sessionExpirationMs: config.sessionExpirationMs ?? 60 * 60 * 1000,
      tinycloudHosts: [host],
      autoCreateSpace: config.autoCreateSpace,
      enablePublicSpace: config.enablePublicSpace ?? true,
      spaceCreationHandler: config.spaceCreationHandler,
      siweConfig: config.siweConfig,
    });

    this.tc = new TinyCloud(this.auth);
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

  async openReplicationSession(
    params: OpenReplicationSessionParams
  ): Promise<TinyCloudReplicationSession> {
    if (!this.signer) {
      throw new Error(
        "Cannot openReplicationSession() in session-only mode. Requires wallet mode."
      );
    }

    const session = this.session;
    if (!session) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    const host = (params.host ?? this.config.host)?.replace(/\/$/, "");
    if (!host) {
      throw new Error("Replication session host is required.");
    }

    const scope = params.scope;
    const spaceId = params.spaceIdOverride ?? session.spaceId;
    const resource = buildReplicationScopeResource(scope);
    const abilities: AbilityMap = {
      space: {
        [resource]: ["tinycloud.space/sync"],
      },
    };

    const now = new Date();
    const expirationTime = new Date(
      now.getTime() + (this.config.sessionExpirationMs ?? 60 * 60 * 1000)
    );

    const prepared = this.wasmBindings.prepareSession({
      abilities,
      address: this.wasmBindings.ensureEip55(session.address),
      chainId: session.chainId,
      domain: this.siweDomain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      jwk: session.jwk,
      parents: [session.delegationCid],
    });

    const signature = await this.signer.signMessage(prepared.siwe);
    const scopedSession = this.wasmBindings.completeSessionSetup({
      ...prepared,
      signature,
    });

    return {
      host,
      scope,
      delegationHeader: scopedSession.delegationHeader,
      supportingDelegations: [session.delegationHeader.Authorization],
      delegationCid: scopedSession.delegationCid,
      spaceId,
      verificationMethod: session.verificationMethod,
      expiresAt: expirationTime,
    };
  }

  /**
   * Sign in and create a new session.
   * This creates the user's space if it doesn't exist.
   * Requires wallet mode (privateKey in config).
   */
  async signIn(): Promise<void> {
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
    this._serviceContext = undefined;

    await this.tc.signIn();

    // Initialize service context with session
    this.initializeServices();

    this.notificationHandler.success("Successfully signed in");
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
    this._serviceContext = undefined;

    if (sessionData.address) {
      this._address = sessionData.address;
    }
    if (sessionData.chainId) {
      this._chainId = sessionData.chainId;
    }

    // Create service context
    this._serviceContext = new ServiceContext({
      invoke: this.wasmBindings.invoke,
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
    const wasm = this.wasmBindings;
    const vaultCrypto = createVaultCrypto({
      vault_encrypt: wasm.vault_encrypt, vault_decrypt: wasm.vault_decrypt, vault_derive_key: wasm.vault_derive_key,
      vault_x25519_from_seed: wasm.vault_x25519_from_seed, vault_x25519_dh: wasm.vault_x25519_dh,
      vault_random_bytes: wasm.vault_random_bytes, vault_sha256: wasm.vault_sha256,
    });
    const self = this;
    this._vault = new DataVaultService({
      spaceId: sessionData.spaceId,
      crypto: vaultCrypto,
      tc: {
        kv: this._kv!,
        ensurePublicSpace: async () => {
          try {
            await self.ensurePublicSpace();
            return { ok: true as const, data: undefined };
          } catch (error) {
            return { ok: false as const, error: { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : String(error), service: "vault" } };
          }
        },
        get publicKV() { return self._publicKV ?? self.tc!.publicKV; },
        readPublicSpace: <T>(host: string, spaceId: string, key: string) =>
          TinyCloud.readPublicSpace<T>(host, spaceId, key),
        makePublicSpaceId: TinyCloud.makePublicSpaceId,
        did: this.did,
        address: sessionData.address ?? this._address ?? "",
        chainId: sessionData.chainId ?? this._chainId,
        hosts: [this.config.host!],
      },
    });
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
    const host = this.config.host!;

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
      tinycloudHosts: [host],
      autoCreateSpace: this.config.autoCreateSpace,
      enablePublicSpace: this.config.enablePublicSpace ?? true,
      spaceCreationHandler: this.config.spaceCreationHandler,
      defaultActions: this.config.defaultActions,
    });

    // Create TinyCloud instance
    this.tc = new TinyCloud(this.auth);

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
    const host = this.config.host!;

    this.signer = signer;

    this.auth = new NodeUserAuthorization({
      signer: this.signer,
      signStrategy: { type: "auto-sign" },
      wasmBindings: this.wasmBindings,
      sessionStorage: options?.sessionStorage ?? this.config.sessionStorage ?? new MemorySessionStorage(),
      domain: this.siweDomain,
      spacePrefix: prefix,
      sessionExpirationMs: this.config.sessionExpirationMs ?? 60 * 60 * 1000,
      tinycloudHosts: [host],
      autoCreateSpace: this.config.autoCreateSpace,
      enablePublicSpace: this.config.enablePublicSpace ?? true,
      spaceCreationHandler: this.config.spaceCreationHandler,
      defaultActions: this.config.defaultActions,
    });

    this.tc = new TinyCloud(this.auth);
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
    this.tc!.initializeServices(this.wasmBindings.invoke, [this.config.host!]);

    // Create service context
    this._serviceContext = new ServiceContext({
      invoke: this.wasmBindings.invoke,
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
    const wasm = this.wasmBindings;
    const vaultCrypto = createVaultCrypto({
      vault_encrypt: wasm.vault_encrypt, vault_decrypt: wasm.vault_decrypt, vault_derive_key: wasm.vault_derive_key,
      vault_x25519_from_seed: wasm.vault_x25519_from_seed, vault_x25519_dh: wasm.vault_x25519_dh,
      vault_random_bytes: wasm.vault_random_bytes, vault_sha256: wasm.vault_sha256,
    });
    const self = this;
    this._vault = new DataVaultService({
      spaceId: session.spaceId,
      crypto: vaultCrypto,
      tc: {
        kv: this._kv!,
        ensurePublicSpace: async () => {
          try {
            await self.ensurePublicSpace();
            return { ok: true as const, data: undefined };
          } catch (error) {
            return { ok: false as const, error: { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : String(error), service: "vault" } };
          }
        },
        get publicKV() { return self._publicKV ?? self.tc!.publicKV; },
        readPublicSpace: <T>(host: string, spaceId: string, key: string) =>
          TinyCloud.readPublicSpace<T>(host, spaceId, key),
        makePublicSpaceId: TinyCloud.makePublicSpaceId,
        did: this.did,
        address: this._address!,
        chainId: this._chainId,
        hosts: [this.config.host!],
      },
    });
    this._vault.initialize(this._serviceContext);
    this._serviceContext.registerService('vault', this._vault);

    // Initialize v2 services
    this.initializeV2Services(serviceSession);
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
      invoke: this.wasmBindings.invoke,
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
        // Create a new KV service scoped to the specified space
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
   * Adapts the WASM interface to what SharingService expects.
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
      params.path,
      params.actions,
      params.expirationSecs,
      params.notBeforeSecs
    );

    return {
      delegation: result.delegation,
      cid: result.cid,
      delegateDID: result.delegateDid,
      path: result.path,
      actions: result.actions,
      expiry: new Date(result.expiry * 1000),
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
        invoke: this.wasmBindings.invoke,
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

  async revokeDelegation(cid: string): Promise<DelegationResult<void>> {
    if (!this.signer) {
      return {
        ok: false,
        error: {
          code: "NOT_INITIALIZED",
          message:
            "Cannot revokeDelegation() in session-only mode. Requires wallet mode.",
          service: "delegation",
        },
      };
    }

    const session = this.auth?.tinyCloudSession;
    if (!session) {
      return {
        ok: false,
        error: {
          code: "NOT_INITIALIZED",
          message: "Not signed in. Call signIn() first.",
          service: "delegation",
        },
      };
    }

    try {
      const issuedAt = new Date().toISOString();
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const siwe = [
        `${this.siweDomain} wants you to sign in with your Ethereum account:`,
        this.wasmBindings.ensureEip55(session.address),
        "",
        "",
        `URI: ucan:${cid}`,
        "Version: 1",
        `Chain ID: ${session.chainId}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join("\n");
      const signature = await this.signer.signMessage(siwe);

      const response = await globalThis.fetch(`${this.config.host!}/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ siwe, signature }),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: "NETWORK_ERROR",
            message: `Failed to revoke delegation: ${response.status} - ${await response.text()}`,
            service: "delegation",
          },
        };
      }

      this._capabilityRegistry.revokeDelegation(cid);
      return { ok: true, data: undefined };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "NETWORK_ERROR",
          message: `Network error revoking delegation: ${String(error)}`,
          service: "delegation",
        },
      };
    }
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
    if (!this.signer) {
      throw new Error("Cannot createDelegation() in session-only mode. Requires wallet mode.");
    }
    const session = this.auth?.tinyCloudSession;
    if (!session) {
      throw new Error("Not signed in. Call signIn() first.");
    }

    // Resolve ENS names to PKH DIDs
    if (params.delegateDID.endsWith('.eth') && this.config.ensResolver) {
      const address = await this.config.ensResolver.resolveAddress(params.delegateDID);
      if (!address) throw new Error(`Could not resolve ENS name: ${params.delegateDID}`);
      params = { ...params, delegateDID: `did:pkh:eip155:1:${address}` };
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
