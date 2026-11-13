/**
 * TinyCloudWeb — thin browser wrapper around TinyCloudNode.
 *
 * All core logic (auth, services, delegations) is handled by TinyCloudNode.
 * This wrapper provides:
 * - Browser-specific adapters (wallet signer, notifications, WASM bindings)
 * - The familiar TinyCloudWeb public API surface
 * - Static receiveShare() using browser WASM
 *
 * @packageDocumentation
 */

import {
  activateCompactRuntimeDelegation as activateCompactRuntimeDelegationOnNode,
  activateValidatedRuntimeDelegation as activateValidatedRuntimeDelegationOnNode,
  RuntimeDelegationRejectedError,
  TinyCloudNode,
  TinyCloudNodeConfig,
  wireOpenKeyAuthorize,
  type OpenKeyAuthorizeTinyCloud,
  type PreparedOpenKeyAuthorization,
  type BootstrapWarning,
  type DelegateToOptions,
  type DelegateToResult,
  type ISessionStorage,
  type PersistedSessionData,
  type SignStrategy,
  type ValidatedRuntimeDelegation,
  type UnifiedOwnerRootInput,
  type UnifiedOwnerRootReceipt,
  type RegisterPolicyV3Input,
  type RegisterPolicyV3Receipt,
  refuseCaveated,
} from "@tinycloud/node-sdk/core";
import {
  resolveReplicationConfig,
  validateReplicationConfig,
  type LocalCopyPurgeFailedEvent,
} from "./replica-wiring";
import {
  invalidateOwnSession,
  IKVService,
  ISQLService,
  IDuckDbService,
  IDataVaultService,
  ISecretsService,
  ISpaceService,
  ISpace,
  ISharingService,
  ICapabilityKeyRegistry,
  IHooksService,
  IEncryptionService,
  DelegationManager,
  Delegation,
  DelegationRevocationReceipt,
  CreateDelegationParams,
  Result,
  DelegationError,
  DelegationResult,
  ClientSession,
  Extension,
  type TelemetryConfig,
  type RetryPolicy,
  ISpaceCreationHandler,
  type Manifest,
  type ComposedManifestRequest,
  type AccountService,
  type ResolvedDelegate,
  type PermissionEntry,
  type ResourceCapability,
  type NetworkDescriptor,
  type CreateOwnerDelegationParams,
  type OwnerDelegationReceipt,
  type LocalNodeIdentityStore,
  type OnNodeNotFound,
  type RegistrySequenceStore,
  SignInOptions,
  ACCOUNT_MANIFEST_PERMISSIONS,
  composeManifestRequest,
  createLocalStorageLocalNodeIdentityStore,
  createLocalStorageRegistrySequenceStore,
  createLocalStorageRegistryCacheStore,
  type RegistryCacheStore,
  type StorageFullEvent,
  type IStorageService,
} from "@tinycloud/sdk-core";
import { routingFailure } from "@tinycloud/sdk-services";
import { closeActiveModal, showPermissionRequestModal } from "../notifications/lazy-prompts";
import { applyLegacyNotificationKeys } from "../notifications/legacy-config";
import {
  requestPermissionsCore,
  validateAdditionalPermissions,
  type RequestPermissionsOptions,
} from "./requestPermissionsCore";
import {
  isPermissionPromptSuppressed,
  suppressPermissionPromptFor30Days,
} from "./permissionPromptSuppression";
import {
  clientSessionFromPersisted,
  restoreDataFromPersisted,
} from "./browserSessionPersistence";
import { WebSecretsService } from "./WebSecretsService";
import {
  type BrowserProvider,
  type BrowserWalletProvider,
} from "../adapters/browserProvider";

import { BrowserWalletSigner } from "../adapters/BrowserWalletSigner";
import { BrowserNotificationHandler } from "../adapters/BrowserNotificationHandler";
import { registerUiClient, type TinyCloudUI, type UiClientHandle, type UiConfig } from "../ui";
import type { ToastSink } from "../ui/toast-store";
import { BrowserWasmBindings } from "../adapters/BrowserWasmBindings";
import { BrowserENSResolver } from "../adapters/BrowserENSResolver";
import {
  BrowserSessionStorage,
  type BrowserSessionLoadResult,
} from "../adapters/BrowserSessionStorage";
import { isPanelResourceSet, rememberRuntimeGrants, reuseRuntimeGrants, serializeRuntimeGrantMutation, type RuntimeGrantStore } from "./runtimeGrantPersistence";
import { RPCProviders, ClientConfig, Extension as ExtensionType } from "../providers";
import { resolveSpaceCreationHandler } from "../authorization/WebSpaceCreationHandler";
import { resolveOpenKeySigningKey, type OpenKeyConnection } from "../openkey-signing-key";
import type { NotificationConfig } from "../notifications/types";
import type { PortableDelegation, DelegatedAccess, SpaceHosting } from "@tinycloud/node-sdk/core";
import { CredentialsService } from "../credentials";
import { ShareReceiverService, type ShareReceiverServiceOptions } from "../share";

declare global {
  interface Window {
    ethereum?: any;
  }
}

// Config

/** Signs a message for a runtime permission grant; see `TinyCloudWeb.setRuntimePermissionSigner`. */
export interface RuntimePermissionSigner {
  signMessage(message: string): Promise<string>;
}

/** The byte-exact message signing the OpenKey SDK's `OpenKey` class offers beside `authorizeTinyCloud`. The SDK always sends a `keyId`. */
interface OpenKeyMessageSigner extends OpenKeyConnection {
  signMessage?: (
    request: { message: string; keyId: string },
    opts?: { mode?: "iframe" | "popup" | "redirect" },
  ) => Promise<{ signature: string }>;
}

/**
 * Configuration for TinyCloudWeb.
 *
 * Extends ClientConfig with browser-specific options.
 */
export interface Config extends ClientConfig {
  /** Write TCW2 network-key wraps. Disabled by default. */
  keyWrapV2?: boolean;
  /** Require TCW2 incoming network-key wraps, not signed receiver responses. Disabled by default. */
  requireKeyWrapV2?: boolean;
  /** Refuse explicitly designated legacy plaintext columns. Disabled by default. */
  strictEncryption?: boolean;
  /**
   * OpenKey authorize-sign client. Requires @openkey/sdk >=0.12.2; popup is the default mode.
   *
   * `expiryChangeable: true` asks OpenKey to let the user change the session expiry in the approval. The SDK then
   * accepts the changed expiry and builds the session with the SIGNED value. It is a pass-through: `@openkey/sdk`
   * >= 0.13.0 (beta: 0.13.0-beta.0) forwards it; it is inert on 0.12.x, so the expiry stays as requested.
   */
  openkey?: {
    client: OpenKeyAuthorizeTinyCloud;
    mode?: "iframe" | "popup" | "redirect";
    expiryChangeable?: boolean;
    /**
     * With `expiryChangeable`: the latest expiry you will accept. A signed expiry beyond it is refused before the
     * session is built or stored. Epoch MILLISECONDS or a `Date`; a function is called when the approval comes back, so
     * a slow approval does not count against it. It is never sent to OpenKey. It limits a CHANGED expiry only, so keep
     * `sessionExpirationMs` within it.
     */
    maxExpiresAt?: number | Date | (() => number | Date);
  };
  /** Notifications. `throwErrors` rethrows each error's raw message asynchronously, once per burst of identical errors (200 ms window). It applies unless `ui: false` or `ui.toasts: false`, which turn off toasts and throws together, as the old `popups: false` did; `ui.button: false` leaves throws on. Toast placement and visibility are set through `ui`. */
  notifications?: NotificationConfig;

  /** Optional prefix for KV service keys */
  kvPrefix?: string;

  /** Prefix for space names when creating spaces */
  spacePrefix?: string;
  /** Local KV replication. Off unless set; node-sdk validates the config and owns the storage. */
  replication?: TinyCloudNodeConfig["replication"];

  /** Explicit host hints for owners absent from both registry namespaces. Signed v2 entries select their own hosts. */
  tinycloudHosts?: string[];
  /** TinyCloud location registry URL. Default: https://registry.tinycloud.xyz. */
  tinycloudRegistryUrl?: string | null;
  /** Host hint for owners absent from both v2 and v1 registries. Default https://node.tinycloud.xyz; null disables onboarding. */
  newUserHost?: string | null;
  /** Chain ID used to distinguish a v1-only owner from an owner with no registry entry. Default 1. */
  registryChainId?: number;
  /** Highest signed v2 sequence seen per owner. Default: a `localStorage`-backed store. */
  registrySequenceStore?: RegistrySequenceStore;
  /** Exact signed responses in browser storage, reverified on every routing read. */
  registryCacheStore?: RegistryCacheStore;
  /** Called after an actual cached-settings or default-node fallback. */
  onRegistryFallback?: TinyCloudNodeConfig["onRegistryFallback"];
  /** Called only when no host resolves for a genuinely unregistered owner. */
  onNodeNotFound?: OnNodeNotFound;
  /** Probe local nodes only for owners absent from both registry namespaces. Default: true. */
  autoDiscoverLocalNode?: boolean;
  /** Local loopback node URL to probe. Omit to avoid probing loopback. */
  localNodeUrl?: string;
  /** Known `*.local.tinycloud.link` subdomain name, probed directly. */
  localLinkName?: string;
  /** Expected local node DID. A locally-discovered node whose DID differs is rejected. */
  expectedNodeDid?: string;
  /**
   * Pin store for trust-on-first-use local node identity verification.
   * Defaults to a `localStorage`-backed store (namespaced, falls back to
   * in-memory when `localStorage` is unavailable).
   */
  localNodeIdentityStore?: LocalNodeIdentityStore;

  /**
   * How the user's space is created on sign-in when it does not exist yet.
   *
   * - unset (default): confirm in a `<tinycloud-space-modal>` dialog first.
   * - `true`: create it without asking. No dialog is shown, so sign-in cannot
   *   block on one.
   * - `false`: never create it. Sign-in continues without a primary space,
   *   which is what you want when the app only ever uses delegated spaces.
   *
   * Ignored when {@link Config.spaceCreationHandler} is set.
   */
  autoCreateSpace?: boolean;

