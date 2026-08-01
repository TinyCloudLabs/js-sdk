import { EventEmitter } from "events";
import { SiweMessage } from "siwe";
import {
  IUserAuthorization,
  ISigner,
  ISessionStorage,
  ClientSession,
  Extension,
  PersistedSessionData,
  TinyCloudSession,
  SiweConfig,
  SignInOptions,
  SpaceHostResult,
  fetchPeerId,
  submitHostDelegation,
  activateSessionWithHost,
  checkNodeInfo,
  ISpaceCreationHandler,
  AutoApproveSpaceCreationHandler,
  IWasmBindings,
  ISessionManager,
  Manifest,
  ComposedManifestRequest,
  AbilitiesMap,
  DEFAULT_MANIFEST_SPACE,
  ENCRYPTION_PERMISSION_SERVICE,
  composeManifestRequest,
  parseNetworkId,
  principalDidEquals,
  resourceCapabilitiesToAbilitiesMap,
  resourceCapabilitiesToSpaceAbilitiesMap,
  resolveTinyCloudHosts,
  type LocalNodeIdentityStore,
  EXPIRY,
  canonicalizeAddress,
  makePkhSpaceId,
  pkhDid,
  extractImmutableSiweFields,
  diffImmutableSiweFields,
  extractRecapAttenuations,
  unauthorizedRecapCapabilities,
  KV,
  SQL,
  DUCKDB,
  CAPABILITIES,
  HOOKS,
  ENCRYPTION,
} from "@tinycloud/sdk-core";
import {
  SignStrategy,
  SignRequest,
  SignResponse,
  defaultSignStrategy,
} from "./strategies";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const DECRYPT_ACTION = ENCRYPTION.DECRYPT;
const NETWORK_CREATE_ACTION = ENCRYPTION.NETWORK_CREATE;

function didPrincipalMatches(actual: string, expected: string): boolean {
  try {
    return principalDidEquals(actual, expected);
  } catch {
    return actual === expected;
  }
}

function addRawAbility(
  rawAbilities: Record<string, string[]>,
  resource: string,
  action: string,
): void {
  const actions = rawAbilities[resource];
  if (actions === undefined) {
    rawAbilities[resource] = [action];
    return;
  }
  if (!actions.includes(action)) {
    actions.push(action);
  }
}

/**
 * Configuration for NodeUserAuthorization.
 */
export interface NodeUserAuthorizationConfig {
  /** The signer used for signing messages */
  signer: ISigner;
  /** Sign strategy for handling sign requests */
  signStrategy?: SignStrategy;
  /** Session storage implementation */
  sessionStorage?: ISessionStorage;
  /** Domain for SIWE messages */
  domain: string;
  /** URI for SIWE messages (default: domain) */
  uri?: string;
  /** Statement included in SIWE messages */
  statement?: string;
  /** Space prefix for new sessions */
  spacePrefix?: string;
  /** Default actions for sessions */
  defaultActions?: Record<string, Record<string, string[]>>;
  /** Session expiration time in milliseconds (default: 1 hour) */
  sessionExpirationMs?: number;
  /** Automatically create space if it doesn't exist (default: false) */
  autoCreateSpace?: boolean;
  /** Custom space creation handler. If provided, takes precedence over autoCreateSpace. */
  spaceCreationHandler?: ISpaceCreationHandler;
  /** Explicit TinyCloud server endpoints. When omitted, signIn resolves the user's host. */
  tinycloudHosts?: string[];
  /** TinyCloud location registry URL. Default: https://registry.tinycloud.xyz. */
  tinycloudRegistryUrl?: string | null;
  /** Fallback TinyCloud hosts. Default: hosted TinyCloud node. */
  tinycloudFallbackHosts?: string[] | null;
  /** Probe configured/registered local nodes before registry/fallback resolution. Default: true. */
  autoDiscoverLocalNode?: boolean;
  /** Local loopback node URL to probe. Omit to avoid probing loopback. */
  localNodeUrl?: string;
  /** Known `*.local.tinycloud.link` subdomain name, probed directly. */
  localLinkName?: string;
  /** Expected local node DID. A locally-discovered node whose DID differs is rejected. */
  expectedNodeDid?: string;
  /** Pin store for trust-on-first-use local node identity verification. Defaults to an in-memory store. */
  localNodeIdentityStore?: LocalNodeIdentityStore;
  /** Whether to include public space capabilities in the session (default: true) */
  enablePublicSpace?: boolean;
  /** WASM bindings for cryptographic operations. Required. */
  wasmBindings: IWasmBindings;
  /** Existing session manager to share with a higher-level SDK client. */
  sessionManager?: ISessionManager;
  /**
   * SIWE nonce override. If omitted, the WASM layer generates a random nonce.
   * If `siweConfig.nonce` is also provided, `siweConfig.nonce` wins.
   */
  nonce?: string;
  /** Optional SIWE configuration overrides (e.g., nonce for server-provided nonces) */
  siweConfig?: SiweConfig;
  /**
   * App manifest used to drive the SIWE recap at sign-in.
   *
   * When set, `signIn` resolves the manifest (via
   * {@link resolveManifest}), unions the app's own permissions with
   * every `delegations[*].permissions` list, converts to the WASM
   * abilities shape, and uses that map as the session's granted
   * capabilities — *instead* of `defaultActions`.
   *
   * This is what makes manifest-declared pre-delegations usable: the
   * session key's recap covers both the app's runtime needs and the
   * downstream delegation targets, so `delegateTo` can issue the
   * sub-delegation via the session-key UCAN path without a wallet
   * prompt.
   *
   * When omitted, `signIn` falls back to `defaultActions` for
   * backwards compatibility.
   */
  manifest?: Manifest | Manifest[];
  /** Pre-composed manifest request. Takes precedence over `manifest`. */
  capabilityRequest?: ComposedManifestRequest;
  /** Include implicit account registry permissions when composing `manifest`. Default true. */
  includeAccountRegistryPermissions?: boolean;
}

export interface CreateBootstrapSessionOptions {
  spaceId: string;
  capabilityRequest: ComposedManifestRequest;
  rawAbilities?: Record<string, string[]>;
}

/**
 * Node.js implementation of IUserAuthorization.
 *
 * Supports multiple sign strategies for different use cases:
 * - auto-sign: Automatically approve all sign requests (trusted backends)
 * - auto-reject: Reject all sign requests (read-only mode)
 * - callback: Delegate to a custom callback function (CLI prompts)
 * - event-emitter: Emit sign requests as events (async workflows)
 *
 * @example
 * ```typescript
 * // Auto-sign for backend services
 * const auth = new NodeUserAuthorization({
 *   signer: new PrivateKeySigner(process.env.PRIVATE_KEY),
 *   signStrategy: { type: 'auto-sign' },
 *   domain: 'api.myapp.com',
 * });
 *
 * // Callback for CLI prompts
 * const auth = new NodeUserAuthorization({
 *   signer,
 *   signStrategy: {
 *     type: 'callback',
 *     handler: async (req) => {
 *       const approved = await promptUser(`Sign for ${req.address}?`);
 *       return { approved };
 *     }
 *   },
 *   domain: 'cli.myapp.com',
 * });
 * ```
 */
export class NodeUserAuthorization implements IUserAuthorization {
  private readonly signer: ISigner;
  private readonly signStrategy: SignStrategy;
  private readonly sessionStorage: ISessionStorage;
  private readonly domain: string;
  private readonly uri: string;
  private readonly statement?: string;
  private readonly spacePrefix: string;
  private readonly defaultActions: Record<string, Record<string, string[]>>;
  private readonly sessionExpirationMs: number;
  private readonly autoCreateSpace: boolean;
  private readonly spaceCreationHandler?: ISpaceCreationHandler;
  private tinycloudHosts?: string[];
  private readonly tinycloudRegistryUrl?: string | null;
  private readonly tinycloudFallbackHosts?: string[] | null;
  private readonly autoDiscoverLocalNode?: boolean;
  private readonly localNodeUrl?: string;
  private readonly localLinkName?: string;
  private readonly expectedNodeDid?: string;
  private readonly localNodeIdentityStore?: LocalNodeIdentityStore;
  private readonly enablePublicSpace: boolean;
  private readonly nonce?: string;
  private readonly siweConfig?: SiweConfig;
  private readonly wasm: IWasmBindings;
  /**
   * Stored manifest, if one was provided at construction time. Used by
   * {@link signIn} to derive the session's granted capabilities instead
   * of falling back to {@link defaultActions}.
   */
  private _manifest?: Manifest | Manifest[];
  private _capabilityRequest?: ComposedManifestRequest;
  private readonly includeAccountRegistryPermissions: boolean;

