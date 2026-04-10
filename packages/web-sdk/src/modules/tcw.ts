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
  TinyCloudNode,
  TinyCloudNodeConfig,
  type DelegateToOptions,
  type DelegateToResult,
} from "@tinycloud/node-sdk/core";
import {
  IKVService,
  ISQLService,
  IDuckDbService,
  IDataVaultService,
  ISpaceService,
  ISpace,
  ISharingService,
  ICapabilityKeyRegistry,
  IHooksService,
  DelegationManager,
  Delegation,
  CreateDelegationParams,
  Result,
  DelegationError,
  DelegationResult,
  ClientSession,
  Extension,
  EncodedShareData,
  KVService,
  ServiceContext,
  ServiceSession,
  ISpaceCreationHandler,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";
import { showPermissionRequestModal } from "../notifications/ModalManager";
import {
  requestPermissionsCore,
  validateAdditionalPermissions,
} from "./requestPermissionsCore";
import type { providers } from "ethers";

import { BrowserWalletSigner } from "../adapters/BrowserWalletSigner";
import { BrowserNotificationHandler } from "../adapters/BrowserNotificationHandler";
import { BrowserWasmBindings } from "../adapters/BrowserWasmBindings";
import { BrowserENSResolver } from "../adapters/BrowserENSResolver";
import { RPCProviders, ClientConfig, Extension as ExtensionType } from "../providers";
import {
  ModalSpaceCreationHandler,
  defaultWebSpaceCreationHandler,
} from "../authorization";
import type { NotificationConfig } from "../notifications/types";
import { WasmInitializer } from "./WasmInitializer";
import { invoke } from "./Storage/tinycloud/module";
import type { PortableDelegation, DelegatedAccess } from "@tinycloud/node-sdk/core";

declare global {
  interface Window {
    ethereum?: any;
  }
}

// Config

/**
 * Configuration for TinyCloudWeb.
 *
 * Extends ClientConfig with browser-specific options.
 */
export interface Config extends ClientConfig {
  /** Notification configuration for error popups and toasts */
  notifications?: NotificationConfig;

  /** Optional prefix for KV service keys */
  kvPrefix?: string;

  /** Prefix for space names when creating spaces */
  spacePrefix?: string;

  /** TinyCloud server hosts (default: ['https://node.tinycloud.xyz']) */
  tinycloudHosts?: string[];

  /** Whether to auto-create space on sign-in (default: true) */
  autoCreateSpace?: boolean;

  /** Space creation handler (default: ModalSpaceCreationHandler) */
  spaceCreationHandler?: ISpaceCreationHandler;

  /** Session expiration time in milliseconds (default: 1 hour) */
  sessionExpirationMs?: number;

  /** SIWE domain (default: window.location.hostname in browser, app.tinycloud.xyz otherwise) */
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
   * manifest's `name` and `icon` to title the permission modal and
   * composes escalation requests against the manifest's existing
   * permission set. The manifest is forwarded into the underlying
   * {@link TinyCloudNode} so `signIn()` drives its SIWE recap from
   * it directly.
   */
  manifest?: Manifest;
}

/**
 * Result of {@link TinyCloudWeb.requestPermissions}. Populated with the
 * fresh session on approve; empty on decline so callers can branch on
 * `approved` without dereferencing a stale session.
 */
export interface RequestPermissionsResult {
  approved: boolean;
  session?: ClientSession;
}

// Share Link Utilities (static, no auth required)

const TC1_PREFIX = "tc1:";

function base64UrlDecode(encoded: string): string {
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  if (typeof atob !== "undefined") {
    return decodeURIComponent(escape(atob(base64)));
  } else if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").toString("utf-8");
  }
  throw new Error("No base64 decoding available");
}

function decodeShareLink(link: string): EncodedShareData {
  let encoded = link;
  if (link.includes("/share/")) {
    const parts = link.split("/share/");
    encoded = parts[parts.length - 1];
  }
  if (link.includes("?share=")) {
    const url = new URL(link);
    encoded = url.searchParams.get("share") ?? encoded;
  }
  if (!encoded.startsWith(TC1_PREFIX)) {
    throw new Error(`Invalid share link format. Expected prefix '${TC1_PREFIX}'`);
  }
  const base64Data = encoded.slice(TC1_PREFIX.length);
  const jsonString = base64UrlDecode(base64Data);
  const data = JSON.parse(jsonString) as EncodedShareData;
  if (data.version !== 1) {
    throw new Error(`Unsupported share link version: ${data.version}`);
  }
  return data;
}