  /** Space creation handler (default: ModalSpaceCreationHandler) */
  spaceCreationHandler?: ISpaceCreationHandler;

  /**
   * How long the default space-creation dialog waits for the user before
   * failing sign-in, in milliseconds (default: 120000). Only applies when the
   * modal handler is in use.
   */
  spaceCreationTimeoutMs?: number;

  /** Session expiration time in milliseconds (default: 30 days, `EXPIRY.SESSION_MS`) */
  sessionExpirationMs?: number;

  /** Persist browser sessions so signIn() can restore before prompting. Default true. */
  persistSession?: boolean;
  /** Custom session storage implementation. */
  sessionStorage?: ISessionStorage;
  /** Whether to run node-sdk's canonical first-account bootstrap after sign-in. */
  autoBootstrapAccount?: boolean;
  /** Browser storage key prefix for isolating apps/environments. */
  sessionStorageKeyPrefix?: string;

  /** SIWE domain (default: window.location.host in browser, app.tinycloud.xyz otherwise) */
  domain?: string;

  /** Shorthand for passing a Web3 provider */
  provider?: any;

  /**
   * App manifest used for sign-in and escalation flows. When set,
   * the SIWE recap issued at sign-in covers the union of the app's
   * own permissions and every manifest-declared delegation's
   * permissions — which is what enables
   * `tcw.delegateTo(manifestDeclaredDid, permissions)` to run via
   * the session-key UCAN path (no wallet prompt).
   *
   * When provided, {@link TinyCloudWeb.requestPermissions} uses the
   * manifest's `name` and `icon` to title the permission modal. The
   * manifest is forwarded into the underlying {@link TinyCloudNode}
   * so `signIn()` drives its SIWE recap from it directly.
   */
  manifest?: Manifest | Manifest[];
  /** Pre-composed manifest request. Takes precedence over `manifest`. */
  capabilityRequest?: ComposedManifestRequest;
  /** Strategy for TinyCloud root signature requests. */
  signStrategy?: SignStrategy;
  /** Include canonical account registry read/create-update/list permissions in plain sessions and composed manifests. Default true. */
  includeAccountRegistryPermissions?: boolean;
  /** Default-off service telemetry. */
  telemetry?: TelemetryConfig;
  /** Retry of node busy/timeout answers; `{ maxAttempts: 1 }` disables it. See {@link RetryPolicy}. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Accountless share receiver transport and session-custody configuration. */
  shareReceiver?: ShareReceiverServiceOptions;
  /** Floating button, panel, and toasts. `false` creates no host, button, toasts, or listeners. See {@link UiConfig}. */
  ui?: UiConfig | false;
}

/**
 * Result of {@link TinyCloudWeb.requestPermissions}. On approve, `session`
 * is the current session that received the runtime permission delegation.
 * On decline, `session` is omitted so callers can branch on `approved`.
 */
export interface RequestPermissionsResult {
  approved: boolean;
  session?: ClientSession;
  delegations?: readonly PortableDelegation[];
}

export type SessionRestoreStatus =
  | "idle"
  | "disabled"
  | "restoring"
  | "restored"
  | "missing"
  | "expired"
  | "corrupt"
  | "storage-unavailable"
  | "restore-failed"
  | "stale"
  | "logging-in";

export interface SessionRestoreResult {
  status: Exclude<SessionRestoreStatus, "idle" | "restoring" | "logging-in">;
  session?: ClientSession;
  error?: Error;
}


// Share Link Utilities (static, no auth required)

/** A session storage that can fence a signed-out session (BrowserSessionStorage); others rely on the in-memory block. */
export type FenceCapableStorage = ISessionStorage & {
  markSignedOut?: (address: string, signature: string) => void;
  isSignedOut?: (address: string, signature: string) => boolean;
};


/**
 * Result of receiving a share link.
 */
export interface ShareReceiveResult<T = unknown> {
  data: T;
  delegation: Delegation;
  path: string;
  spaceId: string;
  /** Identity-checked registry destination where the verified parent was activated. */
  host: string;
}

// TinyCloudWeb

export class TinyCloudWeb {
  private openkeySignInInFlight = 0;
  private prepareSignInToken = 0;
  /** Time bound for the background hosting probe. */
  private spaceHostingCapMs = 5_000;
  private restoredNetworkWork?: {
    hosting: Promise<void>;
    grants: Promise<void>;
    cachedHosting: SpaceHosting;
    isCurrent(): boolean;
  };
  private preparedSignIn?: {
    node: TinyCloudNode;
    request: PreparedOpenKeyAuthorization;
    createdAt: number;
    signOuts: number;
  };

  private invalidatePreparedSignIn(): void {
    this.prepareSignInToken++;
    this.preparedSignIn = undefined;
  }
  /** The connected wallet's raw EIP-1193 provider. */
  public provider!: BrowserProvider;

  /** The normalized EIP-1193 provider used by the SDK. */
  public eip1193Provider!: BrowserProvider;

  /** Supported RPC Providers */
  public static RPCProviders = RPCProviders;

  /** Underlying TinyCloudNode (created after WASM init) */
  private _node: TinyCloudNode | null = null;
  private readonly uiClient: UiClientHandle;
  /** Listeners for the own-storage episode, forwarded from the current node. */
  private readonly storageEpisodeListeners = new Set<() => void>();
  /** Listeners for a delegated owner's storage being found full, forwarded from the current node. */
  private readonly delegatedStorageListeners = new Set<() => void>();
  /** The episode the UI reads. Lazy: the node is created after UI registration. */
  private readonly uiStorageEpisode = {
    current: () => this._node?.storageEpisode.current(),
    subscribe: (listener: () => void) => {
      this.storageEpisodeListeners.add(listener);
      return () => {
        this.storageEpisodeListeners.delete(listener);
      };
    },
    subscribeDelegated: (listener: () => void) => {
      this.delegatedStorageListeners.add(listener);
      return () => {
        this.delegatedStorageListeners.delete(listener);
      };
    },
  };

  /** Shows a toast in this instance's host. Returns false when nothing was shown. */
  private readonly showToast: ToastSink = (request) => this.uiClient.toast(request);

  /** Browser notification handler */
  private notificationHandler: BrowserNotificationHandler;

  /** Browser WASM bindings */
  private wasmBindings: BrowserWasmBindings;

  /** Browser wallet signer */
  private walletSigner?: BrowserWalletSigner;
  private sessionStorage?: ISessionStorage;
  private _sessionRestoreStatus: SessionRestoreStatus = "idle";
  /** Incremented by signOut; a sign-in that started before it does not complete. */
  private signOutCount = 0;
  /** The signer set with `setRuntimePermissionSigner`, with the session it was set for. */
  private runtimeSigner?: { readonly signer: RuntimePermissionSigner; readonly address: string; readonly signOuts: number };
  private signOutInFlight = 0;
  private signOutOperation?: { node?: TinyCloudNode; remote?: Promise<void>; result: Promise<void> };
  private persistedRestoreBlocked = false;
  private signOutCleanupFailed = false;
  private remoteSignOutTimeoutMs = 3000;
  private readonly pendingRestoreAddresses = new Map<string, number>();
  private _secrets = new Map<string, ISecretsService>();
  private _credentialsService?: CredentialsService;
  private _shareReceiverService?: ShareReceiverService;
  private readonly storageFullHandlers = new Set<(event: StorageFullEvent) => void>();
  private readonly purgeFailedHandlers = new Set<(event: LocalCopyPurgeFailedEvent) => void>();

  /** Promise that resolves when WASM + node are ready */
  private _initPromise: Promise<void>;

  /** User config */
  private config: Config;

  /**
   * App manifest stored from config (or updated via `setManifest`).
   *
   * `requestPermissions` reads this for the modal title/icon. `_init`
   * forwards this value into the underlying {@link TinyCloudNode} so
   * `signIn()` drives its SIWE recap from the manifest. `setManifest`
   * mirrors any post-construction updates onto the node so the next
   * sign-in picks them up.
   */
  private _manifest?: Manifest | Manifest[];
  private _capabilityRequest?: ComposedManifestRequest;

  private resetSessionScopedCaches(): void {
    this._secrets.clear();
  }

  /**
   * Test hook — override the modal shower and sign-in function used by
   * {@link requestPermissions}. Not part of the public API. Tests set
   * these via `(tcw as any)._testHooks = { ... }` so they can exercise
   * the escalation control flow without a real DOM or wallet.
   *
   * @internal
   */
  private _testHooks?: {
    showModal?: (opts: {
      appName: string;
      appIcon?: string;
      additional: PermissionEntry[];
    }) => Promise<{
      approved: boolean;
      suppressPromptFor30Days?: boolean;
    }>;
    hasRuntimePermissions?: (additional: PermissionEntry[]) => boolean;
    grantPermissions?: (
      additional: PermissionEntry[],
      options?: RequestPermissionsOptions,
    ) => Promise<readonly PortableDelegation[] | void>;
  };