  private sessionManager: ISessionManager;
  private activeSessionKeyId = "default";
  private extensions: Extension[] = [];
  private _session?: ClientSession;
  private _tinyCloudSession?: TinyCloudSession;
  private _address?: string;
  private _chainId?: number;
  private _nodeFeatures: string[] = [];
  /**
   * `nodeId` from the `GET /info` performed during sign-in/restore, tagged with
   * the host it came from. Callers that need the node DID (encryption-network
   * admin invocations) reuse this instead of re-fetching `/info`.
   */
  private _nodeInfoIdentity?: { host: string; nodeId: string };
  private _lastActivationSkippedSpaceIds: string[] = [];

  constructor(config: NodeUserAuthorizationConfig) {
    this.wasm = config.wasmBindings;

    this.signer = config.signer;
    this.signStrategy = config.signStrategy ?? defaultSignStrategy;
    this.sessionStorage = config.sessionStorage ?? new MemorySessionStorage();
    this.domain = config.domain;
    this.uri = config.uri ?? `https://${config.domain}`;
    this.statement = config.statement;
    this.spacePrefix = config.spacePrefix ?? "default";
    this.defaultActions = config.defaultActions ?? {
      kv: {
        "": [KV.PUT, KV.GET, KV.DEL, KV.LIST, KV.METADATA],
      },
      sql: {
        "": [SQL.READ, SQL.WRITE, SQL.SCHEMA, SQL.ADMIN, SQL.EXPORT],
      },
      duckdb: {
        "": [
          DUCKDB.READ,
          DUCKDB.WRITE,
          DUCKDB.ADMIN,
          DUCKDB.DESCRIBE,
          DUCKDB.EXPORT,
          DUCKDB.IMPORT,
          DUCKDB.EXECUTE,
        ],
      },
      capabilities: {
        "": [CAPABILITIES.READ],
      },
      hooks: {
        "": [HOOKS.SUBSCRIBE, HOOKS.REGISTER, HOOKS.LIST, HOOKS.UNREGISTER],
      },
    };
    this.sessionExpirationMs = config.sessionExpirationMs ?? EXPIRY.SESSION_MS;
    this.autoCreateSpace = config.autoCreateSpace ?? false;
    this.spaceCreationHandler = config.spaceCreationHandler;
    this.tinycloudHosts = config.tinycloudHosts;
    this.tinycloudRegistryUrl = config.tinycloudRegistryUrl;
    this.tinycloudFallbackHosts = config.tinycloudFallbackHosts;
    this.autoDiscoverLocalNode = config.autoDiscoverLocalNode;
    this.localNodeUrl = config.localNodeUrl;
    this.localLinkName = config.localLinkName;
    this.expectedNodeDid = config.expectedNodeDid;
    this.localNodeIdentityStore = config.localNodeIdentityStore;
    this.enablePublicSpace = config.enablePublicSpace ?? true;
    this.nonce = config.nonce;
    this.siweConfig = config.siweConfig;
    this.includeAccountRegistryPermissions =
      config.includeAccountRegistryPermissions ?? true;
    this._manifest = config.manifest;
    this._capabilityRequest = config.capabilityRequest;

    // Reuse the caller's manager when authorization is owned by a higher-level
    // client so both layers address the same session keys.
    this.sessionManager = config.sessionManager ?? this.wasm.createSessionManager();
  }

  /**
   * Return the manifest currently driving sign-in behavior, or
   * `undefined` if none is set. Used by TinyCloudWeb/TinyCloudNode
   * internals to surface the manifest for requestPermissions flows
   * without forcing the caller to track it separately.
   */
  get manifest(): Manifest | Manifest[] | undefined {
    return this._manifest;
  }

  get capabilityRequest(): ComposedManifestRequest | undefined {
    return this.getCapabilityRequest();
  }

  get hosts(): string[] {
    return this.tinycloudHosts ? [...this.tinycloudHosts] : [];
  }

  /**
   * Install or replace the stored manifest. Takes effect on the next
   * `signIn()` call — the current session (if any) is not touched.
   */
  setManifest(manifest: Manifest | Manifest[] | undefined): void {
    this._manifest = manifest;
    this._capabilityRequest = undefined;
  }

  setCapabilityRequest(request: ComposedManifestRequest | undefined): void {
    this._capabilityRequest = request;
  }

  /**
   * The current active session (web-core compatible).
   */
  get session(): ClientSession | undefined {
    return this._session;
  }

  /**
   * The current TinyCloud session with full delegation data.
   * Includes spaceId, delegationHeader, and delegationCid.
   */
  get tinyCloudSession(): TinyCloudSession | undefined {
    return this._tinyCloudSession;
  }

  /**
   * Rehydrate the auth-layer session from previously-persisted delegation
   * data. Used by {@link TinyCloudNode.restoreSession} so that downstream
   * surfaces that read from `tinyCloudSession` (notably
   * `grantRuntimePermissions`, which extracts the SIWE expiry from it) work
   * without re-running the full sign-in flow.
   *
   * Caller must supply the same fields that `signIn` would have written —
   * `siwe` is the load-bearing one because `extractSiweExpiration` returns
   * undefined for missing SIWEs and the SDK then treats the session as
   * expired-at-epoch-zero.
   *
   * @param hosts - The TinyCloud hosts this session was created against,
   *   as persisted in {@link PersistedSessionData.tinycloudHosts}. When
   *   present (and non-empty) they are adopted directly so the restored
   *   session resolves to the same node as the original sign-in without
   *   re-running registry/fallback resolution. When absent (old session)
   *   hosts are resolved lazily on the first host-needing call via
   *   {@link ensureTinyCloudHosts}.
   */
  setRestoredTinyCloudSession(
    session: TinyCloudSession,
    hosts?: string[],
  ): void {
    const address = canonicalizeAddress(session.address);
    this._tinyCloudSession = { ...session, address };
    this._address = address;
    this._chainId = session.chainId;
    // Don't overwrite an explicitly-configured host (e.g. local dev) with a
    // possibly-stale persisted value: only adopt persisted hosts when none
    // are already set.
    if (
      (!this.tinycloudHosts || this.tinycloudHosts.length === 0) &&
      hosts &&
      hosts.length > 0
    ) {
      this.tinycloudHosts = [...hosts];
    }
  }

  /** @internal Atomically adopt the state staged by TinyCloudNode.restoreSession. */
  installRestoredSession(
    sessionManager: ISessionManager,
    session: TinyCloudSession | undefined,
    hosts?: string[],
  ): void {
    this.sessionManager = sessionManager;
    // Restore is a complete session replacement, not an additive update. In
    // particular, a second restore may target a different host and must not
    // retain skip decisions from the previous activation.
    this.tinycloudHosts = hosts && hosts.length > 0 ? [...hosts] : undefined;
    this._lastActivationSkippedSpaceIds = [];
    if (!session) {
      this._session = undefined;
      this._tinyCloudSession = undefined;
      this._address = undefined;
      this._chainId = undefined;
      return;
    }
    this._tinyCloudSession = { ...session };
    this._address = session.address;
    this._chainId = session.chainId;
    this._session = {
      address: session.address,
      walletAddress: session.address,
      chainId: session.chainId,
      sessionKey: session.sessionKey,
      siwe: session.siwe,
      signature: session.signature,
    };
  }

  /**
   * Ensure `tinycloudHosts` are resolved before a host-needing call.
   *
   * Fresh sign-in resolves hosts up front; a restored session may not have
   * (old persisted sessions predate {@link PersistedSessionData.tinycloudHosts}).
   * This guard makes a restored session resolve the node exactly like a fresh
   * sign-in — persisted hosts are preferred (already set by
   * {@link setRestoredTinyCloudSession}), otherwise the registry/fallback
   * resolution runs lazily here. Idempotent: {@link resolveTinyCloudHostsForSignIn}
   * early-returns when hosts are already set.
   *
   * Throws if hosts are unset and the restored session has no address/chainId
   * to resolve from — a real failure that must surface, not be masked.
   */
  async ensureTinyCloudHosts(): Promise<void> {
    if (this.tinycloudHosts && this.tinycloudHosts.length > 0) {
      return;
    }
    if (this._address === undefined || this._chainId === undefined) {
      throw new Error(
        "Cannot resolve TinyCloud hosts: no address/chainId available. " +
          "Sign in or restore a session first.",
      );
    }
    await this.resolveTinyCloudHostsForSignIn(this._address, this._chainId);
  }

  private async resolveTinyCloudHostsForSignIn(
    address: string,
    chainId: number,
  ): Promise<void> {
    if (this.tinycloudHosts && this.tinycloudHosts.length > 0) {
      return;
    }

    const subject = pkhDid(address, chainId);
    const resolved = await resolveTinyCloudHosts(subject, {
      registryUrl: this.tinycloudRegistryUrl,
      fallbackHosts: this.tinycloudFallbackHosts,
      autoDiscoverLocalNode: this.autoDiscoverLocalNode,
      localNodeUrl: this.localNodeUrl,
      localLinkName: this.localLinkName,
      expectedNodeDid: this.expectedNodeDid,
      localNodeIdentityStore: this.localNodeIdentityStore,
    });
    this.tinycloudHosts = resolved.hosts;
  }

