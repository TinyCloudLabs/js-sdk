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

import { TinyCloudNode, TinyCloudNodeConfig } from "@tinycloud/node-sdk/core";
import {
  IKVService,
  ISQLService,
  IDuckDbService,
  IDataVaultService,
  ISpaceService,
  ISpace,
  ISharingService,
  ICapabilityKeyRegistry,
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
} from "@tinycloud/sdk-core";
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

  constructor(config: Config = {}) {
    this.config = config;

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
  get vault(): IDataVaultService { return this.node.vault; }
  get spaces(): ISpaceService { return this.node.spaces; }
  get sharing(): ISharingService { return this.node.sharing; }
  get delegations(): DelegationManager { return this.node.delegationManager; }
  get capabilityRegistry(): ICapabilityKeyRegistry { return this.node.capabilityRegistry; }

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