  constructor(callerConfig: Config = {}) {
    const config = applyLegacyNotificationKeys(callerConfig);
    validateReplicationConfig(config);
    this.config = config;
    this._manifest = config.manifest;
    this._capabilityRequest = config.capabilityRequest;

    this.uiClient = registerUiClient({
      ui: config.ui,
      source: {
        signedIn: () => this.session() !== undefined,
        waitForAccountRegistrySync: () => this._node?.waitForAccountRegistrySync() ?? Promise.resolve(),
        storage: { status: () => this.storage.status() },
        storageEpisode: this.uiStorageEpisode,
        canRequestPermissions: () => this.canRequestPanelPermissions(),
        requestPermissions: (entries, options) => this.requestPanelPermissions(entries, options),
        signOut: this.signOut,
      },
      manifestAppId: () => {
        const manifest = this._manifest;
        const fromManifest = (Array.isArray(manifest) ? manifest[0] : manifest)?.app_id;
        return fromManifest ?? this._capabilityRequest?.manifests[0]?.app_id;
      },
      manifestName: () => ((Array.isArray(this._manifest) ? this._manifest[0] : this._manifest) ?? this._capabilityRequest?.manifests[0])?.name,
    });

    // Initialize browser notification handler
    // With `notifications.throwErrors`, error events rethrow even when no toast is shown.
    this.notificationHandler = new BrowserNotificationHandler(
      this.showToast,
      this.config.notifications?.throwErrors === true && this.config.ui !== false && this.config.ui?.toasts !== false,
    );

    // Create browser WASM bindings
    this.wasmBindings = new BrowserWasmBindings();

    if (config.persistSession !== false) {
      this.sessionStorage =
        config.sessionStorage ??
        new BrowserSessionStorage({
          keyPrefix: config.sessionStorageKeyPrefix,
        });
    }

    // Set up browser wallet signer if provider given
    const providerDriver = config.provider ?? config.providers?.web3?.driver;
    if (providerDriver) {
      this.walletSigner = new BrowserWalletSigner(providerDriver);
      this.provider = this.walletSigner.getProvider();
      this.eip1193Provider = this.provider;
    }

    // Start async initialization (WASM + TinyCloudNode creation)
    this._initPromise = this._init();
  }