  private requireTinyCloudHosts(): string[] {
    if (!this.tinycloudHosts || this.tinycloudHosts.length === 0) {
      throw new Error("TinyCloud hosts have not been resolved. Call signIn() first.");
    }
    return this.tinycloudHosts;
  }

  private get primaryTinyCloudHost(): string {
    return this.requireTinyCloudHosts()[0];
  }

  get nodeFeatures(): string[] {
    return this._nodeFeatures;
  }

  /**
   * The node DID reported by `GET /info` for `host`, if the sign-in (or
   * restore) that populated it targeted that same host. Returns `undefined`
   * for any other host, and for nodes whose `/info` omits `nodeId`, so callers
   * fall back to fetching it themselves rather than using a foreign node's DID.
   */
  nodeIdForHost(host: string): string | undefined {
    return this._nodeInfoIdentity?.host === host
      ? this._nodeInfoIdentity.nodeId
      : undefined;
  }

  get lastActivationSkippedSpaceIds(): string[] {
    return [...this._lastActivationSkippedSpaceIds];
  }

  /**
   * Compute the `abilities` map the WASM `prepareSession` call should
   * see at sign-in time.
   *
   * When a manifest is installed, we resolve it and union together:
   * - the app's own `resources` (what it needs at runtime)
   * - every `additionalDelegates[*].permissions` list (what it will
   *   re-delegate to other DIDs post sign-in)
   *
   * into the short-service / path / full-URN-actions shape the WASM
   * layer expects. This is the key invariant that lets
   * {@link TinyCloudNode.delegateTo} issue manifest-declared
   * delegations via the session key (no wallet prompt): the session's
   * own recap already covers every action those delegations need.
   *
   * When no manifest is installed, we fall back to the
   * {@link defaultActions} table so existing callers see no change.
   *
   * This is a pure function of `this._manifest` + `this.defaultActions`
   * — the manifest resolution performs no I/O and throws a
   * {@link ManifestValidationError} on structural problems (missing
   * id/name, unparseable expiry, etc), which will surface at sign-in
   * rather than being silently swallowed.
   *
   * @internal
   */
  private getCapabilityRequest(): ComposedManifestRequest | undefined {
    if (this._capabilityRequest !== undefined) {
      return this._capabilityRequest;
    }
    if (this._manifest === undefined) {
      return undefined;
    }
    this._capabilityRequest = composeManifestRequest(
      Array.isArray(this._manifest) ? this._manifest : [this._manifest],
      {
        includeAccountRegistryPermissions:
          this.includeAccountRegistryPermissions,
      }
    );
    return this._capabilityRequest;
  }

  private resolveSpaceName(space: string, address: string, chainId: number): string {
    if (space.startsWith("tinycloud:")) {
      return space;
    }
    return makePkhSpaceId(address, chainId, space);
  }

  private defaultEncryptionNetworkId(address: string, chainId: number): string {
    return `urn:tinycloud:encryption:${pkhDid(address, chainId)}:default`;
  }

  private resolveSignInCapabilities(
    address: string,
    chainId: number,
  ): {
    abilities: AbilitiesMap;
    spaceId: string;
    spaceAbilities?: Record<string, AbilitiesMap>;
    rawAbilities?: Record<string, string[]>;
  } {
    const request = this.getCapabilityRequest();
    if (request === undefined) {
      const defaultNetworkId = this.defaultEncryptionNetworkId(address, chainId);
      const primarySpaceId = makePkhSpaceId(address, chainId, this.spacePrefix);
      const secretsSpaceId = makePkhSpaceId(address, chainId, "secrets");
      return {
        abilities: this.defaultActions,
        spaceId: primarySpaceId,
        spaceAbilities: {
          [primarySpaceId]: this.defaultActions,
          [secretsSpaceId]: {
            kv: {
              "vault/secrets/": [
                KV.GET,
                KV.PUT,
                KV.DEL,
                KV.LIST,
                KV.METADATA,
              ],
            },
          },
        },
        rawAbilities: {
          [defaultNetworkId]: [DECRYPT_ACTION, NETWORK_CREATE_ACTION],
        },
      };
    }

    const rawAbilities: Record<string, string[]> = {};
    const currentDid = pkhDid(address, chainId);
    const spaceResources = request.resources.filter((entry) => {
      if (entry.service !== ENCRYPTION_PERMISSION_SERVICE) {
        return true;
      }
      for (const action of entry.actions) {
        addRawAbility(rawAbilities, entry.path, action);
      }
      if (entry.actions.includes(DECRYPT_ACTION)) {
        const parsed = parseNetworkId(entry.path);
        if (didPrincipalMatches(parsed.ownerDid, currentDid)) {
          addRawAbility(rawAbilities, entry.path, NETWORK_CREATE_ACTION);
        }
      }
      return false;
    });

    const primarySpaceName =
      spaceResources.find((entry) => entry.space !== "account")?.space ??
      DEFAULT_MANIFEST_SPACE;
    const primarySpaceId = this.resolveSpaceName(
      primarySpaceName,
      address,
      chainId,
    );

    const bySpace = resourceCapabilitiesToSpaceAbilitiesMap(spaceResources);
    const spaceAbilities: Record<string, AbilitiesMap> = {};
    for (const [space, abilities] of Object.entries(bySpace)) {
      spaceAbilities[this.resolveSpaceName(space, address, chainId)] = abilities;
    }

    return {
      abilities:
        spaceAbilities[primarySpaceId] ??
        resourceCapabilitiesToAbilitiesMap([]),
      spaceId: primarySpaceId,
      spaceAbilities,
      rawAbilities:
        Object.keys(rawAbilities).length > 0 ? rawAbilities : undefined,
    };
  }

  /**
   * Build SIWE overrides from the top-level nonce and siweConfig.
   * - Top-level `nonce` is seeded first so `siweConfig.nonce` wins if both are set.
   * - statement is prepended to the default statement
   * - resources are appended to the default resources
   * - uri triggers a warning (overwriting delegation target)
   * - all other fields override directly
   * - per-call nonce overrides siweConfig.nonce when provided
   */
  private buildSiweOverrides(options?: SignInOptions): Record<string, unknown> {
    const base: Record<string, unknown> = { uri: this.uri };
    if (this.nonce !== undefined) {
      base.nonce = this.nonce;
    }

    if (!this.siweConfig && !options?.nonce) {
      return base;
    }

    const { statement, resources, uri, ...rest } = this.siweConfig ?? {};
    const overrides: Record<string, unknown> = { ...base, ...rest };

    if (statement) {
      overrides.statement = this.statement
        ? `${statement} ${this.statement}`
        : statement;
    }

    if (resources && resources.length > 0) {
      overrides.resources = resources;
    }

    if (uri) {
      console.warn(
        "[tinycloud] siweConfig.uri is overwriting the delegation target URI. " +
          "This may break delegation chain validation if the URI does not match the session key DID.",
      );
      overrides.uri = uri;
    }

    if (options?.nonce) {
      overrides.nonce = options.nonce;
    }

    return overrides;
  }

  /**
   * Add an extension to the authorization flow.
   */
  extend(extension: Extension): void {
    this.extensions.push(extension);
  }

  /**
   * Get the space ID for the current session.
   */
  getSpaceId(): string | undefined {
    return this._tinyCloudSession?.spaceId;
  }

  /**
   * Create the space on the TinyCloud server (host delegation).
   * This registers the user as the owner of the space.
   */
  private async hostSpace(
    targetSpaceId?: string,
    purpose?: SignRequest["purpose"],
  ): Promise<boolean> {
    if (!this._tinyCloudSession || !this._address || !this._chainId) {
      throw new Error("Must be signed in to host space");
    }

    await this.ensureTinyCloudHosts();
    const host = this.primaryTinyCloudHost;
    const spaceId = targetSpaceId ?? this._tinyCloudSession.spaceId;

    // Get peer ID from TinyCloud server
    const peerId = await fetchPeerId(host, spaceId);

    // Generate host SIWE message
    const siwe = this.wasm.generateHostSIWEMessage({
      address: this._address,
      chainId: this._chainId,
      domain: this.domain,
      issuedAt: new Date().toISOString(),
      spaceId,
      peerId,
    });

    // Sign the message
    const signature = await this.signMessage(siwe, purpose);

    // Convert to delegation headers and submit
    const headers = this.wasm.siweToDelegationHeaders({ siwe, signature });
    const result = await submitHostDelegation(host, headers);

    return result.success;
  }

  /**
   * Create a specific space on the server via host delegation.
   * Used for lazy creation of additional spaces (e.g., public).
   */
  async hostPublicSpace(spaceId: string): Promise<boolean> {
    return this.hostSpace(spaceId);
  }

  /**
   * Create a specific owned space on the server via host delegation.
   * Used by manifest registry setup for the account space.
   */
  async hostOwnedSpace(
    spaceId: string,
    purpose?: SignRequest["purpose"],
  ): Promise<boolean> {
    return this.hostSpace(spaceId, purpose);
  }