/**
 * Result of receiving a share link.
 */
export interface ShareReceiveResult<T = unknown> {
  data: T;
  delegation: Delegation;
  path: string;
  spaceId: string;
}

// TinyCloudWeb

export class TinyCloudWeb {
  /** The Ethereum provider */
  public provider!: providers.Web3Provider;

  /** Supported RPC Providers */
  public static RPCProviders = RPCProviders;

  /** Underlying TinyCloudNode (created after WASM init) */
  private _node: TinyCloudNode | null = null;

  /** Browser notification handler */
  private notificationHandler: BrowserNotificationHandler;

  /** Browser WASM bindings */
  private wasmBindings: BrowserWasmBindings;

  /** Browser wallet signer */
  private walletSigner?: BrowserWalletSigner;

  /** Promise that resolves when WASM + node are ready */
  private _initPromise: Promise<void>;

  /** User config */
  private config: Config;

  /**
   * App manifest stored from config (or updated via `setManifest`).
   *
   * `requestPermissions` reads this for the modal title/icon and for
   * composing an expanded manifest on approve. `_init` forwards this
   * value into the underlying {@link TinyCloudNode} so `signIn()`
   * drives its SIWE recap from the manifest. `setManifest` mirrors
   * any post-construction updates onto the node so the next sign-in
   * picks them up.
   */
  private _manifest?: Manifest;

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
    }) => Promise<{ approved: boolean }>;
    signIn?: () => Promise<ClientSession>;
    signOut?: () => Promise<void>;
  };

  constructor(config: Config = {}) {
    this.config = config;
    this._manifest = config.manifest;

    // Initialize browser notification handler
    this.notificationHandler = new BrowserNotificationHandler(config.notifications);

    // Create browser WASM bindings
    this.wasmBindings = new BrowserWasmBindings();

    // Set up browser wallet signer if provider given
    const providerDriver = config.provider ?? config.providers?.web3?.driver;
    if (providerDriver) {
      this.walletSigner = new BrowserWalletSigner(providerDriver);
      this.provider = this.walletSigner.getProvider();
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

    const nodeConfig: TinyCloudNodeConfig = {
      host: this.config.tinycloudHosts?.[0] ?? "https://node.tinycloud.xyz",
      domain: this.config.domain ?? (typeof window !== 'undefined' ? window.location.hostname : 'app.tinycloud.xyz'),
      prefix: this.config.spacePrefix,
      autoCreateSpace: this.config.autoCreateSpace ?? true,
      sessionExpirationMs: this.config.sessionExpirationMs,
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
    };

    // Wire up signer if available
    if (this.walletSigner) {
      nodeConfig.signer = this.walletSigner;
      nodeConfig.ensResolver = new BrowserENSResolver(this.provider);
    }

    // Space creation handler
    nodeConfig.spaceCreationHandler =
      this.config.spaceCreationHandler ?? new ModalSpaceCreationHandler();

    this._node = new TinyCloudNode(nodeConfig);
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
  get duckdb(): IDuckDbService { return this.node.duckdb; }
  get hooks(): IHooksService { return this.node.hooks; }
  get vault(): IDataVaultService { return this.node.vault; }
  get spaces(): ISpaceService { return this.node.spaces; }
  get sharing(): ISharingService { return this.node.sharing; }
  get delegations(): DelegationManager { return this.node.delegationManager; }
  get capabilityRegistry(): ICapabilityKeyRegistry { return this.node.capabilityRegistry; }
  get spaceId(): string | undefined { return this._node?.spaceId; }

  space(nameOrUri: string): ISpace { return this.spaces.get(nameOrUri); }
  get kvPrefix(): string { return this.config.kvPrefix || ""; }

  // ===========================================================================
  // Auth Methods (delegate to TinyCloudNode)
  // ===========================================================================

  signIn = async (): Promise<ClientSession> => {
    const node = await this.ensureNode();
    await node.signIn();
    const session = node.session;
    if (!session) throw new Error("Sign-in completed but no session available");
    return {
      address: session.address,
      walletAddress: session.address,
      chainId: session.chainId,
      sessionKey: session.sessionKey,
      siwe: session.siwe,
      signature: session.signature,
    };
  };

  signOut = async (): Promise<void> => {
    this.notificationHandler.cleanup?.();
  };

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

  get did(): string { return this.node.did; }
  get sessionDid(): string { return this.node.sessionDid; }
  get isSessionOnly(): boolean { return this.node.isSessionOnly; }
  get isWalletConnected(): boolean { return this.walletSigner !== undefined; }

  // ===========================================================================
  // Extension & Lifecycle
  // ===========================================================================

  extend(_extension: Extension): void {
    // Not yet implemented — TinyCloudNode.extend() needed
  }

  cleanup(): void {
    this.notificationHandler.cleanup?.();
  }

  connectWallet(
    provider: providers.ExternalProvider | providers.Web3Provider,
    options?: { spacePrefix?: string }
  ): void {
    this.walletSigner = new BrowserWalletSigner(provider);
    this.provider = this.walletSigner.getProvider();
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
    const node = await this.ensureNode();
    return node.createDelegation(params);
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
   *
   * Current limitation: exactly one {@link PermissionEntry} per call.
   */
  delegateTo = async (
    did: string,
    permissions: PermissionEntry[],
    options?: DelegateToOptions,
  ): Promise<DelegateToResult> => {
    const node = await this.ensureNode();
    return node.delegateTo(did, permissions, options);
  };

  /**
   * Get the stored manifest (if any). Returns a shallow clone so callers
   * can't accidentally mutate our internal state.
   */
  getManifest(): Manifest | undefined {
    if (this._manifest === undefined) return undefined;
    return { ...this._manifest };
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
  setManifest(manifest: Manifest): void {
    this._manifest = manifest;
    // Forward eagerly if the node is already up. Pre-init, the
    // manifest rides into the constructor via `nodeConfig.manifest`
    // inside `_init`, which reads `this._manifest` at that time.
    if (this._node) {
      this._node.setManifest(manifest);
    }
  }

  /**
   * Request additional permissions on top of the currently-signed
   * session. Shows a confirmation modal; on approve, signs out the
   * current session (without disconnecting the wallet) and runs a fresh
   * `signIn` with the composed manifest. On decline, returns
   * `{ approved: false }` with no state changes.
   *
   * Spec: `.claude/specs/capability-chain.md` §requestPermissions.
   *
   * On approve, this composes the expanded manifest, signs out the
   * current session, and calls `signIn()` — which now drives its
   * SIWE recap from `this._manifest` directly, so the fresh session
   * is signed with the expanded capability set in a single wallet
   * prompt.
   */
  async requestPermissions(
    additional: PermissionEntry[],
  ): Promise<RequestPermissionsResult> {
    // Shared validation (also called by the core). Keeping the guard
    // here short-circuits before any manifest lookup so the error text
    // is unambiguous.
    validateAdditionalPermissions(additional);

    const manifest = this._manifest;
    // Escalation requires a stored manifest because we need to
    // compose the expanded permission set from the current app's
    // declared permissions. Apps that signed in without a manifest
    // must set one via `setManifest` before escalating.
    if (manifest === undefined) {
      throw new Error(
        "requestPermissions requires a stored manifest. Pass `manifest` in the TinyCloudWeb config or call setManifest() before requesting escalation.",
      );
    }

    // Delegate to the pure core with injected dependencies. Test hooks
    // override any or all of them; production defaults wire to the real
    // modal manager and the class's own signOut/signIn methods.
    //
    // `writeManifest` mirrors the updated manifest onto BOTH `_manifest`
    // and the underlying node so the subsequent `signIn()` call picks
    // it up automatically. Updating only `_manifest` would leave the
    // node still configured with the pre-escalation manifest, and the
    // new sign-in would grant the old capability set.
    return requestPermissionsCore(additional, {
      manifest,
      showModal: this._testHooks?.showModal ?? showPermissionRequestModal,
      signOut: this._testHooks?.signOut ?? (() => this.signOut()),
      signIn: this._testHooks?.signIn ?? (() => this.signIn()),
      writeManifest: (next) => {
        this._manifest = next;
        this._node?.setManifest(next);
      },
    });
  }

  async useDelegation(delegation: PortableDelegation): Promise<DelegatedAccess> {
    const node = await this.ensureNode();
    return node.useDelegation(delegation);
  }

  async createSubDelegation(
    parentDelegation: PortableDelegation,
    params: {
      path: string;
      actions: string[];
      delegateDID: string;
      disableSubDelegation?: boolean;
      expiryMs?: number;
    }
  ): Promise<PortableDelegation> {
    const node = await this.ensureNode();
    return node.createSubDelegation(parentDelegation, params);
  }

  async delegate(params: CreateDelegationParams): Promise<Result<Delegation, DelegationError>> {
    const node = await this.ensureNode();
    return node.delegate(params);
  }

  async revokeDelegation(cid: string): Promise<Result<void, DelegationError>> {
    const node = await this.ensureNode();
    return node.revokeDelegation(cid);
  }

  async listDelegations(): Promise<Result<Delegation[], DelegationError>> {
    const node = await this.ensureNode();
    return node.listDelegations();
  }

  async checkPermission(path: string, action: string): Promise<Result<boolean, DelegationError>> {
    const node = await this.ensureNode();
    return node.checkPermission(path, action);
  }

  // ===========================================================================
  // Static Methods
  // ===========================================================================

  /**
   * Receive and retrieve data from a v2 share link.
   * Static method — no auth required. Uses browser WASM.
   */
  public static async receiveShare<T = unknown>(
    link: string,
    key?: string
  ): Promise<Result<ShareReceiveResult<T>, DelegationError>> {
    await WasmInitializer.ensureInitialized();

    try {
      const shareData = decodeShareLink(link);

      if (!shareData.key || !shareData.key.d) {
        return {
          ok: false,
          error: {
            code: "INVALID_TOKEN",
            message: "Share link does not contain a valid private key",
            service: "delegation",
          },
        };
      }

      const expiry = new Date(shareData.delegation.expiry);
      if (expiry < new Date()) {
        return {
          ok: false,
          error: {
            code: "AUTH_EXPIRED",
            message: "Share link has expired",
            service: "delegation",
          },
        };
      }

      if (shareData.delegation.isRevoked) {
        return {
          ok: false,
          error: {
            code: "REVOKED",
            message: "Share link has been revoked",
            service: "delegation",
          },
        };
      }

      let authToken = shareData.delegation.authHeader ?? shareData.delegation.cid;
      if (authToken.startsWith("Bearer ")) {
        authToken = authToken.slice(7);
      }

      const session: ServiceSession = {
        delegationHeader: { Authorization: authToken },
        delegationCid: shareData.delegation.cid,
        spaceId: shareData.spaceId,
        verificationMethod: shareData.keyDid,
        jwk: shareData.key,
      };

      // Register delegation with server
      const delegateResponse = await globalThis.fetch(
        `${shareData.host}/delegate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authToken,
          },
        }
      );

      if (!delegateResponse.ok) {
        const errorText = await delegateResponse.text();
        return {
          ok: false as const,
          error: {
            code: "DELEGATION_FAILED",
            message: `Failed to register delegation: ${delegateResponse.status} - ${errorText}`,
            service: "delegation" as const,
          },
        };
      }

      const context = new ServiceContext({
        invoke,
        fetch: globalThis.fetch.bind(globalThis),
        hosts: [shareData.host],
      });
      context.setSession(session);

      const kvService = new KVService({ prefix: "" });
      kvService.initialize(context);

      const fetchKey = key ?? shareData.path;
      const kvResult = await kvService.get<T>(fetchKey);

      if (kvResult.ok) {
        return {
          ok: true as const,
          data: {
            data: kvResult.data.data,
            delegation: shareData.delegation,
            path: shareData.path,
            spaceId: shareData.spaceId,
          },
        };
      }

      const errorResult = kvResult as { ok: false; error: { message: string; cause?: Error } };
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
