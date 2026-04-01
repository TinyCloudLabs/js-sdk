import { EventEmitter } from "events";
import {
  IUserAuthorization,
  ISigner,
  ISessionStorage,
  ClientSession,
  Extension,
  PersistedSessionData,
  TinyCloudSession,
  SiweConfig,
  fetchPeerId,
  submitHostDelegation,
  activateSessionWithHost,
  checkNodeInfo,
  ISpaceCreationHandler,
  AutoApproveSpaceCreationHandler,
  IWasmBindings,
  ISessionManager,
} from "@tinycloud/sdk-core";
import {
  SignStrategy,
  SignRequest,
  SignResponse,
  defaultSignStrategy,
} from "./strategies";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

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
  /** TinyCloud server endpoints (default: ["https://node.tinycloud.xyz"]) */
  tinycloudHosts?: string[];
  /** Whether to include public space capabilities in the session (default: true) */
  enablePublicSpace?: boolean;
  /** WASM bindings for cryptographic operations. Required. */
  wasmBindings: IWasmBindings;
  /** Optional SIWE configuration overrides (e.g., nonce for server-provided nonces) */
  siweConfig?: SiweConfig;
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
  private readonly tinycloudHosts: string[];
  private readonly enablePublicSpace: boolean;
  private readonly siweConfig?: SiweConfig;
  private readonly wasm: IWasmBindings;

  private sessionManager: ISessionManager;
  private extensions: Extension[] = [];
  private _session?: ClientSession;
  private _tinyCloudSession?: TinyCloudSession;
  private _address?: string;
  private _chainId?: number;
  private _nodeFeatures: string[] = [];

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
        "": [
          "tinycloud.kv/put",
          "tinycloud.kv/get",
          "tinycloud.kv/del",
          "tinycloud.kv/list",
          "tinycloud.kv/metadata",
        ],
      },
      sql: {
        "": [
          "tinycloud.sql/read",
          "tinycloud.sql/write",
          "tinycloud.sql/admin",
          "tinycloud.sql/export",
        ],
      },
      duckdb: {
        "": [
          "tinycloud.duckdb/read",
          "tinycloud.duckdb/write",
          "tinycloud.duckdb/admin",
          "tinycloud.duckdb/describe",
          "tinycloud.duckdb/export",
          "tinycloud.duckdb/import",
          "tinycloud.duckdb/execute",
        ],
      },
      capabilities: {
        "": ["tinycloud.capabilities/read"],
      },
    };
    this.sessionExpirationMs = config.sessionExpirationMs ?? 60 * 60 * 1000;
    this.autoCreateSpace = config.autoCreateSpace ?? false;
    this.spaceCreationHandler = config.spaceCreationHandler;
    this.tinycloudHosts = config.tinycloudHosts ?? ["https://node.tinycloud.xyz"];
    this.enablePublicSpace = config.enablePublicSpace ?? true;
    this.siweConfig = config.siweConfig;

    // Initialize session manager via WASM bindings
    this.sessionManager = this.wasm.createSessionManager();
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

  get nodeFeatures(): string[] {
    return this._nodeFeatures;
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
  private async hostSpace(targetSpaceId?: string): Promise<boolean> {
    if (!this._tinyCloudSession || !this._address || !this._chainId) {
      throw new Error("Must be signed in to host space");
    }

    const host = this.tinycloudHosts[0];
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
    const signature = await this.signMessage(siwe);

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

    const host = this.tinycloudHosts[0];
    const primarySpaceId = this._tinyCloudSession.spaceId;

    // Try to activate the session
    const result = await activateSessionWithHost(
      host,
      this._tinyCloudSession.delegationHeader
    );

    // Determine the effective space creation handler:
    // 1. Explicit spaceCreationHandler takes precedence
    // 2. autoCreateSpace: true uses AutoApproveSpaceCreationHandler
    // 3. Otherwise, no handler (space creation skipped silently)
    const handler: ISpaceCreationHandler | undefined = this.spaceCreationHandler
      ?? (this.autoCreateSpace ? new AutoApproveSpaceCreationHandler() : undefined);

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
        handler.onSpaceCreationFailed?.(creationContext, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }

      // Small delay to allow space creation to propagate
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Retry activation
      const retryResult = await activateSessionWithHost(
        host,
        this._tinyCloudSession.delegationHeader
      );

      if (!retryResult.success) {
        const err = new Error(
          `Failed to activate session after creating space: ${retryResult.error}`
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
        handler.onSpaceCreationFailed?.(creationContext, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      const retryResult = await activateSessionWithHost(
        host,
        this._tinyCloudSession.delegationHeader
      );

      if (!retryResult.success) {
        const err = new Error(
          `Failed to activate session after creating space: ${retryResult.error}`
        );
        handler.onSpaceCreationFailed?.(creationContext, err);
        throw err;
      }

      handler.onSpaceCreated?.(creationContext);
      return;
    }

    throw new Error(`Failed to activate session: ${result.error}`);
  }

  /**
   * Sign in and create a new session.
   *
   * This follows the correct SIWE-ReCap flow:
   * 1. Create session key and get JWK
   * 2. Call prepareSession() which generates the SIWE with ReCap capabilities
   * 3. Sign the SIWE string from prepareSession
   * 4. Call completeSessionSetup() with the prepared session + signature
   */
  async signIn(): Promise<ClientSession> {
    // Get signer address and chain ID
    this._address = await this.signer.getAddress();
    this._chainId = await this.signer.getChainId();

    const address = this.wasm.ensureEip55(this._address);
    const chainId = this._chainId;

    // Create a session key
    const keyId = `session-${Date.now()}`;
    this.sessionManager.renameSessionKeyId("default", keyId);

    // Get JWK for session key
    const jwkString = this.sessionManager.jwk(keyId);
    if (!jwkString) {
      throw new Error("Failed to create session key");
    }
    const jwk = JSON.parse(jwkString);

    // Create space ID
    const spaceId = this.wasm.makeSpaceId(address, chainId, this.spacePrefix);

    const now = new Date();
    const expirationTime = new Date(now.getTime() + this.sessionExpirationMs);

    // Prepare session - this creates the SIWE message with ReCap capabilities
    const prepared = this.wasm.prepareSession({
      abilities: this.defaultActions,
      address,
      chainId,
      domain: this.domain,
      uri: this.uri,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      jwk,
      ...this.siweConfig,
    });

    // Sign the SIWE message from prepareSession (NOT a separately generated SIWE)
    const signature = await this.requestSignature({
      address,
      chainId,
      message: prepared.siwe,
      type: "siwe",
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
    const spacesMetadata: Record<string, string> | undefined =
        this.enablePublicSpace
            ? { public: this.wasm.makeSpaceId(address, chainId, "public") }
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
    };
    await this.sessionStorage.save(address, persistedData);

    // Set current session
    this._session = clientSession;
    this._tinyCloudSession = tinyCloudSession;
    this._address = address;
    this._chainId = chainId;

    // Verify SDK-node protocol compatibility and discover supported features
    const nodeInfo = await checkNodeInfo(this.tinycloudHosts[0], this.wasm.protocolVersion());
    this._nodeFeatures = nodeInfo.features;

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
  async signMessage(message: string): Promise<string> {
    if (!this._address) {
      this._address = await this.signer.getAddress();
    }
    if (!this._chainId) {
      this._chainId = await this.signer.getChainId();
    }

    return this.requestSignature({
      address: this._address,
      chainId: this._chainId,
      message,
      type: "message",
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
    const address = this.wasm.ensureEip55(await this.signer.getAddress());
    const chainId = await this.signer.getChainId();

    // Create a session key
    const keyId = `session-${Date.now()}`;
    this.sessionManager.renameSessionKeyId("default", keyId);

    // Get JWK for session key
    const jwkString = this.sessionManager.jwk(keyId);
    if (!jwkString) {
      throw new Error("Failed to create session key");
    }
    const jwk = JSON.parse(jwkString);

    // Create space ID
    const spaceId = this.wasm.makeSpaceId(address, chainId, this.spacePrefix);

    const now = new Date();
    const expirationTime = new Date(now.getTime() + this.sessionExpirationMs);

    // Prepare session - this creates the SIWE message with ReCap capabilities
    const prepared = this.wasm.prepareSession({
      abilities: this.defaultActions,
      address,
      chainId,
      domain: this.domain,
      uri: this.uri,
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
      spaceId,
      jwk,
      ...this.siweConfig,
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
    const address = this.wasm.ensureEip55(await this.signer.getAddress());
    const chainId = await this.signer.getChainId();

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
    const spacesMetadata: Record<string, string> | undefined =
        this.enablePublicSpace
            ? { public: this.wasm.makeSpaceId(address, chainId, "public") }
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
    };
    await this.sessionStorage.save(address, persistedData);

    // Set current session
    this._session = clientSession;
    this._tinyCloudSession = tinyCloudSession;
    this._address = address;
    this._chainId = chainId;

    // Verify SDK-node protocol compatibility and discover supported features
    const nodeInfo = await checkNodeInfo(this.tinycloudHosts[0], this.wasm.protocolVersion());
    this._nodeFeatures = nodeInfo.features;

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
            response.reason ?? "Sign request rejected by callback"
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
          this.signStrategy.timeout ?? 60000
        );
      }

      default:
        throw new Error(`Unknown sign strategy: ${(this.signStrategy as any).type}`);
    }
  }

  /**
   * Request signature via event emitter with timeout.
   */
  private requestSignatureViaEmitter(
    request: SignRequest,
    emitter: EventEmitter,
    timeout: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("Sign request timed out"));
      }, timeout);

      const respond = async (response: SignResponse) => {
        clearTimeout(timeoutId);
        if (!response.approved) {
          reject(
            new Error(response.reason ?? "Sign request rejected via emitter")
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