  /**
   * Ensure the user's space exists on the TinyCloud server.
   * Creates the space if it doesn't exist and autoCreateSpace is enabled.
   * If autoCreateSpace is false and space doesn't exist, silently returns
   * (user may be using delegations to access other spaces).
   *
   * @throws Error if space creation fails
   */
  async ensureSpaceExists(): Promise<void> {
    if (!this._tinyCloudSession) {
      throw new Error("Must be signed in to ensure space exists");
    }

    await this.ensureTinyCloudHosts();
    const host = this.primaryTinyCloudHost;
    const primarySpaceId = this._tinyCloudSession.spaceId;

    // Try to activate the session
    const result = await activateSessionWithHost(
      host,
      this._tinyCloudSession.delegationHeader,
    );
    this.recordActivationSkippedSpaces(result, primarySpaceId);

    // Determine the effective space creation handler:
    // 1. Explicit spaceCreationHandler takes precedence
    // 2. autoCreateSpace: true uses AutoApproveSpaceCreationHandler
    // 3. Otherwise, no handler (space creation skipped silently)
    const handler: ISpaceCreationHandler | undefined =
      this.spaceCreationHandler ??
      (this.autoCreateSpace
        ? new AutoApproveSpaceCreationHandler()
        : undefined);

    const creationContext = {
      spaceId: primarySpaceId,
      address: this._address!,
      chainId: this._chainId!,
      host,
    };

    if (result.success) {
      // Check if primary space was actually activated or just skipped
      const primarySkipped = result.skipped?.includes(primarySpaceId);

      if (!primarySkipped) {
        // Primary space exists and session is activated
        return;
      }

      // Primary space was skipped (doesn't exist yet)
      if (!handler) {
        return;
      }

      const confirmed = await handler.confirmSpaceCreation(creationContext);
      if (!confirmed) {
        return;
      }

      // Create the primary space
      try {
        const created = await this.hostSpace();
        if (!created) {
          const err = new Error(`Failed to create space: ${primarySpaceId}`);
          handler.onSpaceCreationFailed?.(creationContext, err);
          throw err;
        }
      } catch (error) {
        handler.onSpaceCreationFailed?.(
          creationContext,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }

      // Small delay to allow space creation to propagate
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry activation
      const retryResult = await activateSessionWithHost(
        host,
        this._tinyCloudSession.delegationHeader,
      );

      if (!retryResult.success) {
        const err = new Error(
          `Failed to activate session after creating space: ${retryResult.error}`,
        );
        handler.onSpaceCreationFailed?.(creationContext, err);
        throw err;
      }

      handler.onSpaceCreated?.(creationContext);
      return;
    }

    // Handle 404 (backwards compat with older servers)
    if (result.status === 404) {
      if (!handler) {
        return;
      }

      const confirmed = await handler.confirmSpaceCreation(creationContext);
      if (!confirmed) {
        return;
      }

      try {
        const created = await this.hostSpace();
        if (!created) {
          const err = new Error(`Failed to create space: ${primarySpaceId}`);
          handler.onSpaceCreationFailed?.(creationContext, err);
          throw err;
        }
      } catch (error) {
        handler.onSpaceCreationFailed?.(
          creationContext,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      const retryResult = await activateSessionWithHost(
        host,
        this._tinyCloudSession.delegationHeader,
      );

      if (!retryResult.success) {
        const err = new Error(
          `Failed to activate session after creating space: ${retryResult.error}`,
        );
        handler.onSpaceCreationFailed?.(creationContext, err);
        throw err;
      }

      handler.onSpaceCreated?.(creationContext);
      return;
    }

    throw new Error(`Failed to activate session: ${result.error}`);
  }

  private recordActivationSkippedSpaces(
    result: SpaceHostResult,
    primarySpaceId: string,
  ): void {
    if (result.success) {
      this._lastActivationSkippedSpaceIds = result.skipped ?? [];
      return;
    }
    this._lastActivationSkippedSpaceIds = result.status === 404
      ? [primarySpaceId]
      : [];
  }

  async createBootstrapSession(
    options: CreateBootstrapSessionOptions,
  ): Promise<TinyCloudSession> {
    if (!this._address || !this._chainId) {
      throw new Error("Must be signed in before creating bootstrap sessions");
    }

    const address = this._address;
    const chainId = this._chainId;
    const keyId = `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.sessionManager.createSessionKey(keyId);
    const jwkString = this.sessionManager.jwk(keyId);
    if (!jwkString) {
      throw new Error("Failed to create bootstrap session key");
    }
    const jwk = JSON.parse(jwkString);
    const now = new Date();
    const expirationTime = new Date(now.getTime() + this.sessionExpirationMs);
    const abilities = resourceCapabilitiesToAbilitiesMap(
      options.capabilityRequest.resources,
    );
    const prepared = this.wasm.prepareSession({
      abilities,
      ...(options.rawAbilities !== undefined
        ? { rawAbilities: options.rawAbilities }
        : {}),
      address,
      chainId,
      domain: this.domain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId: options.spaceId,
      jwk,
      ...this.buildSiweOverrides(),
    });
    const signature = await this.requestSignature({
      address,
      chainId,
      message: prepared.siwe,
      type: "siwe",
      purpose: "bootstrap-session",
    });
    const session = this.wasm.completeSessionSetup({
      ...prepared,
      signature,
    });

    return {
      address,
      chainId,
      sessionKey: keyId,
      spaceId: options.spaceId,
      delegationCid: session.delegationCid,
      delegationHeader: session.delegationHeader,
      verificationMethod: this.sessionManager.getDID(keyId),
      jwk,
      siwe: prepared.siwe,
      signature,
    };
  }

  /**
   * Sign in and create a new session.
   *
   * This follows the correct SIWE-ReCap flow:
   * 1. Create session key and get JWK
   * 2. Call prepareSession() which generates the SIWE with ReCap capabilities
   * 3. Sign the SIWE string from prepareSession
   * 4. Call completeSessionSetup() with the prepared session + signature
   *
   * @param options - Optional per-call SIWE overrides for this sign-in only
   */
  async signIn(options?: SignInOptions): Promise<ClientSession> {
    // Get signer address and chain ID
    this._address = canonicalizeAddress(await this.signer.getAddress());
    this._chainId = await this.signer.getChainId();

    const address = this._address;
    const chainId = this._chainId;

    await this.resolveTinyCloudHostsForSignIn(address, chainId);

    // Create a session key
    const keyId = `session-${Date.now()}`;
    this.sessionManager.renameSessionKeyId(this.activeSessionKeyId, keyId);
    this.activeSessionKeyId = keyId;

    // Get JWK for session key
    const jwkString = this.sessionManager.jwk(keyId);
    if (!jwkString) {
      throw new Error("Failed to create session key");
    }
    const jwk = JSON.parse(jwkString);

    const capabilityPlan = this.resolveSignInCapabilities(address, chainId);
    const spaceId = capabilityPlan.spaceId;

    const now = new Date();
    const expirationTime = new Date(now.getTime() + this.sessionExpirationMs);

    // Prepare session - this creates the SIWE message with ReCap capabilities.
    //
    // When a manifest is installed, `resolveSignInAbilities()` returns
    // the union of app permissions + every manifest-declared
    // delegation's permissions in the shape `prepareSession` accepts.
    // Otherwise it returns `defaultActions` unchanged (legacy path).
    const prepared = this.wasm.prepareSession({
      abilities: capabilityPlan.abilities,
      ...(capabilityPlan.spaceAbilities !== undefined
        ? { spaceAbilities: capabilityPlan.spaceAbilities }
        : {}),
      ...(capabilityPlan.rawAbilities !== undefined
        ? { rawAbilities: capabilityPlan.rawAbilities }
        : {}),
      address,
      chainId,
      domain: this.domain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      jwk,
      ...this.buildSiweOverrides(options),
    });

    // Sign the SIWE message from prepareSession (NOT a separately generated SIWE)
    const signature = await this.requestSignature({
      address,
      chainId,
      message: prepared.siwe,
      type: "siwe",
      purpose: "sign-in",
    });

    // Complete session setup with the prepared session + signature
    const session = this.wasm.completeSessionSetup({
      ...prepared,
      signature,
    });

    // Create client session (web-core compatible)
    const clientSession: ClientSession = {
      address,
      walletAddress: address,
      chainId,
      sessionKey: keyId,
      siwe: prepared.siwe,
      signature,
    };

    // Compute additional spaces as metadata (not in the delegation itself).
    // The public space delegation is created lazily via ensurePublicSpace(),
    // not at signIn time, to avoid creating spaces the user may never use.
    const spacesMetadata: Record<string, string> | undefined = this
      .enablePublicSpace
      ? { public: makePkhSpaceId(address, chainId, "public") }
      : undefined;

    // Create TinyCloud session with full delegation data
    // Use sessionManager.getDID(keyId) for verificationMethod to get properly formatted DID URL
    // The prepared.verificationMethod from Rust WASM has a bug that doubles the DID fragment
    const tinyCloudSession: TinyCloudSession = {
      address,
      chainId,
      sessionKey: keyId,
      spaceId,
      spaces: spacesMetadata,
      delegationCid: session.delegationCid,
      delegationHeader: session.delegationHeader,
      verificationMethod: this.sessionManager.getDID(keyId),
      jwk,
      siwe: prepared.siwe,
      signature,
    };

    // Persist session with TinyCloud-specific data
    const persistedData: PersistedSessionData = {
      address,
      chainId,
      sessionKey: JSON.stringify(jwk),
      siwe: prepared.siwe,
      signature,
      tinycloudSession: {
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId,
        spaces: spacesMetadata,
        verificationMethod: this.sessionManager.getDID(keyId),
      },
      expiresAt: expirationTime.toISOString(),
      createdAt: now.toISOString(),
      version: "1.0",
      tinycloudHosts: this.tinycloudHosts,
    };
    await this.sessionStorage.save(address, persistedData);

    // Set current session
    this._session = clientSession;
    this._tinyCloudSession = tinyCloudSession;
    this._address = address;
    this._chainId = chainId;

    // Verify SDK-node protocol compatibility and discover supported features
    const infoHost = this.primaryTinyCloudHost;
    const nodeInfo = await checkNodeInfo(
      infoHost,
      this.wasm.protocolVersion(),
    );
    this._nodeFeatures = nodeInfo.features;
    // `/info` already told us the node DID. Keep it so encryption-network
    // admin invocations do not re-fetch `/info` just to learn it.
    this._nodeInfoIdentity = nodeInfo.nodeId
      ? { host: infoHost, nodeId: nodeInfo.nodeId }
      : undefined;

    // Call extension hooks
    for (const ext of this.extensions) {
      if (ext.afterSignIn) {
        await ext.afterSignIn(clientSession);
      }
    }

    // Ensure space exists (creates if needed when autoCreateSpace is true)
    await this.ensureSpaceExists();

    return clientSession;
  }

  /**
   * Sign out and clear the current session.
   */
  async signOut(): Promise<void> {
    if (this._address) {
      await this.clearPersistedSession(this._address);
    }
    this._session = undefined;
  }

  /**
   * Get the current wallet/signer address.
   */
  address(): string | undefined {
    return this._address;
  }

  /**
   * Get the current chain ID.
   */
  chainId(): number | undefined {
    return this._chainId;
  }

  /**
   * Sign a message with the connected signer.
   */
  async signMessage(
    message: string,
    purpose?: SignRequest["purpose"],
  ): Promise<string> {
    if (!this._address) {
      this._address = canonicalizeAddress(await this.signer.getAddress());
    }
    if (!this._chainId) {
      this._chainId = await this.signer.getChainId();
    }

    return this.requestSignature({
      address: this._address,
      chainId: this._chainId,
      message,
      type: "message",
      ...(purpose ? { purpose } : {}),
    });
  }

  /**
   * Prepare a session for external signing.
   *
   * Use this method when you need to sign the SIWE message externally (e.g., via
   * a hardware wallet, multi-sig, or external service). After obtaining the signature,
   * call `signInWithPreparedSession()` to complete the sign-in.
   *
   * @example
   * ```typescript
   * const { prepared, keyId, jwk } = await auth.prepareSessionForSigning();
   * const signature = await externalSigner.signMessage(prepared.siwe);
   * const session = await auth.signInWithPreparedSession(prepared, signature, keyId, jwk);
   * ```
   */
  async prepareSessionForSigning(): Promise<{
    prepared: {
      siwe: string;
      jwk: Record<string, unknown>;
      spaceId: string;
      verificationMethod: string;
    };
    keyId: string;
    jwk: Record<string, unknown>;
    address: string;
    chainId: number;
  }> {
    const address = canonicalizeAddress(await this.signer.getAddress());
    const chainId = await this.signer.getChainId();

    // Create a session key
    const keyId = `session-${Date.now()}`;
    this.sessionManager.renameSessionKeyId(this.activeSessionKeyId, keyId);
    this.activeSessionKeyId = keyId;

    // Get JWK for session key
    const jwkString = this.sessionManager.jwk(keyId);
    if (!jwkString) {
      throw new Error("Failed to create session key");
    }
    const jwk = JSON.parse(jwkString);

    const capabilityPlan = this.resolveSignInCapabilities(address, chainId);
    const spaceId = capabilityPlan.spaceId;

    const now = new Date();
    const expirationTime = new Date(now.getTime() + this.sessionExpirationMs);

    // Prepare session - this creates the SIWE message with ReCap capabilities.
    //
    // When a manifest is installed, `resolveSignInAbilities()` returns
    // the union of app permissions + every manifest-declared
    // delegation's permissions in the shape `prepareSession` accepts.
    // Otherwise it returns `defaultActions` unchanged (legacy path).
    const prepared = this.wasm.prepareSession({
      abilities: capabilityPlan.abilities,
      ...(capabilityPlan.spaceAbilities !== undefined
        ? { spaceAbilities: capabilityPlan.spaceAbilities }
        : {}),
      ...(capabilityPlan.rawAbilities !== undefined
        ? { rawAbilities: capabilityPlan.rawAbilities }
        : {}),
      address,
      chainId,
      domain: this.domain,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      jwk,
      ...this.buildSiweOverrides(),
    });

    return {
      prepared,
      keyId,
      jwk,
      address,
      chainId,
    };
  }

  /**
   * Complete sign-in with a prepared session and signature.
   *
   * Use this method after obtaining a signature for the SIWE message from
   * `prepareSessionForSigning()`. The signature MUST be over `prepared.siwe`.
   *
   * @param prepared - The prepared session from `prepareSessionForSigning()`
   * @param signature - The signature over `prepared.siwe`
   * @param keyId - The session key ID from `prepareSessionForSigning()`
   * @param jwk - The JWK from `prepareSessionForSigning()`
   */
  async signInWithPreparedSession(
    prepared: {
      siwe: string;
      jwk: Record<string, unknown>;
      spaceId: string;
      verificationMethod: string;
    },
    signature: string,
    keyId: string,
    jwk: Record<string, unknown>,
  ): Promise<ClientSession> {
    // Complete session setup with the prepared session + signature
    const session = this.wasm.completeSessionSetup({
      ...prepared,
      signature,
    });

    // Parse address and chainId from the prepared session
    // The SIWE message contains this info, but we need to extract it
    // For now, we'll get it from the signer since it should match
    const address = canonicalizeAddress(await this.signer.getAddress());
    const chainId = await this.signer.getChainId();

    await this.resolveTinyCloudHostsForSignIn(address, chainId);

    // Create client session (web-core compatible)
    const clientSession: ClientSession = {
      address,
      walletAddress: address,
      chainId,
      sessionKey: keyId,
      siwe: prepared.siwe,
      signature,
    };

    // Compute additional spaces as metadata (not in the delegation itself).
    const spacesMetadata: Record<string, string> | undefined = this
      .enablePublicSpace
      ? { public: makePkhSpaceId(address, chainId, "public") }
      : undefined;

    // Create TinyCloud session with full delegation data
    // Use sessionManager.getDID(keyId) for properly formatted DID URL
    const tinyCloudSession: TinyCloudSession = {
      address,
      chainId,
      sessionKey: keyId,
      spaceId: prepared.spaceId,
      spaces: spacesMetadata,
      delegationCid: session.delegationCid,
      delegationHeader: session.delegationHeader,
      verificationMethod: this.sessionManager.getDID(keyId),
      jwk,
      siwe: prepared.siwe,
      signature,
    };

    // Extract expiration from SIWE message (parse the string)
    const expirationMatch = prepared.siwe.match(/Expiration Time: (.+)/);
    const issuedAtMatch = prepared.siwe.match(/Issued At: (.+)/);
    const expiresAt =
      expirationMatch?.[1] ??
      new Date(Date.now() + this.sessionExpirationMs).toISOString();
    const createdAt = issuedAtMatch?.[1] ?? new Date().toISOString();

    // Persist session with TinyCloud-specific data
    const persistedData: PersistedSessionData = {
      address,
      chainId,
      sessionKey: JSON.stringify(jwk),
      siwe: prepared.siwe,
      signature,
      tinycloudSession: {
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: prepared.spaceId,
        spaces: spacesMetadata,
        verificationMethod: this.sessionManager.getDID(keyId),
      },
      expiresAt,
      createdAt,
      version: "1.0",
      tinycloudHosts: this.tinycloudHosts,
    };
    await this.sessionStorage.save(address, persistedData);

    // Set current session
    this._session = clientSession;
    this._tinyCloudSession = tinyCloudSession;
    this._address = address;
    this._chainId = chainId;

    // Verify SDK-node protocol compatibility and discover supported features
    const infoHost = this.primaryTinyCloudHost;
    const nodeInfo = await checkNodeInfo(
      infoHost,
      this.wasm.protocolVersion(),
    );
    this._nodeFeatures = nodeInfo.features;
    // `/info` already told us the node DID. Keep it so encryption-network
    // admin invocations do not re-fetch `/info` just to learn it.
    this._nodeInfoIdentity = nodeInfo.nodeId
      ? { host: infoHost, nodeId: nodeInfo.nodeId }
      : undefined;

    // Call extension hooks
    for (const ext of this.extensions) {
      if (ext.afterSignIn) {
        await ext.afterSignIn(clientSession);
      }
    }

    // Ensure space exists (creates if needed when autoCreateSpace is true)
    await this.ensureSpaceExists();

    return clientSession;
  }

  /**
   * End-to-end sign-in via OpenKey `authorizeTinyCloud()` (Sol CRITICAL-4).
   *
   * This is the production entry point that wires
   * {@link prepareSessionForSigning} → OpenKey `authorizeTinyCloud()` →
   * {@link signInWithOpenKeyResult} into one call. Consumers pass in a
   * caller-provided `authorizeFn` (typically a thin wrapper around
   * `openkey.authorizeTinyCloud()`) so this method has no direct
   * dependency on the OpenKey SDK — it works with any transport that
   * conforms to the versioned protocol.
   *
   * The `authorizeFn` MUST:
   *   1. Send the prepared SIWE bytes to OpenKey.
   *   2. Return the exact `TinyCloudAuthorizationResultV1` shape (with
   *      `signedMessage` — the bytes the signature actually verifies
   *      against — plus `selectedActionKeys` and `permissions`).
   *
   * NodeUserAuthorization then completes the session with `signedMessage`
   * (never the prepared bytes), verifying the signature, the immutable
   * SIWE fields, and every subset invariant enforced by
   * {@link signInWithOpenKeyResult}. This preserves the exact-byte
   * guarantee: if the user did NOT narrow, the returned `signedMessage`
   * equals the prepared SIWE byte-for-byte; if the user narrowed, only
   * the ReCap block differs and every immutable header field survives.
   *
   * Legacy exact-byte {@link signIn} callers are unaffected — this method
   * is opt-in.
   *
   * @param authorizeFn Callback that invokes the versioned OpenKey
   *   `authorizeTinyCloud()` protocol and returns the result. Receives
   *   the prepared SIWE bytes plus a `host` hint the widget should bind
   *   into its /authorize-sign-prepare context.
   * @param options Optional overrides for the OpenKey request.
   */
  async signInWithOpenKey(
    authorizeFn: (input: {
      protocolVersion: 1;
      siwe: string;
      jwk: Record<string, unknown>;
      host?: string;
      /**
       * Sol MAJOR-3: OpenKey key ID (managed or external key) to sign
       * with. When omitted, the OpenKey SDK falls back to the last
       * connected key. Callers who want to bind the flow to a specific
       * OpenKey key can override via options.openkeyKeyId; otherwise the
       * bridge relies on the SDK's connected-key state.
       */
      keyId?: string;
    }) => Promise<{
      protocolVersion: 1;
      address: string;
      signature: string;
      signedMessage: string;
      selectedActionKeys: string[];
      permissions: Array<{ service: string; space: string; path: string; actions: string[] }>;
    }>,
    options?: { host?: string; openkeyKeyId?: string },
  ): Promise<ClientSession> {
    // 1. Prepare — this creates a SIWE bound to a fresh session key.
    const { prepared, keyId, jwk } = await this.prepareSessionForSigning();

    // 2. Delegate signing to OpenKey via the caller-supplied bridge.
    //    We forward the JWK so the OpenKey server can regenerate a
    //    narrowed SIWE bound to the same session key when the user
    //    edits the review — and never a caller-echoed JWK.
    //
    //    We forward the TinyCloud host so the widget can bind it into
    //    its authorization context (Sol MAJOR-2). Falls back to the
    //    first resolved TinyCloud host when not overridden.
    //
    //    Sol MAJOR-3: forward an OpenKey keyId when the caller supplied
    //    one so the widget/SDK routes to the specific OpenKey key rather
    //    than the SDK's connected-key default.
    const hostHint = options?.host ?? this.tinycloudHosts?.[0];
    const result = await authorizeFn({
      protocolVersion: 1,
      siwe: prepared.siwe,
      jwk,
      host: hostHint,
      keyId: options?.openkeyKeyId,
    });

    // 3. Complete with the EXACT bytes OpenKey signed. Every subset
    //    invariant (immutable fields preserved, capabilities ⊆ prepared,
    //    selectedActionKeys grounded in signedMessage, permissions
    //    consistent) is enforced by signInWithOpenKeyResult before any
    //    session state is created.
    return this.signInWithOpenKeyResult(result, prepared, keyId, jwk);
  }

  /**
   * Complete sign-in with a versioned OpenKey authorization result.
   *
   * Where `signInWithPreparedSession` completes with a signature over the
   * ORIGINAL prepared SIWE, this method completes with the SIWE bytes the
   * OpenKey widget actually presented and signed (`signedMessage`). It
   * exists because the versioned authorizeTinyCloud protocol lets the user
   * narrow capabilities; the returned bytes may differ from the original
   * request and are the only ones the signature actually verifies against.
   *
   * The `result` parameter is validated at the trust boundary via
   * `validateAuthorizationResultV1` (in sdk-core). Callers should validate
   * BEFORE calling this method so unknown/missing fields are rejected
   * before any session state is created.
   *
   * Validation performed here (defence-in-depth: even a "valid" v1 payload
   * must clear these checks before any session state is created):
   * 1. `result.address` matches the local signer's address.
   * 2. `result.signature` recovers to `result.address` when verified against
   *    `result.signedMessage`.
   * 3. Every immutable SIWE header field (domain, address, URI, version,
   *    chainId, nonce, issuedAt) in the original prepared SIWE is preserved
   *    byte-for-byte in `result.signedMessage`. `statement` is NOT in this
   *    list because the WASM renders it from the ReCap contents; it MUST
   *    change when the ReCap is narrowed.
   * 4. Every capability in `result.signedMessage`'s ReCap block was present
   *    in the original prepared SIWE — narrowing OK, broadening rejected.
   * 5. Every `result.selectedActionKeys` entry corresponds to a
   *    (resource, action) pair in the returned SIWE.
   */
  async signInWithOpenKeyResult(
    result: {
      protocolVersion: 1;
      address: string;
      signature: string;
      signedMessage: string;
      selectedActionKeys: string[];
      permissions: Array<{ service: string; space: string; path: string; actions: string[] }>;
    },
    prepared: {
      /**
       * The ORIGINAL SIWE the SDK produced via {@link prepareSessionForSigning}.
       * Used as the source-of-truth reference for immutable-header and
       * capability-subset comparison against `result.signedMessage`.
       */
      siwe: string;
      jwk: Record<string, unknown>;
      spaceId: string;
      verificationMethod: string;
    },
    keyId: string,
    jwk: Record<string, unknown>,
  ): Promise<ClientSession> {
    if (result.protocolVersion !== 1) {
      throw new Error(`Unsupported OpenKey protocol version ${result.protocolVersion}`);
    }
    if (!result.signedMessage) {
      throw new Error("OpenKey result must include signedMessage");
    }
    if (!prepared.siwe) {
      throw new Error(
        "signInWithOpenKeyResult requires prepared.siwe (the SDK-generated SIWE the sign-in was proposed with)",
      );
    }
    // Verify the signer matches what we expect. If the address that signed
    // does not match the address the local signer will present, refuse the
    // session — the widget returned bytes signed by someone else.
    const expectedAddress = canonicalizeAddress(await this.signer.getAddress());
    if (canonicalizeAddress(result.address) !== expectedAddress) {
      throw new Error(
        `OpenKey returned signature from ${result.address} but expected ${expectedAddress}`,
      );
    }

    // (2) Recover the signer from the signature over the exact bytes we are
    // about to complete the session with. SiweMessage.verify() calls
    // ethers.verifyMessage(EIP4361Message, signature) internally and matches
    // the recovered address (case-insensitive) against the message's address
    // field. Any mismatch throws, which is exactly the failure mode we want.
    let parsedSignedSiwe: SiweMessage;
    try {
      parsedSignedSiwe = new SiweMessage(result.signedMessage);
    } catch (err) {
      throw new Error(
        `OpenKey signedMessage is not a parseable SIWE: ${(err as Error).message}`,
      );
    }
    const verifyResult = await parsedSignedSiwe.verify(
      { signature: result.signature },
      { suppressExceptions: true },
    );
    if (!verifyResult.success) {
      const errData = verifyResult.error;
      const type =
        errData && typeof errData === "object" && "type" in errData
          ? (errData as { type?: string }).type
          : undefined;
      const details =
        errData && typeof errData === "object" && "expected" in errData
          ? ` (expected=${(errData as { expected?: unknown }).expected}, received=${(errData as { received?: unknown }).received})`
          : "";
      throw new Error(
        `OpenKey signature verification failed${type ? `: ${type}` : ""}${details}`,
      );
    }
    // Belt-and-braces: the SIWE `address` field must match what OpenKey
    // reported and what the local signer will present. verify() checks
    // signature-vs-siwe-address; we additionally cross-check the caller's
    // claim and the local signer.
    if (
      canonicalizeAddress(parsedSignedSiwe.address) !== expectedAddress
    ) {
      throw new Error(
        `OpenKey signedMessage.address (${parsedSignedSiwe.address}) does not match local signer address (${expectedAddress})`,
      );
    }

    // (3) Immutable-fields comparison. Any drift on domain/address/URI/version/
    // chainId/nonce/issuedAt/statement means the widget is signing a materially
    // different SIWE than we prepared — potentially binding the session to a
    // different relying party or a different session key.
    const originalFields = extractImmutableSiweFields(prepared.siwe);
    const signedFields = extractImmutableSiweFields(result.signedMessage);
    const changedFields = diffImmutableSiweFields(originalFields, signedFields);
    if (changedFields.length > 0) {
      throw new Error(
        `OpenKey signedMessage altered immutable SIWE fields: ${changedFields.join(", ")}`,
      );
    }

    // (4) Capability subset. The widget may narrow the caller's request but
    // MUST NOT introduce (resource, action) pairs the caller never asked for.
    // Both sides are parsed from their `urn:recap:` resources.
    let originalCaps;
    let signedCaps;
    try {
      originalCaps = extractRecapAttenuations(prepared.siwe);
    } catch (err) {
      throw new Error(
        `Failed to decode prepared SIWE recap: ${(err as Error).message}`,
      );
    }
    try {
      signedCaps = extractRecapAttenuations(result.signedMessage);
    } catch (err) {
      throw new Error(
        `Failed to decode OpenKey signedMessage recap: ${(err as Error).message}`,
      );
    }
    const unauthorized = unauthorizedRecapCapabilities(signedCaps, originalCaps);
    if (unauthorized.length > 0) {
      const previewLimit = 5;
      const preview = unauthorized
        .slice(0, previewLimit)
        .map((u) => `${u.resource}::${u.action}`)
        .join(", ");
      const overflow =
        unauthorized.length > previewLimit
          ? ` (and ${unauthorized.length - previewLimit} more)`
          : "";
      throw new Error(
        `OpenKey signedMessage broadened authorization beyond the original request: ${preview}${overflow}`,
      );
    }

    // Structural check: the signed SIWE must reference the expected spaceId.
    // We accept a substring match because the spaceId appears inside the
    // ReCap capability list rather than as a distinct header.
    if (!result.signedMessage.includes(prepared.spaceId)) {
      throw new Error(
        `OpenKey signedMessage does not reference the expected spaceId ${prepared.spaceId}`,
      );
    }

    // (5) `selectedActionKeys` and `permissions` must EXACTLY reflect the
    // capabilities in signedMessage — anything less is a trust boundary
    // violation. Two rules:
    //
    // Rule A (selectedActionKeys covers signedCaps):
    //   If signedMessage grants capabilities beyond the structurally-required
    //   ones (currently `tinycloud.capabilities/read`), then `selectedActionKeys`
    //   MUST include a coverage entry for EVERY (resource, action) pair in
    //   signedCaps. Otherwise the client has no evidence that the SDK-visible
    //   selection matches the ReCap it is about to trust.
    //
    // Rule B (each selectedActionKeys entry is grounded in signedCaps):
    //   Every ID the widget returns must correspond to a real (resource, action)
    //   pair in signedCaps. Broadening rejected.
    //
    // Sol continuation contract: the CANONICAL OpenKey action ID format is
    // FOUR NUL-separated parts: `service\0space\0path\0ability`. The keys of
    // `signedCaps` are the raw ReCap resource URIs — `space` for whole-space
    // grants, or `space/path` when a path is present. The action key is
    // `ability` (e.g. `tinycloud.kv/get`). We build a canonical index of
    // granted authority keyed by the four-part tuple and REJECT
    // selectedActionKeys that do not conform to it. Legacy 2-part
    // `resource\0action` IDs are no longer accepted.
    const grantedPairs = new Set<string>();
    // 4-part index: `${service}\0${space}\0${path}\0${ability}` → canonical
    // resource\0action pair (used to populate the coverage-check set).
    // `service` is derived from the ability's namespace prefix
    // (`tinycloud.kv/get` → `tinycloud.kv`). `space` and `path` are derived
    // from the resource URI by splitting on the first `/` after the
    // `tinycloud:...:name` prefix.
    const grantedFourPartIndex = new Map<string, string>();
    for (const [resource, actions] of Object.entries(signedCaps)) {
      // Extract space/path from the resource URI.
      let space = resource;
      let path = "";
      if (resource.startsWith("tinycloud:")) {
        const slash = resource.indexOf("/");
        if (slash >= 0) {
          space = resource.slice(0, slash);
          path = resource.slice(slash + 1);
        }
      }
      for (const action of Object.keys(actions)) {
        // Populate the coverage set with the canonical resource\0action
        // pair so Rule A can check every non-required capability got
        // covered by a matching selectedActionKeys entry.
        grantedPairs.add(`${resource}\0${action}`);
        // Canonical four-part index: derive `service` from the ability
        // prefix. Missing prefix (bare action) is refused server-side
        // in OpenKey — we simply skip it here rather than fabricate a
        // half-form 4-part ID.
        const slashIdx = action.indexOf("/");
        const service = slashIdx > 0 ? action.slice(0, slashIdx) : "";
        if (service) {
          grantedFourPartIndex.set(
            `${service}\0${space}\0${path}\0${action}`,
            `${resource}\0${action}`,
          );
        }
      }
    }

    // Sol MAJOR-5: rich-result `permissions` MUST equal the signed
    // authority for EVERY resource/action pair, including structurally-
    // required capabilities. Removing required capabilities from the
    // coverage set let a widget silently omit them from the reported
    // grants — which is fine for user consent (the user cannot remove
    // them anyway) but a wire-format drift for the SDK's authoritative
    // return value. Callers that build a UI on top of `permissions` end
    // up under-reporting authority when required pairs are absent.
    // Track both the full set (for rich-result equality) and the
    // non-required set (retained for selectedActionKeys Rule A which
    // legitimately does not surface required pairs in the widget UI).
    const isStructurallyRequired = (action: string) =>
      action === "tinycloud.capabilities/read" || action === "capabilities/read";

    const nonRequiredGrantedPairs = new Set<string>();
    for (const pair of grantedPairs) {
      const idx = pair.indexOf("\0");
      const action = idx >= 0 ? pair.slice(idx + 1) : pair;
      if (!isStructurallyRequired(action)) {
        nonRequiredGrantedPairs.add(pair);
      }
    }
    // Sol MAJOR-5: the full granted-pair set — including required
    // capabilities — is what `permissions` must equal exactly.
    const allSignedGrantedPairs = new Set<string>(grantedPairs);

    // Rule B — validate each returned selectedActionKeys entry.
    // Build a set of grounded pairs so we can also enforce Rule A.
    // Sol MAJOR-4: dedupe using the raw key first — duplicates in the
    // client-supplied selection would let a subset be reported as
    // full coverage. Callers must send each ID exactly once.
    const seenRawKeys = new Set<string>();
    for (const rawKey of result.selectedActionKeys) {
      if (seenRawKeys.has(rawKey)) {
        throw new Error(
          `OpenKey selectedActionKeys contains duplicate entry ${rawKey}`,
        );
      }
      seenRawKeys.add(rawKey);
    }
    const selectedResourceActionPairs = new Set<string>();
    for (const rawKey of result.selectedActionKeys) {
      const parts = rawKey.split("\0");
      // Sol continuation contract: OpenKey emits ONLY the canonical
      // four-part `service\0space\0path\0ability` shape. Legacy 2-part
      // IDs are no longer accepted — the previous fallback let a
      // malicious widget forward a `resource\0action` pair that matched
      // by suffix without proving service canonicalization, which
      // silently expanded authority when service short-names collided.
      if (parts.length !== 4) {
        throw new Error(
          `OpenKey selectedActionKeys entry is malformed (expected canonical 4-part service\\0space\\0path\\0ability): ${rawKey}`,
        );
      }
      const canonical = grantedFourPartIndex.get(rawKey);
      if (!canonical) {
        throw new Error(
          `OpenKey selectedActionKeys entry ${rawKey} is not covered by any granted capability`,
        );
      }
      selectedResourceActionPairs.add(canonical);
    }

    // Rule A — every non-required granted pair MUST be covered by at least
    // one selectedActionKeys entry. If nonRequiredGrantedPairs is empty
    // (e.g. bootstrap-only session), we do not require selectedActionKeys
    // to be non-empty. If it is non-empty, the widget must have returned
    // selection metadata for every non-required capability the user was
    // shown; anything else is a UI/wire drift.
    if (nonRequiredGrantedPairs.size > 0) {
      const missingPairs: string[] = [];
      for (const pair of nonRequiredGrantedPairs) {
        if (!selectedResourceActionPairs.has(pair)) {
          missingPairs.push(pair);
        }
      }
      if (missingPairs.length > 0) {
        const previewLimit = 5;
        const preview = missingPairs
          .slice(0, previewLimit)
          .map((p) => p.replace("\0", "::"))
          .join(", ");
        const overflow =
          missingPairs.length > previewLimit
            ? ` (and ${missingPairs.length - previewLimit} more)`
            : "";
        throw new Error(
          `OpenKey selectedActionKeys is missing entries for signedMessage capabilities: ${preview}${overflow}`,
        );
      }
    }

    // Sol MAJOR-4: rich-result permissions MUST exactly equal the signed
    // authority. Strict rules:
    //   1. If the signed SIWE grants any capabilities, `permissions` MUST
    //      cover ALL of them — an empty `permissions` array with a
    //      capability-bearing SIWE is a wire-format drift and is rejected.
    //   2. Every permission entry MUST have a non-empty actions[].
    //   3. Every (permission, action) pair MUST resolve to a real
    //      (resource, action) pair in signedCaps via a CANONICAL
    //      resolution — no substring fallback (which would let a
    //      permission on `space` match a resource on `space/leaked/path`
    //      and silently expand authority to unintended paths).
    //   4. Permission entries MUST be duplicate-free after canonical
    //      normalization; duplicates would let the same authority be
    //      reported twice and mask a missing entry.
    // Sol MAJOR-5: reject empty `permissions` for a capability-bearing
    // SIWE regardless of whether the pairs are structurally required.
    // A signed SIWE with any granted authority MUST come back with a
    // matching non-empty permissions[] — otherwise the SDK cannot
    // reconcile local state with what was actually signed.
    if (
      allSignedGrantedPairs.size > 0 &&
      result.permissions.length === 0
    ) {
      throw new Error(
        "OpenKey permissions is empty but signedMessage carries capabilities — refusing to accept a session without an authoritative grant list",
      );
    }
    const permissionCanonicalKeys = new Set<string>();
    const permissionPairsCovered = new Set<string>();
    for (const perm of result.permissions) {
      const { service, space, path, actions } = perm;
      if (typeof service !== "string" || typeof space !== "string" || typeof path !== "string") {
        throw new Error(
          `OpenKey permissions entry has non-string service/space/path (service=${service}, space=${space}, path=${path})`,
        );
      }
      if (!Array.isArray(actions) || actions.length === 0) {
        throw new Error(
          `OpenKey permissions entry (${service} ${space} ${path}) has empty actions — a capability-bearing entry must list at least one action`,
        );
      }
      const canonicalKey = `${service}\0${space}\0${path}`;
      if (permissionCanonicalKeys.has(canonicalKey)) {
        throw new Error(
          `OpenKey permissions has duplicate entry for (${service} ${space} ${path})`,
        );
      }
      permissionCanonicalKeys.add(canonicalKey);

      // Canonical resource resolution. When path is empty, the only
      // valid form is `space`. When path is non-empty, the only valid
      // form is `space/path`. Both are ReCap-valid — but for a given
      // (space, path) tuple exactly one form is expected. We refuse
      // substring fallback so a permission on `space` cannot silently
      // match a `space/leaked/path` resource.
      let matchedResource: string;
      if (path) {
        const withPathKey = `${space}/${path}`;
        if (signedCaps[withPathKey] !== undefined) {
          matchedResource = withPathKey;
        } else {
          throw new Error(
            `OpenKey permissions entry (${service} ${space} ${path}) claims grants not confirmed in signedMessage capabilities`,
          );
        }
      } else {
        if (signedCaps[space] !== undefined) {
          matchedResource = space;
        } else {
          throw new Error(
            `OpenKey permissions entry (${service} ${space} ${path}) claims grants not confirmed in signedMessage capabilities`,
          );
        }
      }
      const grantedActionsForResource = new Set(
        Object.keys(signedCaps[matchedResource]),
      );
      for (const action of actions) {
        if (typeof action !== "string" || !action) {
          throw new Error(
            `OpenKey permissions entry (${service} ${space} ${path}) has non-string action ${String(action)}`,
          );
        }
        if (!grantedActionsForResource.has(action)) {
          throw new Error(
            `OpenKey permissions entry (${service} ${space} ${path}) claims action ${action} not present in signedMessage capabilities`,
          );
        }
        permissionPairsCovered.add(`${matchedResource}\0${action}`);
      }
    }
    // Sol MAJOR-5: EXACT equality between `permissions` coverage and the
    // signed authority — for every resource/action pair, including
    // structurally-required ones. Any missing or extra pair is a
    // wire-format drift and the SDK refuses to build a session state
    // that does not match the signed bytes byte-for-byte.
    if (allSignedGrantedPairs.size > 0) {
      const missingFromPerms: string[] = [];
      for (const pair of allSignedGrantedPairs) {
        if (!permissionPairsCovered.has(pair)) {
          missingFromPerms.push(pair);
        }
      }
      if (missingFromPerms.length > 0) {
        const previewLimit = 5;
        const preview = missingFromPerms
          .slice(0, previewLimit)
          .map((p) => p.replace("\0", "::"))
          .join(", ");
        const overflow =
          missingFromPerms.length > previewLimit
            ? ` (and ${missingFromPerms.length - previewLimit} more)`
            : "";
        throw new Error(
          `OpenKey permissions is missing entries for signedMessage capabilities: ${preview}${overflow}`,
        );
      }
      const extrasInPerms: string[] = [];
      for (const pair of permissionPairsCovered) {
        if (!allSignedGrantedPairs.has(pair)) {
          extrasInPerms.push(pair);
        }
      }
      if (extrasInPerms.length > 0) {
        const previewLimit = 5;
        const preview = extrasInPerms
          .slice(0, previewLimit)
          .map((p) => p.replace("\0", "::"))
          .join(", ");
        const overflow =
          extrasInPerms.length > previewLimit
            ? ` (and ${extrasInPerms.length - previewLimit} more)`
            : "";
        throw new Error(
          `OpenKey permissions contains entries not present in the signed authority: ${preview}${overflow}`,
        );
      }
    }
    // Retain nonRequiredGrantedPairs reference so tsc doesn't drop it.
    void nonRequiredGrantedPairs;

    return this.signInWithPreparedSession(
      {
        siwe: result.signedMessage,
        jwk: prepared.jwk,
        spaceId: prepared.spaceId,
        verificationMethod: prepared.verificationMethod,
      },
      result.signature,
      keyId,
      jwk,
    );
  }

  /**
   * Clear persisted session data.
   */
  async clearPersistedSession(address?: string): Promise<void> {
    const targetAddress = address ?? this._address;
    if (targetAddress) {
      await this.sessionStorage.clear(targetAddress);
    }
  }

  /**
   * Check if a session is persisted for an address.
   */
  isSessionPersisted(address: string): boolean {
    return this.sessionStorage.exists(address);
  }

  /**
   * Request a signature based on the configured strategy.
   */
  private async requestSignature(request: SignRequest): Promise<string> {
    switch (this.signStrategy.type) {
      case "auto-sign":
        return this.signer.signMessage(request.message);

      case "auto-reject":
        throw new Error("Sign request rejected by auto-reject strategy");

      case "callback": {
        const response = await this.signStrategy.handler(request);
        if (!response.approved) {
          throw new Error(
            response.reason ?? "Sign request rejected by callback",
          );
        }
        // If callback provides signature, use it; otherwise sign with signer
        return (
          response.signature ?? (await this.signer.signMessage(request.message))
        );
      }

      case "event-emitter": {
        return this.requestSignatureViaEmitter(
          request,
          this.signStrategy.emitter,
          this.signStrategy.timeout ?? 60000,
        );
      }

      default:
        throw new Error(
          `Unknown sign strategy: ${(this.signStrategy as any).type}`,
        );
    }
  }

  /**
   * Request signature via event emitter with timeout.
   */
  private requestSignatureViaEmitter(
    request: SignRequest,
    emitter: EventEmitter,
    timeout: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("Sign request timed out"));
      }, timeout);

      const respond = async (response: SignResponse) => {
        clearTimeout(timeoutId);
        if (!response.approved) {
          reject(
            new Error(response.reason ?? "Sign request rejected via emitter"),
          );
        } else {
          // If response provides signature, use it; otherwise sign with signer
          const signature =
            response.signature ??
            (await this.signer.signMessage(request.message));
          resolve(signature);
        }
      };

      emitter.emit("sign-request", request, respond);
    });
  }
}