  /**
   * Async initialization: ensure WASM is ready, then create TinyCloudNode.
   * @internal
   */
  private async _init(): Promise<void> {
    await this.wasmBindings.ensureInitialized();
    const loc = typeof window !== 'undefined' ? window.location : undefined;

    const nodeConfig: TinyCloudNodeConfig = {
      keyWrapV2: this.config.keyWrapV2 ?? false,
      requireKeyWrapV2: this.config.requireKeyWrapV2 ?? false,
      strictEncryption: this.config.strictEncryption ?? false,
      host: this.config.tinycloudHosts?.[0],
      tinycloudRegistryUrl: this.config.tinycloudRegistryUrl,
      newUserHost: this.config.newUserHost,
      registryChainId: this.config.registryChainId,
      registrySequenceStore:
        this.config.registrySequenceStore ??
        createLocalStorageRegistrySequenceStore(),
      registryCacheStore: this.config.registryCacheStore ?? createLocalStorageRegistryCacheStore(),
      onNodeNotFound: this.config.onNodeNotFound,
      onRegistryFallback: this.config.onRegistryFallback,
      autoDiscoverLocalNode: this.config.autoDiscoverLocalNode,
      localNodeUrl: this.config.localNodeUrl,
      localLinkName: this.config.localLinkName,
      expectedNodeDid: this.config.expectedNodeDid,
      localNodeIdentityStore:
        this.config.localNodeIdentityStore ??
        createLocalStorageLocalNodeIdentityStore(),
      domain: this.config.domain ?? loc?.host ?? 'app.tinycloud.xyz',
      uri: this.config.domain === undefined ? loc?.origin : undefined,
      prefix: this.config.spacePrefix,
      autoCreateSpace: this.config.autoCreateSpace ?? true,
      sessionExpirationMs: this.config.sessionExpirationMs,
      sessionStorage: this.sessionStorage,
      notificationHandler: this.notificationHandler,
      wasmBindings: this.wasmBindings,
      nonce: this.config.nonce,
      siweConfig: this.config.siweConfig,
      // Forward the manifest into the node-sdk layer. This is what
      // finally wires up the manifest-driven sign-in flow end-to-end:
      // TinyCloudWeb.Config.manifest → TinyCloudNode → NodeUserAuthorization,
      // where `resolveManifest` + `manifestAbilitiesUnion` produce the
      // actual `abilities` map passed to `prepareSession`.
      manifest: this._manifest,
      capabilityRequest: this._capabilityRequest,
      signStrategy: this.config.signStrategy,
      includeAccountRegistryPermissions:
        this.config.includeAccountRegistryPermissions,
      autoBootstrapAccount: this.config.autoBootstrapAccount,
      telemetry: this.config.telemetry,
      retryPolicy: this.config.retryPolicy,
    };
    const resolved = await resolveReplicationConfig(this.config, this.walletSigner);
    if (resolved) nodeConfig.replication = resolved;

    // Wire up signer if available
    if (this.walletSigner) {
      nodeConfig.signer = this.walletSigner;
      nodeConfig.ensResolver = new BrowserENSResolver(this.provider);
    }

    // Space creation handler.
    //
    // Do NOT unconditionally install the modal handler here: node-sdk gives an
    // explicit handler precedence over `autoCreateSpace`, so always setting one
    // made `autoCreateSpace` dead config in the browser and forced every app
    // through a dialog it may have opted out of.
    nodeConfig.spaceCreationHandler = resolveSpaceCreationHandler({ ...this.config, toast: this.showToast, promptScope: this.uiClient.promptScope });

    this._node = new TinyCloudNode(nodeConfig);
    this._node.on("storage.full", (event) => {
      for (const handler of this.storageFullHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error('Error in "storage.full" handler:', error);
        }
      }
    });
    this._node.on("replica.purge.failed", (event) => {
      for (const handler of this.purgeFailedHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error('Error in "replica.purge.failed" handler:', error);
        }
      }
    });
    this._node.storageEpisode.subscribe(() => {
      for (const listener of [...this.storageEpisodeListeners]) {
        try {
          listener();
        } catch (error) {
          console.error("Error in storage episode listener:", error);
        }
      }
    });
    this._node.storageEpisode.subscribeDelegated(() => {
      for (const listener of [...this.delegatedStorageListeners]) {
        try {
          listener();
        } catch (error) {
          console.error("Error in delegated storage listener:", error);
        }
      }
    });
  }

  /**
   * Get the TinyCloudNode instance, awaiting init if necessary.
   * @internal
   */
  private async ensureNode(): Promise<TinyCloudNode> {
    if (!this._node) {
      await this._initPromise;
    }
    return this._node!;
  }

  /** Bind a wrapper call to its entry-time authority before initialization can yield. */
  private async dispatchCurrentNode<T>(
    dispatch: (node: TinyCloudNode, assertCurrent: () => void) => T | Promise<T>,
  ): Promise<T> {
    const entryNode = this._node;
    const session = entryNode?.restorableSession;
    const signOuts = this.signOutCount;
    if (this.signOutInFlight > 0) throw new Error("Operation cancelled by sign-out.");
    const node = await this.ensureNode();
    const assertCurrent = (): void => {
      if (this.signOutCount !== signOuts || this.signOutInFlight > 0 ||
        this._node !== node || (entryNode != null && entryNode !== node) ||
        node.restorableSession !== session) {
        throw new Error("Operation cancelled because the signed session changed or signed out.");
      }
    };
    assertCurrent();
    // Dispatch synchronously after the check so the Node captures this same graph.
    return dispatch(node, assertCurrent);
  }

  /**
   * Get the TinyCloudNode instance synchronously.
   * Throws if called before WASM initialization completes.
   * @internal
   */
  private get node(): TinyCloudNode {
    if (!this._node) {
      throw new Error(
        "TinyCloudWeb not yet initialized. WASM is still loading. " +
        "Use TinyCloudWeb.create() or await an async method (e.g., signIn()) first."
      );
    }
    return this._node;
  }

  /**
   * Factory method for guaranteed correct initialization.
   * Awaits WASM loading before returning the instance.
   */
  static async create(config: Config = {}): Promise<TinyCloudWeb> {
    const instance = new TinyCloudWeb(config);
    await instance._initPromise;
    return instance;
  }

  // ===========================================================================
  // Service Accessors (delegate to TinyCloudNode)
  // ===========================================================================

  get kv(): IKVService { return this.node.kv; }
  get sql(): ISQLService { return this.node.sql; }

  /** Whether the last signIn() skipped client-side account bootstrap. */
  get bootstrapSkipped(): boolean { return this.node.bootstrapSkipped; }
  /** Outcome of the last signIn()'s account-bootstrap attempt. */
  get bootstrapStatus(): { skipped: boolean; reason?: string; warnings?: BootstrapWarning[] } { return this.node.bootstrapStatus; }

  /**
   * Subscribe to `storage.full`. It fires once, on the first write any
   * service had rejected because the owner's TinyCloud storage is full, so an
   * app can show one read-only banner. Reads keep working. Safe to call before
   * initialization finishes. Returns the unsubscribe function.
   */
  on(event: "storage.full", handler: (event: StorageFullEvent) => void): () => void;
  /**
   * Subscribe to `replica.purge.failed`. It fires when the local copy could not be erased after
   * sign-out or account switch, after the SDK's bounded retries; the event carries the typed
   * reason and `retryNow`. The SDK retries again on the next load; `replication.purgeLocalCopy()`
   * retries now. Safe to call before initialization finishes. Returns the unsubscribe function.
   */
  on(event: "replica.purge.failed", handler: (event: LocalCopyPurgeFailedEvent) => void): () => void;
  on(
    event: "storage.full" | "replica.purge.failed",
    handler: ((event: StorageFullEvent) => void) | ((event: LocalCopyPurgeFailedEvent) => void),
  ): () => void {
    if (event === "replica.purge.failed") {
      const listener = handler as (event: LocalCopyPurgeFailedEvent) => void;
      this.purgeFailedHandlers.add(listener);
      return () => {
        this.purgeFailedHandlers.delete(listener);
      };
    }
    if (event !== "storage.full") {
      throw new Error(`Unknown TinyCloud event: ${String(event)}`);
    }
    const listener = handler as (event: StorageFullEvent) => void;
    this.storageFullHandlers.add(listener);
    return () => {
      this.storageFullHandlers.delete(listener);
    };
  }

  /** The owner's TinyCloud storage; `storage.status()` reads usage and plan from the node. */
  get storage(): IStorageService { return this.node.storage; }

  /** Browser UI API: `open`, `close`, `toggle`, `isOpen`, and `available`. Inert when `ui: false` or the page cannot render UI. */
  get ui(): TinyCloudUI { return this.uiClient.api; }

  /** Space-scoped SQL service for a non-primary space (e.g. the owner's `applications` space). */
  sqlForSpace(spaceId: string): ISQLService { return this.node.sqlForSpace(spaceId); }
  /** Space-scoped KV service for a non-primary space (e.g. the owner's `applications` space). */
  kvForSpace(spaceId: string): IKVService { return this.node.kvForSpace(spaceId); }
  get duckdb(): IDuckDbService { return this.node.duckdb; }
  get hooks(): IHooksService { return this.node.hooks; }
  get encryption(): IEncryptionService { return this.node.encryption; }
  /** Named keys bound to the signed-in session. */
  get keys() { return this.node.keys; }
  get vault(): IDataVaultService { return this.node.vault; }
  get secrets(): ISecretsService {
    return this.secretsForSpace("secrets");
  }
  secretsForSpace(spaceId: string): ISecretsService {
    const resolvedSpace = spaceId.startsWith("tinycloud:")
      ? spaceId
      : this.node.spaces.get(spaceId).id;
    let secrets = this._secrets.get(resolvedSpace);
    if (!secrets) {
      secrets = new WebSecretsService({
        getService: () => this.node.secretsForSpace(resolvedSpace),
        space: resolvedSpace,
        getManifest: () => this._manifest,
        requestPermissions: (additional) => this.requestPermissions(additional),
        resolveSpace: (space) => space.startsWith("tinycloud:") ? space : this.node.spaces.get(space).id,
        getUnlockSigner: () => this.walletSigner,
      });
      this._secrets.set(resolvedSpace, secrets);
    }
    return secrets;
  }
  get spaces(): ISpaceService { return this.node.spaces; }
  get sharing(): ISharingService { return this.node.sharing; }
  get delegations(): DelegationManager { return this.node.delegationManager; }
  get capabilityRegistry(): ICapabilityKeyRegistry { return this.node.capabilityRegistry; }
  get spaceId(): string | undefined { return this._node?.spaceId; }
  /** Hosting display hint bound to account, space and host, corrected by the automatic background probe. */
  get spaceHosting(): SpaceHosting {
    const observed = this._node?.spaceHosting ?? "unknown";
    const work = this.restoredNetworkWork;
    return observed === "unknown" && work?.isCurrent() ? work.cachedHosting : observed;
  }
  get accountSpaceId(): string | undefined { return this._node?.accountSpaceId; }
  get account(): AccountService { return this.node.account; }
  get hosts(): string[] { return this.node.hosts; }
  /** Replication control for the local KV mirror; undefined unless `replication` is configured. */
  get replication(): TinyCloudNode["replication"] { return this.node.replication; }
  /** Registry-resolved owner Node identity used to bind native share targets. */
  async activeNodeIdentity(): Promise<{ readonly origin: string; readonly nodeDid: string }> {
    return this.dispatchCurrentNode((node) => node.activeNodeIdentity());
  }
  /** Publish the active owner Node as a session-signed registry record. */
  async publishActiveNodeLocation(registryUrl: string, fetchFn?: typeof fetch) {
    return this.dispatchCurrentNode((node) => fetchFn === undefined
      ? node.publishActiveNodeLocation(registryUrl)
      : node.publishActiveNodeLocation(registryUrl, fetchFn));
  }
  get sessionRestoreStatus(): SessionRestoreStatus { return this._sessionRestoreStatus; }

  /** Holder-bound OpenCredentials issuance using the active TinyCloud session. */
  get credentials(): CredentialsService {
    this._credentialsService ??= new CredentialsService(this);
    return this._credentialsService;
  }

  /** First-class signed-in or accountless share receiving. */
  get share(): ShareReceiverService {
    this._shareReceiverService ??= new ShareReceiverService(this, this.config.shareReceiver);
    return this._shareReceiverService;
  }

  space(nameOrUri: string): ISpace { return this.spaces.get(nameOrUri); }
  get kvPrefix(): string { return this.config.kvPrefix || ""; }

  async getEncryptionNetwork(
    nameOrNetworkId = "default",
  ): Promise<NetworkDescriptor | null> {
    return this.dispatchCurrentNode((node) => node.getEncryptionNetwork(nameOrNetworkId));
  }

  async createEncryptionNetwork(
    name = "default",
  ): Promise<NetworkDescriptor> {
    return this.dispatchCurrentNode((node) => node.createEncryptionNetwork(name));
  }

  async ensureEncryptionNetwork(
    name = "default",
  ): Promise<NetworkDescriptor> {
    return this.dispatchCurrentNode((node) => node.ensureEncryptionNetwork(name));
  }

  /**
   * Ensure one of this user's owned spaces (e.g. `"secrets"`) is hosted on the
   * server.
   *
   * A full-authority sign-in auto-hosts the owner's `secrets` space, but a
   * session created with a manifest / capabilityRequest does not. Such a
   * session can hold valid `tinycloud.kv/*` capabilities for the owned
   * `secrets` space yet still fail its first scoped `secrets.put(...)` with
   * `404 Space not found`, because the space was never registered on the node.
   *
   * Calling this resolves `name` to the owner's owned-space URI. It first
   * consults the account spaces registry and, if the space is already
   * registered/hosted, returns without prompting for a host signature; only
   * when the space is absent (or the registry check fails) does it host via the
   * host-SIWE delegation flow (one signature, idempotent server-side). Must be
   * called after {@link signIn}.
   *
   * @param name - The owned space name (e.g. `"secrets"`).
   * @returns The hosted owned-space URI.
   */
  async ensureOwnedSpaceHosted(name: string): Promise<string> {
    return this.dispatchCurrentNode((node) => node.ensureOwnedSpaceHosted(name));
  }

  // ===========================================================================
  // Auth Methods (delegate to TinyCloudNode)
  // ===========================================================================

  private async resolveRestoreAddress(
    address?: string,
    allowExpiredRenewalCandidate = false,
  ): Promise<string | undefined> {
    if (address) return address;
    if (this._node?.address) return this._node.address;
    const connected = await this.walletSigner?.getConnectedAddress();
    if (connected !== undefined) return connected;
    const storage = this.sessionStorage as
      | (ISessionStorage & {
        activeAddress?: () => string | undefined;
        activeAddressForRenewal?: () => string | undefined;
      })
      | undefined;
    return allowExpiredRenewalCandidate
      ? storage?.activeAddressForRenewal?.()
      : storage?.activeAddress?.();
  }

  private async loadPersistedSession(
    address: string,
    allowRenewalCandidate = false,
  ): Promise<BrowserSessionLoadResult> {
    if (!this.sessionStorage) return { status: "storage-unavailable", data: null };
    if (allowRenewalCandidate && "loadRenewalCandidate" in this.sessionStorage) {
      return (this.sessionStorage as BrowserSessionStorage).loadRenewalCandidate(address);
    }
    if ("loadWithStatus" in this.sessionStorage) {
      return (this.sessionStorage as BrowserSessionStorage).loadWithStatus(address);
    }

    const data = await this.sessionStorage.load(address);
    return data
      ? { status: "loaded", data }
      : { status: "missing", data: null };
  }

  private trackRestoreAddress(address: string): void {
    this.pendingRestoreAddresses.set(address, (this.pendingRestoreAddresses.get(address) ?? 0) + 1);
  }

  private untrackRestoreAddress(address: string): void {
    const count = this.pendingRestoreAddresses.get(address)!;
    if (count === 1) this.pendingRestoreAddresses.delete(address);
    else this.pendingRestoreAddresses.set(address, count - 1);
  }

  async restoreSession(address?: string): Promise<SessionRestoreResult> {
    return this.restoreSessionInternal(address);
  }

  /**
   * Restore an expired browser session only when the owner-signed lease admission
   * and the node's independently verified renewal history extend its authority.
   * The lease authorization must come from an owner-approved source, not storage metadata.
   */
  async restoreSessionWithRenewal(
    leaseAuthorization: string,
    address?: string,
  ): Promise<SessionRestoreResult> {
    if (!leaseAuthorization) {
      return {
        status: "restore-failed",
        error: new Error("An owner-signed renewal lease authorization is required."),
      };
    }
    return this.restoreSessionInternal(address, leaseAuthorization);
  }

  private async restoreSessionInternal(
    address?: string,
    leaseAuthorization?: string,
  ): Promise<SessionRestoreResult> {

    const signOuts = this.signOutCount;
    // A restore may bring back a different account: a runtime permission signer set for the current one is cleared.
    this.runtimeSigner = undefined;
    const assertNotSignedOut = (): void => {
      if (this.signOutCount !== signOuts || this.signOutInFlight > 0) {
        throw new Error("Session restore was cancelled by sign-out.");
      }
    };
    if (!this.sessionStorage) {
      this._sessionRestoreStatus = "disabled";
      return { status: "disabled" };
    }
    const refused = () => ({ status: "restore-failed" as const, error: new Error("Session restore was cancelled by sign-out.") });
    if (this.signOutInFlight > 0) return refused();
    if (this.persistedRestoreBlocked) {
      if (this.signOutCleanupFailed) return refused();
      try {
        const restoreAddress = await this.resolveRestoreAddress(address, leaseAuthorization !== undefined);
        if (this.signOutCount !== signOuts || this.signOutInFlight > 0) return refused();
        if (!restoreAddress || (await this.loadPersistedSession(restoreAddress)).status === "missing") {
          if (this.signOutCount !== signOuts || this.signOutInFlight > 0) return refused();
          this._sessionRestoreStatus = "missing";
          return { status: "missing" };
        }
      } catch { /* Storage errors cannot release authority blocked by explicit logout. */ }
      return refused();
    }
    // An explicit address is known before resolveRestoreAddress's first await.
    // Sign-out must see it even when storage has no activeAddress() hook.
    if (address) this.trackRestoreAddress(address);

    const restoreAddress = await this.resolveRestoreAddress(address, leaseAuthorization !== undefined);
    if (this.signOutCount !== signOuts || this.signOutInFlight > 0) {
      if (address) this.untrackRestoreAddress(address);
      return refused();
    }
    if (!restoreAddress) {
      if (address) this.untrackRestoreAddress(address);
      this._sessionRestoreStatus = "missing";
      return { status: "missing" };
    }
    if (!address) this.trackRestoreAddress(restoreAddress);

    this._sessionRestoreStatus = "restoring";
    try {
      const loaded = await this.loadPersistedSession(restoreAddress, leaseAuthorization !== undefined);
      assertNotSignedOut();
      if (loaded.status !== "loaded" && loaded.status !== "renewal-candidate") {
        this._sessionRestoreStatus = loaded.status;
        return { status: loaded.status };
      }
      if (loaded.status === "renewal-candidate" && leaseAuthorization === undefined) {
        this._sessionRestoreStatus = "expired";
        return { status: "expired" };
      }
      // A record that sign-out could not remove stays fenced: a reload must not bring it back.
      const fencing: FenceCapableStorage = this.sessionStorage;
      if (fencing.isSignedOut?.(restoreAddress, loaded.data.signature)) {
        this._sessionRestoreStatus = "missing";
        return { status: "missing" };
      }
      const node = await this.ensureNode();
      assertNotSignedOut();
      const was = node.spaceId;
      const priorHosting = this.spaceHosting;
      const priorHost = node.hosts?.[0];
      const priorAccount = node.restorableSession;
      try {
        const restoreData = restoreDataFromPersisted(loaded.data);
        if (loaded.status === "renewal-candidate") {
          await node.restoreSessionWithRenewal(restoreData, leaseAuthorization!);
        } else {
          await node.restoreSession(restoreData);
        }
      } finally {
        // Also when a later step throws after the node committed the new account. A sign-out resets itself.
        if (was && was !== node.spaceId && this.signOutCount === signOuts && !this.signOutInFlight) this.uiClient.reset();
      }
      assertNotSignedOut();
      this.resetSessionScopedCaches();
      const data = loaded.data;
      const restoredHost = node.hosts?.[0];
      const cachedHosting = priorAccount?.address === data.address && priorAccount.chainId === data.chainId &&
        was === node.spaceId && priorHost === restoredHost && priorHosting !== "unknown"
        ? priorHosting
        : restoredHost && data.tinycloudHosts?.[0] === restoredHost && data.tinycloudSession?.spaceId === node.spaceId
          ? data.spaceHosting ?? "unknown"
          : "unknown";
      this.startRestoredNetworkWork(node, restoreAddress, data, cachedHosting, signOuts);
      this._sessionRestoreStatus = "restored";
      return {
        status: "restored",
        session: clientSessionFromPersisted(loaded.data),
      };
    } catch (err) {
      if (this.signOutCount !== signOuts || this.signOutInFlight > 0) {
        return refused();
      }
      // Restore rejection is intentionally transactional. Persisted storage
      // is user state, and attempting best-effort cleanup here can both mask
      // the authority error and strand this wrapper in "restoring" when a
      // storage backend itself fails. Callers can explicitly clear a session
      // after presenting the recoverable restore failure.
      this._sessionRestoreStatus = "restore-failed";
      return {
        status: "restore-failed",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      this.untrackRestoreAddress(restoreAddress);
    }
  }

  private startRestoredNetworkWork(
    node: TinyCloudNode,
    address: string,
    data: PersistedSessionData,
    cachedHosting: SpaceHosting,
    signOuts: number,
  ): void {
    const session = node.restorableSession;
    const nextTask = new Promise<void>((resolve) => setTimeout(resolve, 0));
    const isCurrent = () => this.restoredNetworkWork === work && this._node === node &&
      node.restorableSession === session && this.signOutCount === signOuts && this.signOutInFlight === 0;
    const grants = nextTask.then(async () => {
      if (!isCurrent()) return;
      const grantStore = this.runtimeGrantStore();
      if (grantStore !== undefined) {
        const owner = { address: data.address, chainId: data.chainId };
        await reuseRuntimeGrants(
          grantStore,
          address,
          (grant) =>
            activateValidatedRuntimeDelegationOnNode(node, grant, {
              host: node.hosts[0]!,
              authorize: (permissions) => {
                if (!isPanelResourceSet(permissions.map((entry) => ({ ...entry, space: entry.space ?? "" })), owner)) {
                  throw new RuntimeDelegationRejectedError("authority_invalid", "Stored grant is not a panel grant.");
                }
                return true;
              },
            }),
          { isCurrent },
        );
      }
    }).finally(() => {
      if (isCurrent()) this.uiClient.armPrefetch(this);
    }).catch(() => undefined);
    const work: NonNullable<TinyCloudWeb["restoredNetworkWork"]> = {
      cachedHosting,
      grants,
      isCurrent,
      hosting: nextTask.then(async () => {
        if (!isCurrent()) return;
        await this.probeSpaceHosting(node);
        if (isCurrent()) work.cachedHosting = "unknown";
      }),
    };
    this.restoredNetworkWork = work;
  }

  /** One node read for the restored session, held to {@link spaceHostingCapMs}; past it, or on any failure, the answer stays unknown. */
  private async probeSpaceHosting(node: TinyCloudNode): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([node.checkSpaceHosting(), new Promise((resolve) => { timer = setTimeout(resolve, this.spaceHostingCapMs); })]);
    } catch { /* a probe never fails a restore */ } finally {
      clearTimeout(timer);
    }
  }

  private spaceHostingInFlight?: {
    run: Promise<SpaceHosting>;
    signOuts: number;
    spaceId: string | undefined;
  };

  /**
   * Host a restored session's primary space only when the node reports it
   * missing. Reuses that session and its existing creation confirmation.
   * Call from a user gesture so the approval popup can open.
   */
  private async restoredSessionNotHosted(restored: ClientSession): Promise<ClientSession> {
    const signOuts = this.signOutCount;
    try {
      await this.ensureSpaceHosted();
      if (this.signOutCount !== signOuts) throw new Error("Sign-in was cancelled by sign-out.");
      return restored;
    } catch (error) {
      if (this.signOutCount !== signOuts) throw new Error("Sign-in was cancelled by sign-out.");
      throw error;
    }
  }

  /**
   * Ensure the primary space is hosted, asking for approval only when needed.
   * Resolves `"hosted"` when the node reports hosting or the space is created;
   * resolves `"not-hosted"` when creation is unavailable or declined; and
   * resolves `"unknown"` when the node has no hosting answer.
   * Rejects with `Error("Space hosting was cancelled by sign-out.")` if sign-out
   * happens during the hosting run. Call from a user gesture so the approval popup can open.
   * Also rejects if the initiating session is replaced before hosting finishes.
   */
  async ensureSpaceHosted(): Promise<SpaceHosting> {
    const signOuts = this.signOutCount;
    const cancellation = () => new Error("Space hosting was cancelled by sign-out.");
    try {
      return await this.dispatchCurrentNode(async (node, assertCurrent) => {
        await this.restoredNetworkWork?.hosting;
        assertCurrent();
        const hosting = node.spaceHosting;
        if (hosting !== "not-hosted") return hosting;
        const session = node.restorableSession;
        if (session && this.walletSigner) {
          const signerAddress = await this.walletSigner.getAddress();
          assertCurrent();
          if (signerAddress.toLowerCase() !== session.address.toLowerCase()) return "not-hosted";
        }

        const spaceId = node.spaceId;
        const existing = this.spaceHostingInFlight;
        if (existing && existing.signOuts === signOuts && existing.spaceId === spaceId) {
          return existing.run;
        }

        const hasCreationPath = this.walletSigner !== undefined &&
          (this.config.spaceCreationHandler !== undefined || this.config.autoCreateSpace !== false);
        if (!hasCreationPath) return "not-hosted";

        const run = node.ensurePrimarySpaceHosted("not-hosted").then(() => {
          assertCurrent();
          return node.spaceHosting;
        });
        const inFlight = { run, signOuts, spaceId };
        this.spaceHostingInFlight = inFlight;
        try {
          return await run;
        } finally {
          if (this.spaceHostingInFlight === inFlight) this.spaceHostingInFlight = undefined;
        }
      });
    } catch (error) {
      if (this.signOutCount !== signOuts || this.signOutInFlight > 0) throw cancellation();
      throw error;
    }
  }

  async clearPersistedSession(address?: string): Promise<void> {
    if (!this.sessionStorage) return;
    const restoreAddress = await this.resolveRestoreAddress(address);
    if (restoreAddress) {
      await this.sessionStorage.clear(restoreAddress);
    }
  }

  private configuredManifestPermissions(node: TinyCloudNode): ResourceCapability[] {
    if (this._capabilityRequest !== undefined) {
      return this._capabilityRequest.resources;
    }
    if (this._manifest !== undefined) {
      return composeManifestRequest(
        Array.isArray(this._manifest) ? this._manifest : [this._manifest],
        {
          includeAccountRegistryPermissions:
            this.config.includeAccountRegistryPermissions,
        },
      ).resources;
    }
    if (this.config.includeAccountRegistryPermissions === false) {
      return [];
    }
    if (node.accountSpaceId === undefined) {
      throw new Error("Cannot check restored account permissions before account space resolution");
    }
    const accountSpaceId = node.accountSpaceId;
    return ACCOUNT_MANIFEST_PERMISSIONS.map((resource) => ({
      ...resource,
      space: accountSpaceId,
      actions: [...resource.actions],
    }));
  }

  /**
   * Prepare an OpenKey SIWE before showing an approval button. Call after
   * OpenKey connect(), then call signIn() from the button's click handler.
   * A prepared request is single-use and valid for five minutes; call this
   * method again if the approval button remains visible longer.
   */
  async prepareSignIn(): Promise<void> {
    if (!this.config.openkey) throw new Error("prepareSignIn requires an OpenKey client");
    if (this.openkeySignInInFlight > 0) {
      throw new Error("OpenKey sign-in is in progress; prepare after it finishes");
    }
    refuseCaveated(this._capabilityRequest?.manifests ?? this._manifest);
    this.invalidatePreparedSignIn();
    const token = this.prepareSignInToken;
    const signOuts = this.signOutCount;
    const assertCurrent = (): void => {
      if (this.signOutCount !== signOuts) throw new Error("Sign-in was cancelled by sign-out.");
      if (token !== this.prepareSignInToken || this.openkeySignInInFlight > 0) {
        throw new Error("OpenKey sign-in preparation was superseded");
      }
    };
    const connected = await this.walletSigner?.getConnectedAddress().catch(() => undefined);
    const restored = await this.restoreSession(connected);
    assertCurrent();
    const node = await this.ensureNode();
    if (restored.status === "restored" && restored.session) {
      const permissions = this.configuredManifestPermissions(node);
      if (permissions.length === 0 || node.hasRuntimePermissions(permissions)) {
        await this.restoredNetworkWork?.hosting;
        assertCurrent();
        return;
      }
      await this.clearPersistedSession(restored.session.address);
      this._sessionRestoreStatus = "stale";
    }
    assertCurrent();
    const request = await node.prepareOpenKeySignIn(this.openKeySignInOptions());
    assertCurrent();
    this.preparedSignIn = { node, request, createdAt: Date.now(), signOuts };
  }

  /**
   * Options forwarded to the node's OpenKey sign-in; `undefined` unless the app opted in to `expiryChangeable`.
   * `maxExpiresAt` is forwarded only with it.
   */
  private openKeySignInOptions():
    | { expiryChangeable: true; maxExpiresAt?: number | Date | (() => number | Date) }
    | undefined {
    const openkey = this.config.openkey;
    if (openkey?.expiryChangeable !== true) return undefined;
    return openkey.maxExpiresAt === undefined
      ? { expiryChangeable: true }
      : { expiryChangeable: true, maxExpiresAt: openkey.maxExpiresAt };
  }

  signIn = (options?: SignInOptions): Promise<ClientSession> => {
    if (!this.config.openkey) return this.performSignIn(options);
    this.openkeySignInInFlight++;
    return this.performSignIn(options).finally(() => {
      this.openkeySignInInFlight--;
    });
  };

  private performSignIn = async (options?: SignInOptions): Promise<ClientSession> => {
    // Refuse a caveated manifest before any restore, signer or network call.
    refuseCaveated(this._capabilityRequest?.manifests ?? this._manifest);
    const signOuts = this.signOutCount;
    const assertNotSignedOut = (): void => {
      if (this.signOutCount !== signOuts || this.signOutInFlight > 0) {
        throw new Error("Sign-in was cancelled by sign-out.");
      }
    };
    assertNotSignedOut();
    // A new sign-in is a new session: a runtime permission signer set for an earlier one does not carry over.
    this.runtimeSigner = undefined;
    if (this.config.openkey && options) {
      throw new Error("OpenKey sign-in does not accept wallet SIWE overrides");
    }
    const pending = this.preparedSignIn;
    this.invalidatePreparedSignIn();
    if (pending) {
      if (Date.now() - pending.createdAt > 5 * 60_000 || pending.signOuts !== signOuts) {
        throw new Error("Prepared OpenKey sign-in expired; call prepareSignIn() again");
      }
    }
    let node: TinyCloudNode;
    if (pending) {
      node = pending.node;
    } else {
      const connected = await this.walletSigner?.getConnectedAddress().catch(() => undefined);
      assertNotSignedOut();
      const restored = await this.restoreSession(connected);
      assertNotSignedOut();
      if (restored.status === "restored" && restored.session) {
        const restoredNode = await this.ensureNode();
        assertNotSignedOut();
        const permissions = this.configuredManifestPermissions(restoredNode);
        if (permissions.length === 0 || restoredNode.hasRuntimePermissions(permissions)) {
          await this.restoredNetworkWork?.hosting;
          assertNotSignedOut();
          return restoredNode.spaceHosting === "not-hosted"
            ? this.restoredSessionNotHosted(restored.session)
            : restored.session;
        }
        await this.clearPersistedSession(restored.session.address);
        assertNotSignedOut();
        this._sessionRestoreStatus = "stale";
      }
      node = await this.ensureNode();
      assertNotSignedOut();
    }
    this.restoredNetworkWork = undefined;
    this._sessionRestoreStatus = "logging-in";
    const was = node.spaceId;
    try {
      if (pending) {
        await node.signInWithPreparedOpenKey(
          pending.request,
          wireOpenKeyAuthorize(this.config.openkey!.client, { mode: this.config.openkey!.mode ?? "popup" }),
        );
      } else if (this.config.openkey) {
        await node.signInWithOpenKey(
          wireOpenKeyAuthorize(this.config.openkey.client, { mode: this.config.openkey.mode ?? "popup" }),
          this.openKeySignInOptions(),
        );
      } else {
        await node.signIn(options);
      }
    } finally {
      if (was && was !== node.spaceId && this.signOutCount === signOuts && !this.signOutInFlight) this.uiClient.reset();
    }
    assertNotSignedOut();
    this.resetSessionScopedCaches();
    this.uiClient.armPrefetch(this);
    const session = node.session;
    if (!session) throw new Error("Sign-in completed but no session available");
    // Explicit logout never permits an older tab's persisted proof to satisfy the next sign-in.
    if (!this.signOutCleanupFailed && this.signOutInFlight === 0) this.persistedRestoreBlocked = false;
    return {
      address: session.address,
      walletAddress: session.address,
      chainId: session.chainId,
      sessionKey: session.sessionKey,
      siwe: session.siwe,
      signature: session.signature,
    };
  };

  /**
   * Sign out: end the session on this instance and clear the persisted
   * session. Afterwards accessors return `undefined` and service calls remain
   * unavailable until a fresh sign-in; prior persisted sessions cannot restore.
   */
  signOut = (): Promise<void> => {
    try {
      const node = this._node;
      // Capture before asking the node to retire authority, including when checking a prior operation.
      const liveAddress = node?.address;
      const ownSignature = node?.session?.signature ?? node?.restorableSession?.signature;
      const pendingAddresses = this.pendingRestoreAddresses.size
        ? [...this.pendingRestoreAddresses.keys()]
        : undefined;
      const prior = this.signOutOperation;
      let remote: Promise<void> | undefined;
      if (prior && prior.node === node) {
        if (this.signOutInFlight > 0) return prior.result;
        remote = node?.signOut();
        if (node && remote === prior.remote) return prior.result;
      }
      this.signOutCount++;
      closeActiveModal();
      this.runtimeSigner = undefined;
      this.spaceHostingInFlight = undefined;
      this.restoredNetworkWork = undefined;
      this.invalidatePreparedSignIn();
      this.signOutInFlight++;
      this.persistedRestoreBlocked = true;
      remote ??= node?.signOut();
      remote?.catch(() => undefined);
      const result = (async () => {
        let cleaned = false;
        try {
          try {
            this.resetSessionScopedCaches();
            this._credentialsService = undefined;
            this._shareReceiverService = undefined;
            this._sessionRestoreStatus = "idle";
            this.uiClient.reset();
            const address = liveAddress ?? await this.resolveRestoreAddress().catch(() => undefined);
            const store = this.runtimeGrantStore();
            await serializeRuntimeGrantMutation(store, async () => {
              if (address) await this.clearOwnPersistedSession(address, ownSignature);
              for (const pendingAddress of pendingAddresses ?? []) {
                if (pendingAddress !== address) await this.clearPersistedSession(pendingAddress);
              }
              if (store && address && await this.sessionStorage?.load(address) === null) {
                await store.saveRuntimeGrants(address, []);
              }
            });
            cleaned = true;
          } finally {
            if (!cleaned) this.signOutCleanupFailed = true;
          }
          if (remote) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([remote, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.remoteSignOutTimeoutMs); })]);
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          this.signOutInFlight--;
        }
      })();
      this.signOutOperation = { node, remote, result };
      // A failed node result can precede its cleanup. Repeated calls compare the node's operation identity
      // rather than resolving a new active address and clearing somebody else's session.
      void Promise.all([result, remote]).then(() => {
        if (this.signOutOperation?.result === result) this.signOutOperation = undefined;
      }, () => {
        if (!remote && this.signOutOperation?.result === result) this.signOutOperation = undefined;
      });
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  };

  /**
   * Clears the stored session for `address` only while it is the signing-out session (`ownSignature`); a newer
   * session saved for the same address is left alone. The session is fenced first, so that a clear that fails
   * cannot let a reload restore it.
   */
  private async clearOwnPersistedSession(address: string, ownSignature: string | undefined): Promise<void> {
    const storage: FenceCapableStorage | undefined = this.sessionStorage;
    if (!storage) return;
    if (ownSignature !== undefined) {
      const owned = invalidateOwnSession(storage, address, ownSignature);
      if (owned !== undefined) return owned;
    }
    let fenceError: unknown;
    if (ownSignature !== undefined) {
      const stored = await storage.load(address);
      if (stored !== null && stored.signature !== ownSignature) return;
      try {
        storage.markSignedOut?.(address, ownSignature);
      } catch (error) {
        fenceError = error;
      }
    }
    await storage.clear(address);
    if (fenceError !== undefined) throw fenceError;
  }

  session = (): ClientSession | undefined => {
    if (!this._node) return undefined;
    const s = this._node.session;
    if (!s) return undefined;
    return {
      address: s.address,
      walletAddress: s.address,
      chainId: s.chainId,
      sessionKey: s.sessionKey,
      siwe: s.siwe,
      signature: s.signature,
    };
  };

  address = (): string | undefined => this._node?.address;
  chainId = (): number | undefined => this._node?.session?.chainId;

  /** Returns whether the session or an unexpired runtime grant covers all entries. Never prompts. */
  hasPermissions(entries: PermissionEntry[]): boolean {
    return this._node?.hasRuntimePermissions(entries) ?? false;
  }

  get did(): string { return this.node.did; }
  get sessionDid(): string { return this.node.sessionDid; }
  get credentialHolderDid(): string { return this.node.credentialHolderDid; }
  get credentialHolderKid(): string { return this.node.credentialHolderKid; }
  get isSessionOnly(): boolean { return this.node.isSessionOnly; }
  get isWalletConnected(): boolean { return this.walletSigner !== undefined; }

  /** Sign protocol bytes with the established session key without exposing key material. */
  async signSessionBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return this.node.signSessionBytes(bytes);
  }

  async createUnifiedOwnerRoot(input: UnifiedOwnerRootInput): Promise<UnifiedOwnerRootReceipt> {
    return this.node.createUnifiedOwnerRoot(input);
  }

  async autoSignCredentialBytes(bytes: Uint8Array): Promise<Uint8Array | undefined> {
    return this.node.autoSignCredentialBytes(bytes);
  }

  async approveCredentialBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return this.node.approveCredentialBytes(bytes);
  }

  async activateCompactRuntimeDelegation(input: {
    readonly authorization: string;
    readonly cid: string;
    readonly host: string;
  }): Promise<ValidatedRuntimeDelegation> {
    const session = this.session();
    if (session === undefined) throw new Error("Not signed in. Call signIn() first.");
    return activateCompactRuntimeDelegationOnNode(this.node, {
      ...input,
      ownerAddress: session.address,
      chainId: session.chainId,
    });
  }

  credentialSpaceOwnerDid(spaceId: string): string {
    return this.node.credentialSpaceOwnerDid(spaceId);
  }

  /** Root authorization CID of the active session, which {@link session} omits. */
  accountAuthorizationCid(): string {
    const cid = this._node?.restorableSession?.delegationCid;
    if (typeof cid !== "string" || cid.length === 0) {
      throw new Error("Not signed in. Call signIn() first.");
    }
    return cid;
  }

  // ===========================================================================
  // Extension & Lifecycle
  // ===========================================================================

  extend(_extension: Extension): void {
    // Not yet implemented — TinyCloudNode.extend() needed
  }

  cleanup(): void {
    this.uiClient.unregister();
    this.notificationHandler.cancelPendingThrows();
  }

  connectWallet(
    provider: BrowserWalletProvider,
    options?: { spacePrefix?: string }
  ): void {
    this.invalidatePreparedSignIn();
    this.walletSigner = new BrowserWalletSigner(provider);
    this.provider = this.walletSigner.getProvider();
    this.eip1193Provider = this.provider;
    if (this._node) {
      this._node.connectSigner(this.walletSigner, {
        prefix: options?.spacePrefix,
      });
    }
  }

  // ===========================================================================
  // Delegation Methods (delegate to TinyCloudNode)
  // ===========================================================================

  async createDelegation(params: {
    path: string;
    actions: string[];
    delegateDID: string;
    disableSubDelegation?: boolean;
    expiryMs?: number;
  }): Promise<PortableDelegation> {
    return this.dispatchCurrentNode((node) => node.createDelegation(params));
  }

  /** Owner-sign and admit a bounded renewal lease for the current session. */
  async createRenewalLease(
    expiresAt: Date,
  ): Promise<Awaited<ReturnType<TinyCloudNode["createRenewalLease"]>>> {
    return this.dispatchCurrentNode((node) => node.createRenewalLease(expiresAt));
  }

  /** Verify current node-admitted renewal authority for the current session. */
  async getRenewalEffectiveExpiry(leaseAuthorization: string): Promise<number> {
    return this.dispatchCurrentNode((node) => node.getRenewalEffectiveExpiry(leaseAuthorization));
  }

  /** Create and activate a wallet-rooted delegation for an ephemeral share key. */
  async createOwnerDelegation(
    params: CreateOwnerDelegationParams extends infer PermissionShape
      ? PermissionShape extends CreateOwnerDelegationParams
        ? Omit<PermissionShape, "spaceId"> & { readonly spaceId?: string }
        : never
      : never,
  ): Promise<OwnerDelegationReceipt> {
    return this.dispatchCurrentNode((node) => {
      const spaceId = params.spaceId ?? node.spaceId;
      if (spaceId === undefined) throw new Error("Owner share delegation requires an authenticated space.");
      if ("permissions" in params) {
        return node.createOwnerDelegation({
          delegateDid: params.delegateDid,
          permissions: params.permissions!,
          expiresAt: params.expiresAt,
          spaceId,
        });
      }
      return node.createOwnerDelegation({
        delegateDid: params.delegateDid,
        path: params.path,
        actions: params.actions,
        expiresAt: params.expiresAt,
        spaceId,
      });
    });
  }

  /** Register signed policy material through the Node-owned Policy/v3 runtime. */
  async registerPolicy(
    params: Omit<RegisterPolicyV3Input, "nodeOrigin" | "fetch">,
  ): Promise<RegisterPolicyV3Receipt> {
    return this.dispatchCurrentNode((node) => node.registerPolicy(params));
  }

  /** Authorize a short-lived, one-use v3 delivery against the signed envelope and roots. */
  async authorizeShareDeliveryV3(input: Parameters<TinyCloudNode["authorizeShareDeliveryV3"]>[0]): Promise<Awaited<ReturnType<TinyCloudNode["authorizeShareDeliveryV3"]>>> {
    return this.dispatchCurrentNode((node) => node.authorizeShareDeliveryV3(input));
  }

  /**
   * Issue a delegation using the capability-chain flow (spec:
   * `.claude/specs/capability-chain.md`). When the requested permissions
   * are a subset of the current session's recap, no wallet prompt is
   * shown — the delegation is signed by the session key via WASM. When
   * they are not, this throws `PermissionNotInManifestError` so callers
   * can trigger an escalation flow via {@link requestPermissions}.
   *
   * Pass `{ forceWalletSign: true }` to bypass the derivability check and
   * always use the wallet-signed SIWE path.
   */
  delegateTo = async (
    did: string,
    permissions: PermissionEntry[],
    options?: DelegateToOptions,
  ): Promise<DelegateToResult> => {
    return this.dispatchCurrentNode((node) => node.delegateTo(did, permissions, options));
  };

  materializeDelegation = async (
    did: string,
    request?: ComposedManifestRequest,
  ): Promise<DelegateToResult & { target: ResolvedDelegate }> => {
    return this.dispatchCurrentNode((node) => node.materializeDelegation(did, request));
  };

  materializeDelegations = async (
    request?: ComposedManifestRequest,
  ): Promise<Array<DelegateToResult & { target: ResolvedDelegate }>> => {
    return this.dispatchCurrentNode((node) => node.materializeDelegations(request));
  };

  /**
   * Get the stored manifest (if any). Returns a shallow clone so callers
   * can't accidentally mutate our internal state.
   */
  getManifest(): Manifest | Manifest[] | undefined {
    if (this._manifest === undefined) return undefined;
    return Array.isArray(this._manifest)
      ? this._manifest.map((manifest) => ({ ...manifest }))
      : { ...this._manifest };
  }

  /**
   * Install or replace the stored manifest. Used by apps that compose
   * their manifest at runtime (e.g. after fetching a backend's advertised
   * permissions) and by the escalation flow inside
   * {@link requestPermissions}.
   *
   * The manifest is forwarded to the underlying TinyCloudNode so the
   * next `signIn()` picks it up. If the node has not been constructed
   * yet (pre-init), the manifest is stored locally and forwarded
   * later inside `_init`.
   */
  setManifest(manifest: Manifest | Manifest[]): void {
    this.invalidatePreparedSignIn();
    this._manifest = manifest;
    this._capabilityRequest = undefined;
    // Forward eagerly if the node is already up. Pre-init, the
    // manifest rides into the constructor via `nodeConfig.manifest`
    // inside `_init`, which reads `this._manifest` at that time.
    if (this._node) {
      this._node.setManifest(manifest);
    }
  }

  setCapabilityRequest(request: ComposedManifestRequest): void {
    this.invalidatePreparedSignIn();
    this._capabilityRequest = request;
    this._manifest = request.manifests;
    if (this._node) {
      this._node.setCapabilityRequest(request);
    }
  }

  /**
   * Request additional permissions on top of the currently-signed
   * session. Shows a confirmation modal; on approve, stores a narrow
   * runtime delegation that matching service calls can use. On decline,
   * returns `{ approved: false }` with no state changes.
   *
   * Spec: `.claude/specs/capability-chain.md` §requestPermissions.
   *
   * On approve, this does not mutate the manifest or force a new sign-in.
   * The underlying node creates a secondary delegation to the current
   * session key and records it in the invocation permission map.
   *
   * `options.expiryMs` sets the requested lifetime of the issued step-up
   * delegation, in milliseconds. Omitted, the node's default applies. The
   * node clamps the lifetime to the session expiry, so the issued
   * delegation never outlives the session. The expiry applies when new
   * permissions are requested. Permissions already covered by the session
   * or an existing runtime grant return without a new delegation, so
   * `expiryMs` does not apply to them.
   */
  async requestPermissions(
    additional: PermissionEntry[],
    options?: RequestPermissionsOptions,
  ): Promise<RequestPermissionsResult> {
    validateAdditionalPermissions(additional);

    const manifest = Array.isArray(this._manifest)
      ? this._manifest[0]
      : this._manifest;
    // Escalation requires a stored manifest so the confirmation modal can
    // identify the app asking for additional permissions. Apps that signed
    // in without a manifest must set one via `setManifest` before escalating.
    if (manifest === undefined) {
      throw new Error(
        "requestPermissions requires a stored manifest. Pass `manifest` in the TinyCloudWeb config or call setManifest() before requesting escalation.",
      );
    }

    const node = await this.ensureNode();
    const hasRuntimePermissions =
      this._testHooks?.hasRuntimePermissions ?? ((requested) =>
        node.hasRuntimePermissions(requested));
    if (hasRuntimePermissions(additional)) {
      const delegations = node.getRuntimePermissionDelegations(additional);
      return delegations.length > 0
        ? { approved: true, session: this.session(), delegations }
        : { approved: true, session: this.session() };
    }

    const grantPermissions = this._testHooks?.grantPermissions ??
      ((approved: PermissionEntry[], grantOptions?: RequestPermissionsOptions) => {
        const signMessage = this.runtimeMessageSigner();
        const grant = {
          ...(grantOptions?.expiryMs !== undefined ? { expiry: grantOptions.expiryMs } : {}),
          ...(signMessage !== undefined ? { signMessage } : {}),
        };
        return node.grantRuntimePermissions(approved, Object.keys(grant).length > 0 ? grant : undefined);
      });
    const result = await requestPermissionsCore(additional, {
      manifest,
      showModal: this._testHooks?.showModal ?? ((options) => showPermissionRequestModal(options, this.uiClient.promptScope)),
      isPromptSuppressed: () => isPermissionPromptSuppressed(manifest),
      suppressPromptFor30Days: () =>
        suppressPermissionPromptFor30Days(manifest),
      grantPermissions,
    }, options);
    return result.approved
      ? {
          approved: true,
          session: this.session(),
          ...(result.delegations !== undefined
            ? { delegations: result.delegations }
            : {}),
        }
      : result;
  }

  /**
   * Signs the SIWE of a runtime permission grant. Precedence: the signer set with `setRuntimePermissionSigner`, then
   * the configured OpenKey client's byte-exact `signMessage` (an OpenKey session's wallet provider does not implement
   * `personal_sign`), signing with the keyId of the connected account after connecting the client first when it is not
   * connected; a missing or ambiguous key throws `OpenKeySigningKeyError`. Without an OpenKey client or a session account,
   * undefined: the connected wallet signs. Only `requestPermissions` calls this; sign-in and session setup never do.
   */
  private runtimeMessageSigner(): ((siwe: string) => Promise<string>) | undefined {
    const bound = this.runtimeSigner;
    if (bound !== undefined) {
      const current = this._node?.address;
      const sameSession =
        bound.signOuts === this.signOutCount &&
        this.signOutInFlight === 0 &&
        current !== undefined &&
        current.toLowerCase() === bound.address.toLowerCase();
      if (sameSession) return (siwe) => bound.signer.signMessage(siwe);
      // The session it was set for has ended or been replaced.
      this.runtimeSigner = undefined;
    }
    const openkey = this.config?.openkey;
    const client = openkey?.client as (OpenKeyAuthorizeTinyCloud & OpenKeyMessageSigner) | undefined;
    if (openkey === undefined || typeof client?.signMessage !== "function") return undefined;
    // TC-2281: OpenKey opens a sign dialog with no key when `signMessage` carries no keyId, and the dialog dead-ends on "Please connect
    // first to sign messages." So every request names the keyId of the connected account, and a client that is not connected is
    // connected first (popup mode: the browser would block a sign popup after the slow connect popup, so the grant ends with OPENKEY_CONNECTED_RETRY and the
    // next click signs). No key, or a key that is not the session's account, is an OpenKeySigningKeyError: never a request without a keyId.
    const node = this._node;
    const account = node?.address;
    if (node === undefined || account === undefined) return undefined;
    const session = node.session;
    const signOuts = this.signOutCount;
    const mode = openkey.mode ?? "popup";
    // The connect and sign dialogs can outlive the session they were opened for: the same node, account and session object.
    const assertCurrent = (): void => {
      if (this.signOutCount !== signOuts || this.signOutInFlight > 0 || this._node !== node || node.address !== account || node.session !== session) {
        throw new Error("Permission request cancelled because the signed session changed or signed out.");
      }
    };
    return async (siwe) => {
      const keyId = await resolveOpenKeySigningKey(client, account, mode, assertCurrent);
      const { signature } = await client.signMessage!({ message: siwe, keyId }, { mode });
      assertCurrent();
      return signature;
    };
  }

  /**
   * Sets the signer for runtime permission grants (`requestPermissions`, and the panel's "allow" buttons), or clears
   * it with no argument. For apps whose sign-in is not the SDK's OpenKey flow, for example a restored session whose
   * wallet provider cannot sign: the signer signs each grant's SIWE as an EIP-191 message (`personal_sign`), and the
   * grant is refused unless the signature recovers to the session's account.
   *
   * Call it after the session is established; it throws without one. It is bound to that session: sign-out, a new
   * sign-in, a restore, or a session for another account clear it. It is never used for sign-in or session setup.
   * Without it, grants sign through the `openkey` client when configured, else the connected wallet.
   */
  setRuntimePermissionSigner(signer?: RuntimePermissionSigner): void {
    if (signer === undefined) {
      this.runtimeSigner = undefined;
      return;
    }
    const address = this._node?.address;
    if (address === undefined) throw new Error("setRuntimePermissionSigner requires a signed-in session.");
    this.runtimeSigner = { signer, address, signOuts: this.signOutCount };
  }

  /** True when the panel may ask for a permission: a manifest, a page signer and a live session exist. */
  private canRequestPanelPermissions(): boolean {
    const manifest = Array.isArray(this._manifest) ? this._manifest[0] : this._manifest;
    return manifest !== undefined && this._node !== undefined && !this._node.isSessionOnly && this.session() !== undefined;
  }

  /**
   * The panel's request for one tab's entry. A grant is kept with the stored session record so it survives a reload;
   * the entry is not stored when the user signed out while the prompt was open.
   */
  private async requestPanelPermissions(
    entries: PermissionEntry[],
    options: RequestPermissionsOptions,
  ): Promise<{ approved: boolean }> {
    await this.restoredNetworkWork?.grants;
    const signOuts = this.signOutCount;
    const result = await this.requestPermissions(entries, options);
    const address = this._node?.address;
    const store = this.runtimeGrantStore();
    if (
      result.approved &&
      result.delegations !== undefined &&
      store !== undefined &&
      address !== undefined &&
      this.signOutCount === signOuts &&
      this.signOutInFlight === 0
    ) {
      await rememberRuntimeGrants(store, address, result.delegations,
        () => this.signOutCount === signOuts && this.signOutInFlight === 0 && this._node?.address === address);
    }
    return { approved: result.approved };
  }

  private runtimeGrantStore(): RuntimeGrantStore | undefined {
    const store = this.sessionStorage as Partial<BrowserSessionStorage> | undefined;
    return store?.loadRuntimeGrants !== undefined && store.saveRuntimeGrants !== undefined
      ? (store as BrowserSessionStorage)
      : undefined;
  }

  getRuntimePermissionDelegations(
    permissions?: PermissionEntry[],
  ): readonly PortableDelegation[] {
    return this.node.getRuntimePermissionDelegations(permissions);
  }

  async useRuntimeDelegation(delegation: PortableDelegation): Promise<void> {
    return this.dispatchCurrentNode((node) => node.useRuntimeDelegation(delegation));
  }

  async useDelegation(delegation: PortableDelegation): Promise<DelegatedAccess> {
    return this.dispatchCurrentNode((node) => node.useDelegation(delegation));
  }

  async createSubDelegation(
    parentDelegation: PortableDelegation,
    params: {
      path: string;
      actions: string[];
      delegateDID: string;
      disableSubDelegation?: boolean;
      expiryMs?: number;
      resources?: Array<{
        service: string;
        space?: string;
        path: string;
        actions: string[];
      }>;
    }
  ): Promise<PortableDelegation> {
    return this.dispatchCurrentNode((node) => node.createSubDelegation(parentDelegation, params));
  }

  async revokeDelegation(cid: string): Promise<Result<DelegationRevocationReceipt, DelegationError>> {
    return this.dispatchCurrentNode((node) => node.revokeDelegation(cid));
  }

  async checkPermission(path: string, action: string): Promise<Result<boolean, DelegationError>> {
    return this.dispatchCurrentNode((node) => node.checkPermission(path, action));
  }

  // ===========================================================================
  // Static Methods
  // ===========================================================================

  /**
   * Receive and retrieve data from a native TinyCloud bearer delegation.
   * Static method — no sign-in required. Verifies the parent with browser WASM and routes through the owner's registry.
   */
  public static async receiveShare<T = unknown>(
    link: string,
    key?: string,
    options?: { readonly binary?: boolean },
  ): Promise<Result<ShareReceiveResult<T>, DelegationError>> {
    const wasmBindings = new BrowserWasmBindings();
    await wasmBindings.ensureInitialized();

    try {
      const node = new TinyCloudNode({
        wasmBindings,
        registrySequenceStore: createLocalStorageRegistrySequenceStore(),
        registryCacheStore: createLocalStorageRegistryCacheStore(),
        newUserHost: null,
        autoDiscoverLocalNode: false,
      });
      const received = await node.sharing.receive(link, {
        autoSubdelegate: false,
        useSessionKey: false,
      });
      if (received.ok === false) return received;
      const share = received.data;

      // receive() has verified the parent CID, signature, space and embedded key.
      // Its recorded host is never promoted to routing authority.
      let registeredHost: string | undefined;
      const delegateResponse = await node.resourceTransport(
        [{ resource: share.spaceId, access: "read" }],
        async (target) => {
          const response = await target.fetch(`${target.url}/delegate`, {
            method: "POST",
            headers: { Authorization: share.delegation.authHeader! },
            redirect: "error",
          });
          if (response.ok) registeredHost = target.url;
          return response;
        },
      );
      if (!delegateResponse.ok) {
        const errorText = await delegateResponse.text();
        return {
          ok: false,
          error: {
            code: "DELEGATION_FAILED",
            message: `Failed to register delegation: ${delegateResponse.status} - ${errorText}`,
            service: "delegation",
          },
        };
      }

      // The public static API accepts full keys, unlike the path-prefixed ShareAccess.
      const kvResult = await share.kv.get<T>(key ?? share.path, { ...options, prefix: "" });

      if (kvResult.ok === true) {
        return {
          ok: true as const,
          data: {
            data: kvResult.data.data,
            delegation: share.delegation,
            path: share.path,
            spaceId: share.spaceId,
            host: registeredHost!,
          },
        };
      }

      const routed = routingFailure(kvResult.error);
      if (routed) return { ok: false, error: { ...routed, service: "delegation" } };
      const errorResult = kvResult;
      return {
        ok: false as const,
        error: {
          code: "DATA_FETCH_FAILED",
          message: `Failed to fetch shared data: ${errorResult.error.message}`,
          service: "delegation" as const,
          cause: errorResult.error.cause,
        },
      };
    } catch (err) {
      const routed = routingFailure(err);
      if (routed) return { ok: false, error: { ...routed, service: "delegation" } };
      return {
        ok: false,
        error: {
          code: "DECODE_FAILED",
          message: `Failed to process share link: ${err instanceof Error ? err.message : String(err)}`,
          service: "delegation",
          cause: err instanceof Error ? err : undefined,
        },
      };
    }
  }
}
