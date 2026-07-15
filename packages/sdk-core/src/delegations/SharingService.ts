/**
 * SharingService - v2 sharing link service with embedded private keys.
 *
 * This service implements the v2 sharing specification, which embeds private keys
 * directly in sharing links. This allows recipients to exercise delegations
 * without requiring prior session setup.
 *
 * Key differences from v1 SharingLinks:
 * - Private keys are embedded in the link (not just tokens)
 * - Recipients can optionally sub-delegate to their own session key
 * - Pre-configured KV service returned for immediate use
 *
 * @packageDocumentation
 */

import type {
  IKVService,
  ServiceSession,
  InvokeFunction,
  FetchFunction,
} from "@tinycloud/sdk-services";
import type {
  Result,
  DelegationError,
  Delegation,
  KeyInfo,
  KeyProvider,
  GenerateShareParams,
  ShareLink,
  ShareLinkData,
  ShareSchema,
  JWK,
  IngestOptions,
  CreateDelegationParams,
  CreateDelegationWasmParams,
  CreateDelegationWasmResult,
} from "./types";
import { DelegationErrorCodes } from "./types";
import type { DelegationManager } from "./DelegationManager";
import type { ICapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import { validateEncodedShareData } from "./SharingService.schema.js";
import { SERVICE_LONG_TO_SHORT } from "../manifest";
import { principalDid } from "../identity";
import { actionContains } from "../capabilities";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Infer the short-form service name (`"kv"`, `"sql"`, etc) that all of the
 * given full-URN action strings belong to.
 *
 * SharingService issues single-service delegations (KV-only, SQL-only, …) —
 * the multi-resource WASM `createDelegation` call requires the service
 * segment explicitly because it's keyed separately from the action list.
 * This helper extracts the namespace half (`"tinycloud.kv"`) from each URN,
 * maps it to the short form via {@link SERVICE_LONG_TO_SHORT}, and returns
 * `undefined` if the actions are not all from the same known service.
 *
 * Returning `undefined` is intentional: the caller must surface a clear
 * error rather than guessing.
 */
function inferShortServiceFromActionUrns(
  actions: readonly string[]
): string | undefined {
  let short: string | undefined;
  for (const action of actions) {
    const slash = action.indexOf("/");
    if (slash === -1) return undefined;
    const longService = action.slice(0, slash);
    const candidate = SERVICE_LONG_TO_SHORT[longService];
    if (candidate === undefined) return undefined;
    if (short === undefined) {
      short = candidate;
    } else if (short !== candidate) {
      return undefined;
    }
  }
  return short;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default actions for read-only sharing links.
 */
const DEFAULT_READ_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/metadata"];

/**
 * Default expiry for share links — SHARE tier (see ../expiry.ts).
 */
import { EXPIRY } from "../expiry";
const DEFAULT_EXPIRY_MS = EXPIRY.SHARE_MS;

/**
 * Prefix for the base64 schema.
 */
const BASE64_PREFIX = "tc1:";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Creates a DelegationError with the given parameters.
 */
function createError(
  code: string,
  message: string,
  cause?: Error,
  meta?: Record<string, unknown>
): DelegationError {
  return {
    code,
    message,
    service: "delegation",
    cause,
    meta,
  };
}

/**
 * Base64 encode for URLs (URL-safe base64).
 */
function base64UrlEncode(data: string): string {
  // Use btoa for browser, Buffer for Node.js
  let base64: string;
  if (typeof btoa !== "undefined") {
    base64 = btoa(unescape(encodeURIComponent(data)));
  } else if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(data, "utf-8").toString("base64");
  } else {
    throw new Error("No base64 encoding available");
  }
  // Make URL-safe
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64 decode for URLs (URL-safe base64).
 */
function base64UrlDecode(encoded: string): string {
  // Restore standard base64
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (base64.length % 4) {
    base64 += "=";
  }
  // Decode
  if (typeof atob !== "undefined") {
    return decodeURIComponent(escape(atob(base64)));
  } else if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").toString("utf-8");
  } else {
    throw new Error("No base64 decoding available");
  }
}

// =============================================================================
// Types
// =============================================================================

/**
 * Data encoded in a sharing link.
 */
export interface EncodedShareData {
  /** Private key in JWK format (includes d parameter) */
  key: JWK;
  /** DID of the key */
  keyDid: string;
  /** The delegation granting access */
  delegation: Delegation;
  /** Resource path this link grants access to */
  path: string;
  /** TinyCloud host URL */
  host: string;
  /** Space ID */
  spaceId: string;
  /** Schema version */
  version: 1;
}

/**
 * Options for receiving a sharing link.
 */
export interface ReceiveOptions {
  /**
   * Whether to automatically create a sub-delegation to the current session key.
   * Default: true
   */
  autoSubdelegate?: boolean;
  /**
   * Whether to use the current session key for operations (requires autoSubdelegate).
   * Default: true
   */
  useSessionKey?: boolean;
  /**
   * Ingestion options passed to CapabilityKeyRegistry.
   */
  ingestOptions?: IngestOptions;
}

/**
 * Result of receiving a sharing link.
 */
export interface ShareAccess {
  /** The delegation that was received/created */
  delegation: Delegation;
  /** Key info for the received key */
  key: KeyInfo;
  /** Pre-configured KV service for the shared path */
  kv: IKVService;
  /** The space ID */
  spaceId: string;
  /** The path prefix for this share */
  path: string;
}

/**
 * Parameters for attenuating a received share to another principal.
 *
 * Omitted path/actions/expiry inherit the received share's exact values. Any
 * supplied value must be equal to or an attenuated subset of the parent.
 */
export interface DelegateReceivedShareParams {
  /** DID that may exercise the child delegation. */
  delegateDID: string;
  /** Equal to or below the shared path. Defaults to the shared path. */
  path?: string;
  /** Subset of the shared actions. Defaults to all shared actions. */
  actions?: string[];
  /** No later than the sharing-link expiry. Defaults to the parent expiry. */
  expiry?: Date;
  /** Optional node origin that further narrows the configured-host allowlist. */
  expectedHost?: string;
}

/**
 * A transport-ready child delegation with non-secret source lineage.
 *
 * `delegation.delegationHeader` is a live bearer credential. Treat it like a
 * secret: do not log it or persist it outside secure credential storage.
 * Only `source` is safe to retain as non-secret lineage metadata.
 */
export interface DelegatedShareAccess {
  delegation: Delegation & {
    delegationHeader: { Authorization: string };
    ownerAddress: string;
    chainId: number;
    host: string;
    resources: Array<{ service: string; space: string; path: string; actions: string[] }>;
    disableSubDelegation: boolean;
  };
  source: {
    parentCid: string;
    spaceId: string;
    path: string;
    host: string;
    expiresAt: Date;
  };
}

/**
 * Configuration for SharingService.
 */
export interface SharingServiceConfig {
  /** TinyCloud host URLs */
  hosts: string[];
  /**
   * Active session for authentication.
   * Required for generate(), optional for receive().
   */
  session?: ServiceSession;
  /** Platform-specific invoke function */
  invoke: InvokeFunction;
  /** Optional custom fetch implementation */
  fetch?: FetchFunction;
  /** Key provider for cryptographic operations */
  keyProvider: KeyProvider;
  /** Capability key registry for key/delegation management */
  registry: ICapabilityKeyRegistry;
  /**
   * Delegation manager for creating delegations (used if createDelegation not provided).
   * Required for generate(), optional for receive().
   */
  delegationManager?: DelegationManager;
  /** Factory for creating KV service instances */
  createKVService: (config: {
    hosts: string[];
    session: ServiceSession;
    invoke: InvokeFunction;
    fetch?: FetchFunction;
    pathPrefix?: string;
  }) => IKVService;
  /** Base URL for sharing links (e.g., "https://share.myapp.com") */
  baseUrl?: string;
  /**
   * Custom delegation creation function. When provided, this is used instead
   * of delegationManager.create(). This allows platforms to use their own
   * delegation creation logic (e.g., SIWE-based /delegate endpoint).
   */
  createDelegation?: (params: CreateDelegationParams) => Promise<Result<Delegation, DelegationError>>;
  /**
   * WASM function for client-side delegation creation.
   * When provided, this is preferred over server-side creation (createDelegation/delegationManager).
   * Creates UCAN delegations directly without requiring server roundtrip.
   */
  createDelegationWasm?: (params: CreateDelegationWasmParams) => CreateDelegationWasmResult;
  /** Compute a CID for serialized delegation bytes. Required for share attenuation. */
  computeCid?: (data: Uint8Array, codec: bigint) => string;
  /**
   * Path prefix for KV operations.
   * When set, paths passed to generate() are prefixed with this value.
   * This ensures the share path matches the session's authorized paths.
   */
  pathPrefix?: string;
  /**
   * Session expiry time.
   * When set, sharing link expiry is clamped to not exceed this value
   * unless onRootDelegationNeeded is provided and returns a new delegation.
   */
  sessionExpiry?: Date;
  /**
   * Callback to create a DIRECT delegation from the root (wallet) to a share key.
   * This bypasses the session delegation chain, allowing share links with
   * expiry longer than the current session.
   *
   * When provided and share expiry > session expiry:
   * 1. SharingService creates the ephemeral share key
   * 2. This callback is invoked with the share key DID
   * 3. The callback signs a direct PKH -> share key delegation with the wallet
   * 4. The returned delegation is used for the share link
   *
   * This is the CORRECT solution for long-lived share links because:
   * - It creates a fresh delegation chain: PKH -> share key
   * - Not constrained by session expiry (no sub-delegation from session key)
   *
   * @param params - Parameters for creating the root delegation
   * @returns The delegation from wallet to share key, or undefined to fall back to session extension
   */
  onRootDelegationNeeded?: (params: {
    /** DID of the share key to delegate to */
    shareKeyDID: string;
    /** Space ID */
    spaceId: string;
    /** Path to grant access to */
    path: string;
    /** Actions to grant */
    actions: string[];
    /** Requested expiry time */
    requestedExpiry: Date;
  }) => Promise<Delegation | undefined>;
  /** Reject operations after the host session/service graph has been retired. */
  assertActive?: () => void;
}

/**
 * Interface for the SharingService.
 */
export interface ISharingService {
  /**
   * Generate a sharing link with an embedded private key.
   *
   * This creates a new session key, delegates to it, and encodes
   * the key and delegation into a shareable link.
   */
  generate(params: GenerateShareParams): Promise<Result<ShareLink, DelegationError>>;

  /**
   * Receive and activate a sharing link.
   *
   * Decodes the link, ingests the key into the registry, and optionally
   * creates a sub-delegation to the current session key.
   */
  receive(link: string, options?: ReceiveOptions): Promise<Result<ShareAccess, DelegationError>>;

  /**
   * Consume a sharing link locally and create an attenuated child delegation.
   * The raw link and embedded private JWK are never returned. The returned
   * child delegation is itself a sensitive bearer credential.
   */
  delegateReceivedShare(
    link: string,
    params: DelegateReceivedShareParams
  ): Promise<Result<DelegatedShareAccess, DelegationError>>;

  /**
   * Encode sharing data into a link string.
   */
  encodeLink(data: EncodedShareData, schema?: ShareSchema): string;

  /**
   * Decode a link string into sharing data.
   */
  decodeLink(link: string): EncodedShareData;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * SharingService - v2 sharing link service with embedded private keys.
 *
 * @example
 * ```typescript
 * import { SharingService } from "@tinycloud/sdk-core/delegations";
 *
 * const sharing = new SharingService({
 *   hosts: ["https://node.tinycloud.xyz"],
 *   session,
 *   invoke,
 *   keyProvider,
 *   registry,
 *   delegationManager,
 *   createKVService,
 *   baseUrl: "https://share.myapp.com"
 * });
 *
 * // Generate a sharing link
 * const result = await sharing.generate({
 *   path: "/kv/documents/report.pdf",
 *   actions: ["tinycloud.kv/get"],
 *   expiry: new Date("2024-12-31")
 * });
 *
 * if (result.ok) {
 *   console.log("Share this URL:", result.data.url);
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
export class SharingService implements ISharingService {
  private hosts: string[];
  private session?: ServiceSession;
  private invoke: InvokeFunction;
  private fetchFn: FetchFunction;
  private keyProvider: KeyProvider;
  private registry: ICapabilityKeyRegistry;
  private delegationManager?: DelegationManager;
  private createKVService: SharingServiceConfig["createKVService"];
  private baseUrl: string;
  private createDelegationFn?: SharingServiceConfig["createDelegation"];
  private createDelegationWasmFn?: SharingServiceConfig["createDelegationWasm"];
  private computeCidFn?: SharingServiceConfig["computeCid"];
  private pathPrefix: string;
  private sessionExpiry?: Date;
  private onRootDelegationNeeded?: SharingServiceConfig["onRootDelegationNeeded"];
  private assertActiveFn?: SharingServiceConfig["assertActive"];

  /**
   * Creates a new SharingService instance.
   */
  constructor(config: SharingServiceConfig) {
    this.hosts = config.hosts;
    this.session = config.session;
    this.invoke = config.invoke;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.keyProvider = config.keyProvider;
    this.registry = config.registry;
    this.delegationManager = config.delegationManager;
    this.createKVService = config.createKVService;
    this.baseUrl = (config.baseUrl ?? "").replace(/\/$/, ""); // Remove trailing slash
    this.createDelegationFn = config.createDelegation;
    this.createDelegationWasmFn = config.createDelegationWasm;
    this.computeCidFn = config.computeCid;
    this.pathPrefix = config.pathPrefix ?? "";
    this.sessionExpiry = config.sessionExpiry;
    this.onRootDelegationNeeded = config.onRootDelegationNeeded;
    this.assertActiveFn = config.assertActive;
  }

  /**
   * Gets the primary host URL.
   */
  private get host(): string {
    return this.hosts[0];
  }

  /**
   * Updates the session (e.g., after re-authentication).
   */
  public updateSession(session: ServiceSession): void {
    this.assertActiveFn?.();
    this.session = session;
  }

  /**
   * Updates the service configuration.
   * Used to add full capabilities (session, delegationManager, createDelegation, createDelegationWasm) after signIn.
   */
  public updateConfig(config: Partial<Pick<SharingServiceConfig, "session" | "delegationManager" | "createDelegation" | "createDelegationWasm" | "sessionExpiry" | "onRootDelegationNeeded" | "assertActive">>): void {
    this.assertActiveFn?.();
    if (config.session !== undefined) {
      this.session = config.session;
    }
    if (config.delegationManager !== undefined) {
      this.delegationManager = config.delegationManager;
    }
    if (config.createDelegation !== undefined) {
      this.createDelegationFn = config.createDelegation;
    }
    if (config.createDelegationWasm !== undefined) {
      this.createDelegationWasmFn = config.createDelegationWasm;
    }
    if (config.sessionExpiry !== undefined) {
      this.sessionExpiry = config.sessionExpiry;
    }
    if (config.onRootDelegationNeeded !== undefined) {
      this.onRootDelegationNeeded = config.onRootDelegationNeeded;
    }
    if (config.assertActive !== undefined) {
      this.assertActiveFn = config.assertActive;
    }
  }

  /**
   * Generate a sharing link with an embedded private key.
   *
   * Flow:
   * 1. Spawn new session key (unique per share)
   * 2. Create delegation from current session to spawned key
   * 3. Package: { key (with private!), delegation, path, host }
   * 4. Encode based on schema (base64 for now)
   * 5. Return link string
   */
  async generate(params: GenerateShareParams): Promise<Result<ShareLink, DelegationError>> {
    const activeError = this.retiredGraphError();
    if (activeError) return { ok: false, error: activeError };

    // Require session for generating (not for receiving)
    if (!this.session) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Session required for generating sharing links. Call signIn() first."
        ),
      };
    }

    // Require delegation capability
    if (!this.createDelegationWasmFn && !this.createDelegationFn && !this.delegationManager) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "DelegationManager, createDelegation, or createDelegationWasm function required for generating sharing links."
        ),
      };
    }

    // Validate path
    if (!params.path) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "path is required"
        ),
      };
    }

    const actions = params.actions ?? DEFAULT_READ_ACTIONS;
    const requestedExpiry = params.expiry ?? new Date(Date.now() + DEFAULT_EXPIRY_MS);
    let expiry = requestedExpiry;

    const schema: ShareSchema = params.schema ?? "base64";

    // Build full path with prefix (matches how KVService stores data)
    // If pathPrefix is "demo-app" and path is "hello", fullPath is "demo-app/hello"
    const fullPath = this.pathPrefix
      ? `${this.pathPrefix}/${params.path}`.replace(/\/+/g, "/") // Normalize slashes
      : params.path;

    // Only base64 schema is implemented in v1
    if (schema !== "base64") {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          `Schema '${schema}' not implemented. Only 'base64' is supported.`
        ),
      };
    }

    // Step 1: Spawn a new session key unique to this share
    // We create this FIRST so we can pass its DID to onRootDelegationNeeded if needed
    let keyId: string;
    let keyDid: string;
    let keyJwk: JWK;

    try {
      const shareKeyName = `share:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;
      keyId = await this.keyProvider.createSessionKey(shareKeyName);
      keyDid = await this.keyProvider.getDID(keyId);
      keyJwk = this.keyProvider.getJWK(keyId) as JWK;

      // Ensure the private key is included
      if (!keyJwk.d) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.CREATION_FAILED,
            "KeyProvider did not return private key (d parameter) in JWK"
          ),
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.CREATION_FAILED,
          `Failed to generate session key for share: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        ),
      };
    }

    // Step 2: Check if any existing key can satisfy this delegation
    // Only prompt for root delegation if NO existing key in the registry can handle it
    let delegation: Delegation;
    // Strip fragment from DID URL to get plain DID for UCAN audience
    // getDID() returns "did:key:z6Mk...#z6Mk..." but audience needs "did:key:z6Mk..."
    const plainDID = keyDid.split('#')[0];

    // Helper to handle delegation result (returns early on error)
    const handleDelegationResult = (
      result: Awaited<ReturnType<typeof this.createSessionDelegation>>
    ): Delegation | { ok: false; error: DelegationError } => {
      if (result && typeof result === 'object' && 'ok' in result) {
        return result as { ok: false; error: DelegationError };
      }
      return result as Delegation;
    };

    // Check if any key in the registry can satisfy this delegation request
    // A key can satisfy the request if it has a delegation that:
    // 1. Covers the required path and actions
    // 2. Has sufficient expiry (delegation.expiry >= requestedExpiry)
    // 3. Allows sub-delegation
    const canSatisfyFromRegistry = this.findSuitableKeyForDelegation(
      fullPath,
      actions,
      requestedExpiry
    );

    if (canSatisfyFromRegistry) {
      // An existing key can satisfy this request - use session delegation (no prompt)
      const delegationResult = await this.createSessionDelegation(plainDID, fullPath, actions, expiry);
      const parsed = handleDelegationResult(delegationResult);
      if ('ok' in parsed && parsed.ok === false) {
        return parsed;
      }
      delegation = parsed as Delegation;
    } else if (this.onRootDelegationNeeded) {
      // No existing key can satisfy the request - try root delegation
      try {
        const rootDelegation = await this.onRootDelegationNeeded({
          shareKeyDID: plainDID,
          spaceId: this.session.spaceId,
          path: fullPath,
          actions,
          requestedExpiry,
        });

        if (rootDelegation) {
          delegation = rootDelegation;
          expiry = requestedExpiry;
        } else {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.PERMISSION_DENIED,
              "The active session ReCap does not authorize this sharing delegation.",
            ),
          };
        }
      } catch (err) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.PERMISSION_DENIED,
            "The active session ReCap does not authorize this sharing delegation.",
            err instanceof Error ? err : undefined,
          ),
        };
      }
    } else {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.PERMISSION_DENIED,
          "The active session ReCap does not authorize this sharing delegation.",
        ),
      };
    }

    // Step 3: Package the share data
    const shareData: EncodedShareData = {
      key: keyJwk,
      keyDid,
      delegation,
      path: fullPath,
      host: this.host,
      spaceId: this.session.spaceId,
      version: 1,
    };

    // Step 4: Encode the link
    const encodedData = this.encodeLink(shareData, schema);

    // Step 5: Build the full URL
    const baseUrl = params.baseUrl ?? this.baseUrl;
    const url = baseUrl ? `${baseUrl}/share/${encodedData}` : encodedData;

    const shareLink: ShareLink = {
      token: encodedData,
      url,
      delegation,
      schema,
      expiresAt: expiry,
      description: params.description,
    };

    return { ok: true, data: shareLink };
  }

  /**
   * Check if any key in the registry can satisfy the delegation request.
   * A key can satisfy if it has a delegation that:
   * 1. Covers the required path (exact match or parent path)
   * 2. Has all required actions
   * 3. Has sufficient expiry (delegation.expiry >= requestedExpiry)
   * 4. Allows sub-delegation
   * @internal
   */
  private findSuitableKeyForDelegation(
    path: string,
    actions: string[],
    requestedExpiry: Date
  ): boolean {
    // Check registry for keys with sufficient capabilities
    const allKeys = this.registry.getAllKeys();
    for (const key of allKeys) {
      const delegations = this.registry.getDelegationsForKey(key.id);
      for (const delegation of delegations) {
        // A registry can contain capabilities for several spaces. A share
        // created by this service may only spend authority for its own
        // session space.
        if (delegation.spaceId !== this.session?.spaceId) {
          continue;
        }

        // SharingService cannot reproduce arbitrary signed ReCap caveats when
        // issuing a child delegation.  Treat caveated authority as unusable
        // here rather than minting a broader child capability.
        if ((delegation.caveats?.length ?? 0) > 0) {
          continue;
        }

        // Check if delegation is valid and not expired
        if (!this.registry.isDelegationValid(delegation)) {
          continue;
        }

        // Check if delegation has sufficient expiry
        if (delegation.expiry < requestedExpiry) {
          continue;
        }

        // Check if delegation allows sub-delegation
        if (delegation.allowSubDelegation === false) {
          continue;
        }

        // Check if delegation covers the path (exact match or parent path)
        const delegationPath = delegation.path || '';
        if (!this.pathMatches(delegationPath, path)) {
          continue;
        }

        // Check if delegation has all required actions
        const delegationActions = delegation.actions || [];
        const hasAllActions = actions.every(action =>
          delegationActions.includes(action) || delegationActions.includes('*')
        );
        if (!hasAllActions) {
          continue;
        }

        // Found a suitable key
        return true;
      }
    }

    return false;
  }

  private retiredGraphError(): DelegationError | undefined {
    try {
      this.assertActiveFn?.();
      return undefined;
    } catch (err) {
      return createError(
        DelegationErrorCodes.NOT_INITIALIZED,
        "The session service graph has been retired.",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Check if a delegation path matches/covers the requested path.
   * A delegation path covers the request if:
   * - It's an exact match
   * - It's a parent path (e.g., delegation for "" covers "foo/bar")
   * - It uses wildcards that match
   * @internal
   */
  private pathMatches(delegationPath: string, requestedPath: string): boolean {
    // Empty delegation path covers everything
    if (delegationPath === '' || delegationPath === '*') {
      return true;
    }

    // Exact match
    if (delegationPath === requestedPath) {
      return true;
    }

    // Check if delegation path is a parent of requested path
    const normalizedDelegation = delegationPath.replace(/\/$/, '');
    const normalizedRequest = requestedPath.replace(/\/$/, '');

    if (normalizedRequest.startsWith(normalizedDelegation + '/')) {
      return true;
    }

    return false;
  }

  /**
   * Create a delegation from the current session to a share key.
   * This is the fallback path when root delegation is not available.
   * @internal
   */
  private async createSessionDelegation(
    delegateDID: string,
    path: string,
    actions: string[],
    expiry: Date
  ): Promise<Delegation | Result<never, DelegationError>> {
    if (!this.session) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Session required for creating delegation"
        ),
      };
    }

    if (this.createDelegationWasmFn) {
      // Client-side delegation creation via WASM.
      //
      // SharingService always issues single-resource delegations (one
      // path, one action list). The multi-resource WASM API takes an
      // `abilities` map shaped `Record<shortService, Record<path,
      // actions[]>>`, so we infer the short service from the first
      // action URN (every action in a share call shares the same
      // service namespace by construction — KV-only, SQL-only, etc).
      //
      // The result comes back with a `resources` array; for a
      // single-entry call it always has exactly one entry, and we
      // mirror that entry's `path` + `actions` back into the flat
      // Delegation shape that the rest of SharingService works with.
      try {
        if (actions.length === 0) {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.VALIDATION_ERROR,
              "createDelegation requires at least one action"
            ),
          };
        }
        const shortService = inferShortServiceFromActionUrns(actions);
        if (shortService === undefined) {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.VALIDATION_ERROR,
              `createDelegation: cannot infer service from actions ${JSON.stringify(actions)} — expected full URNs like "tinycloud.kv/get"`
            ),
          };
        }

        const wasmResult = this.createDelegationWasmFn({
          session: this.session,
          delegateDID,
          spaceId: this.session.spaceId,
          abilities: {
            [shortService]: {
              [path]: [...actions],
            },
          },
          expirationSecs: Math.floor(expiry.getTime() / 1000),
        });

        // Register the delegation with the server
        const registerRes = await this.fetchFn(`${this.host}/delegate`, {
          method: "POST",
          headers: {
            Authorization: wasmResult.delegation,
          },
        });

        if (!registerRes.ok) {
          const errorText = await registerRes.text();
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.CREATION_FAILED,
              `Failed to register delegation with server: ${registerRes.status} ${errorText}`
            ),
          };
        }

        // Single-entry call → resources[0] is authoritative for the
        // flat Delegation shape. We assert length here because a
        // zero-length result would mean the Rust side dropped our
        // single input — that's a protocol bug, not a runtime
        // condition to silently coerce.
        if (wasmResult.resources.length === 0) {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.CREATION_FAILED,
              "createDelegation WASM returned empty resources array for a single-entry request"
            ),
          };
        }
        const primary = wasmResult.resources[0];
        return {
          cid: wasmResult.cid,
          delegateDID: wasmResult.delegateDID,
          spaceId: this.session.spaceId,
          path: primary.path,
          actions: primary.actions,
          expiry: wasmResult.expiry,
          isRevoked: false,
          authHeader: wasmResult.delegation,
          allowSubDelegation: true,
          createdAt: new Date(),
        };
      } catch (err) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.CREATION_FAILED,
            `Failed to create delegation via WASM: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err : undefined
          ),
        };
      }
    } else {
      // Server-side delegation creation (fallback)
      const delegationParams: CreateDelegationParams = {
        delegateDID,
        path,
        actions,
        expiry,
        disableSubDelegation: false,
      };

      const delegationResult = this.createDelegationFn
        ? await this.createDelegationFn(delegationParams)
        : await this.delegationManager!.create(delegationParams);

      if (!delegationResult.ok) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.CREATION_FAILED,
            `Failed to create delegation for share: ${delegationResult.error.message}`,
            delegationResult.error.cause,
            delegationResult.error.meta
          ),
        };
      }

      return delegationResult.data;
    }
  }

  /**
   * Receive and activate a sharing link.
   *
   * Flow:
   * 1. Decode link -> extract { key, delegation, path, host }
   * 2. Ingest key into CapabilityKeyRegistry
   * 3. If autoSubdelegate (default true) + useSessionKey:
   *    - Create sub-delegation from ingested key -> current session
   *    - Register sub-delegation capabilities
   * 4. Return ShareAccess with pre-configured KV service
   */
  async receive(
    link: string,
    options: ReceiveOptions = {}
  ): Promise<Result<ShareAccess, DelegationError>> {
    const activeError = this.retiredGraphError();
    if (activeError) return { ok: false, error: activeError };

    const {
      autoSubdelegate = true,
      useSessionKey = true,
      ingestOptions,
    } = options;

    // Step 1: Decode and validate the link
    const decodeResult = this.decodeLinkWithValidation(link);
    if (!decodeResult.ok) {
      return decodeResult;
    }
    const shareData = decodeResult.data;

    // Schema validation ensures key.d and delegation exist, but we need
    // to check business rules (expiry, revocation) separately

    // Check delegation expiry
    const delegationExpiry = new Date(shareData.delegation.expiry);
    if (delegationExpiry < new Date()) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.AUTH_EXPIRED,
          "Sharing link has expired"
        ),
      };
    }

    // Check delegation revocation
    if (shareData.delegation.isRevoked) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.REVOKED,
          "Sharing link has been revoked"
        ),
      };
    }

    // Step 2: Create KeyInfo and ingest into registry
    const keyInfo: KeyInfo = {
      id: `ingested:${shareData.keyDid}`,
      did: shareData.keyDid,
      type: "ingested",
      jwk: shareData.key,
      priority: 2, // Ingested keys have lowest priority
    };

    this.registry.ingestKey(keyInfo, shareData.delegation, ingestOptions);

    // The delegation and key to use for operations
    let activeDelegation = shareData.delegation;
    let activeKey = keyInfo;

    // Step 3: Auto-subdelegate if requested
    if (autoSubdelegate && useSessionKey && this.session) {
      const child = await this.delegateReceivedShare(link, {
        delegateDID: this.session.verificationMethod,
        expectedHost: shareData.host,
      });
      if (!child.ok) return child;
      activeDelegation = child.data.delegation;
      activeKey = {
        id: `session:${principalDid(this.session.verificationMethod)}`,
        did: this.session.verificationMethod,
        type: "session",
        priority: 0,
      };
    }

    // Step 4: Create pre-configured KV service for the shared path
    // Construct session from share data - no need for existing session
    // Use the authHeader if available, otherwise fall back to constructing from CID
    const portableAuthorization = (activeDelegation as Delegation & {
      delegationHeader?: { Authorization?: string };
    }).delegationHeader?.Authorization;
    const authHeader = portableAuthorization ?? activeDelegation.authHeader ?? `Bearer ${activeDelegation.cid}`;
    const activeSession = activeKey.type === "session" && this.session
      ? this.session
      : undefined;
    const shareSession: ServiceSession = {
      delegationHeader: { Authorization: authHeader },
      delegationCid: activeDelegation.cid,
      spaceId: shareData.spaceId,
      verificationMethod: activeSession?.verificationMethod ?? shareData.keyDid,
      jwk: activeSession?.jwk ?? shareData.key,
    };

    const kvService = this.createKVService({
      hosts: [shareData.host],
      session: shareSession,
      invoke: this.invoke,
      fetch: this.fetchFn,
      pathPrefix: shareData.path,
    });

    const shareAccess: ShareAccess = {
      delegation: activeDelegation,
      key: activeKey,
      kv: kvService,
      spaceId: shareData.spaceId,
      path: shareData.path,
    };

    return { ok: true, data: shareAccess };
  }

  /**
   * Create a constrained child delegation from a received sharing link.
   *
   * This is the safe handoff for a browser delegating shared input to an
   * agent or service: the bearer link is decoded and used only in this SDK
   * instance, while the recipient receives a child UCAN without the embedded
   * private key. The child UCAN is a sensitive bearer credential and must not
   * be logged or stored insecurely.
   */
  async delegateReceivedShare(
    link: string,
    params: DelegateReceivedShareParams
  ): Promise<Result<DelegatedShareAccess, DelegationError>> {
    const activeError = this.retiredGraphError();
    if (activeError) return { ok: false, error: activeError };

    const decoded = this.decodeLinkWithValidation(link);
    if (!decoded.ok) return decoded;
    const shareData = decoded.data;

    const parentExpiry = new Date(shareData.delegation.expiry);
    const now = new Date();
    if (parentExpiry <= now) {
      return {
        ok: false,
        error: createError(DelegationErrorCodes.AUTH_EXPIRED, "Sharing link has expired"),
      };
    }
    if (shareData.delegation.isRevoked) {
      return {
        ok: false,
        error: createError(DelegationErrorCodes.REVOKED, "Sharing link has been revoked"),
      };
    }
    if (shareData.delegation.allowSubDelegation === false) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.PERMISSION_DENIED,
          "Sharing link does not allow delegation"
        ),
      };
    }
    const delegateDID = principalDid(params.delegateDID?.trim() ?? "");
    if (!/^did:(?:key|pkh):[^\s]+$/.test(delegateDID)) {
      return {
        ok: false,
        error: createError(DelegationErrorCodes.INVALID_INPUT, "A valid delegateDID is required"),
      };
    }
    const trustedHost = trustedNodeOrigin(shareData.host, this.hosts, params.expectedHost);
    if (!trustedHost) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.PERMISSION_DENIED,
          "Sharing-link host is not a configured TinyCloud host"
        ),
      };
    }
    if (
      shareData.delegation.spaceId !== shareData.spaceId ||
      principalDid(shareData.delegation.delegateDID) !== principalDid(shareData.keyDid) ||
      !shareKeyMatchesDid(shareData.key, shareData.keyDid) ||
      !capabilityPathContains(shareData.delegation.path, shareData.path)
    ) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          "Sharing-link metadata does not match its parent delegation"
        ),
      };
    }
    if (!shareData.delegation.authHeader) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          "Sharing link is missing its signed parent delegation"
        ),
      };
    }
    if (!this.createDelegationWasmFn || !this.computeCidFn) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Client-side delegation and CID support are required"
        ),
      };
    }

    const path = params.path ?? shareData.path;
    if (!capabilityPathContains(shareData.path, path)) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.PERMISSION_DENIED,
          "Requested path exceeds the sharing-link capability"
        ),
      };
    }

    const parentActions = shareData.delegation.actions;
    const actions = params.actions ?? [...parentActions];
    if (
      actions.length === 0 ||
      new Set(actions).size !== actions.length ||
      actions.includes("*") ||
      actions.some((action) => !parentActions.some((parentAction) => actionContains(parentAction, action)))
    ) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.PERMISSION_DENIED,
          "Requested actions exceed the sharing-link capability"
        ),
      };
    }

    const expiry = params.expiry ?? parentExpiry;
    if (expiry <= now || expiry > parentExpiry) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.PERMISSION_DENIED,
          "Child delegation expiry must be active and no later than the sharing link"
        ),
      };
    }

    const service = inferShortServiceFromActionUrns(actions);
    if (!service) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "Sharing-link actions must belong to one known TinyCloud service"
        ),
      };
    }

    const owner = ownerFromSpaceId(shareData.spaceId);
    if (!owner) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          "Sharing link has an unsupported owner space"
        ),
      };
    }

    try {
      const parentSession: ServiceSession = {
        delegationHeader: { Authorization: shareData.delegation.authHeader },
        delegationCid: shareData.delegation.cid,
        spaceId: shareData.spaceId,
        verificationMethod: shareData.keyDid,
        jwk: shareData.key,
      };
      const result = this.createDelegationWasmFn({
        session: parentSession,
        delegateDID,
        spaceId: shareData.spaceId,
        abilities: { [service]: { [path]: actions } },
        expirationSecs: Math.floor(expiry.getTime() / 1000),
      });
      const verifiedChild = verifySignedChild(result, {
        delegateDID,
        issuerDID: principalDid(shareData.keyDid),
        parentCid: shareData.delegation.cid,
        service,
        spaceId: shareData.spaceId,
        path,
        actions,
        expiresAt: expiry,
        parentExpiresAt: parentExpiry,
      }, this.computeCidFn);
      if (!verifiedChild) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.CREATION_FAILED,
            "Delegation signer returned a child outside the requested capability"
          ),
        };
      }

      const registrationInit = {
        method: "POST",
        headers: { Authorization: result.delegation },
        redirect: "error" as const,
      };
      const registration = await this.fetchFn(new URL("/delegate", trustedHost).toString(), registrationInit);
      if (!registration.ok) {
        throw new Error(`node rejected child delegation (${registration.status})`);
      }

      const primary = verifiedChild.resource;
      return {
        ok: true,
        data: {
          delegation: {
            cid: result.cid,
            delegateDID: verifiedChild.delegateDID,
            delegatorDID: shareData.keyDid.split("#")[0],
            spaceId: shareData.spaceId,
            path: primary.path,
            actions: primary.actions,
            expiry: verifiedChild.expiresAt,
            isRevoked: false,
            allowSubDelegation: false,
            parentCid: shareData.delegation.cid,
            createdAt: now,
            delegationHeader: { Authorization: result.delegation },
            ownerAddress: owner.address,
            chainId: owner.chainId,
            host: trustedHost,
            resources: result.resources,
            disableSubDelegation: true,
          },
          source: {
            parentCid: shareData.delegation.cid,
            spaceId: shareData.spaceId,
            path: primary.path,
            host: trustedHost,
            expiresAt: verifiedChild.expiresAt,
          },
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.CREATION_FAILED,
          "Failed to create or register the child delegation"
        ),
      };
    }
  }

  /**
   * Encode sharing data into a link string.
   *
   * @param data - The share data to encode
   * @param schema - The encoding schema (default: "base64")
   * @returns Encoded link string
   */
  encodeLink(data: EncodedShareData, schema: ShareSchema = "base64"): string {
    if (schema !== "base64") {
      throw new Error(`Schema '${schema}' not implemented. Only 'base64' is supported.`);
    }

    const jsonString = JSON.stringify(data);
    const encoded = base64UrlEncode(jsonString);
    return `${BASE64_PREFIX}${encoded}`;
  }

  /**
   * Decode a link string into sharing data.
   *
   * @param link - The encoded link string (may include URL prefix)
   * @returns Decoded share data
   * @throws Error if link format is invalid or data fails validation
   */
  decodeLink(link: string): EncodedShareData {
    const result = this.decodeLinkWithValidation(link);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data;
  }

  /**
   * Decode and validate a link string into sharing data.
   *
   * Internal method that returns a Result instead of throwing.
   * Used by receive() for proper error handling.
   *
   * @param link - The encoded link string (may include URL prefix)
   * @returns Result with decoded share data or validation error
   */
  private decodeLinkWithValidation(link: string): Result<EncodedShareData, DelegationError> {
    // Extract the encoded data from the link
    let encoded = link;

    // Handle full URL format: https://share.example.com/share/tc1:...
    if (link.includes("/share/")) {
      const parts = link.split("/share/");
      encoded = parts[parts.length - 1];
    }

    // Handle query parameter format: ?share=tc1:...
    if (link.includes("?share=")) {
      try {
        const url = new URL(link);
        encoded = url.searchParams.get("share") ?? encoded;
      } catch {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.INVALID_TOKEN,
            "Invalid URL format in sharing link"
          ),
        };
      }
    }

    // Remove the schema prefix
    if (!encoded.startsWith(BASE64_PREFIX)) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          `Invalid sharing link format. Expected prefix '${BASE64_PREFIX}'`
        ),
      };
    }

    const base64Data = encoded.slice(BASE64_PREFIX.length);

    let jsonString: string;
    try {
      jsonString = base64UrlDecode(base64Data);
    } catch (err) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          `Failed to decode base64 data: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        ),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          `Failed to parse share data JSON: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        ),
      };
    }

    // Convert delegation expiry to Date before validation if it's a string
    // This is needed because JSON.parse doesn't restore Date objects
    if (
      parsed &&
      typeof parsed === "object" &&
      "delegation" in parsed &&
      parsed.delegation &&
      typeof parsed.delegation === "object" &&
      "expiry" in parsed.delegation &&
      typeof parsed.delegation.expiry === "string"
    ) {
      (parsed.delegation as { expiry: Date }).expiry = new Date(parsed.delegation.expiry);
    }

    // Validate against schema
    const validationResult = validateEncodedShareData(parsed);
    if (!validationResult.ok) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_TOKEN,
          validationResult.error.message,
          undefined,
          validationResult.error.meta
        ),
      };
    }

    return { ok: true, data: validationResult.data };
  }
}

/**
 * Create a new SharingService instance.
 */
export function createSharingService(config: SharingServiceConfig): ISharingService {
  return new SharingService(config);
}

function ownerFromSpaceId(spaceId: string): { chainId: number; address: string } | null {
  const match = spaceId.match(/^tinycloud:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40}):/);
  if (!match) return null;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId)) return null;
  return { chainId, address: match[2] };
}

function parseTrustedNodeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function trustedNodeOrigin(candidate: string, configured: string[], expected?: string): string | null {
  const origin = parseTrustedNodeOrigin(candidate);
  if (!origin) return null;
  const allowed = new Set(configured.map(parseTrustedNodeOrigin).filter((value): value is string => Boolean(value)));
  if (!allowed.has(origin)) return null;
  if (expected && parseTrustedNodeOrigin(expected) !== origin) return null;
  return origin;
}

function canonicalCapabilityPath(path: string): string | null {
  if (
    /[\u0000-\u001f\\]/.test(path) ||
    /%(?:2e|2f|5c)/i.test(path) ||
    path.includes("//")
  ) return null;
  const wildcardIndex = path.indexOf("*");
  if (wildcardIndex !== -1 && !path.endsWith("/*") && !path.endsWith("/**")) return null;
  if (path.slice(0, -3).includes("*") || (path.endsWith("/*") && path.slice(0, -2).includes("*"))) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return path;
}

function capabilityPathContains(parent: string, child: string): boolean {
  const canonicalParent = canonicalCapabilityPath(parent);
  const canonicalChild = canonicalCapabilityPath(child);
  if (canonicalParent === null || canonicalChild === null) return false;
  if (canonicalParent === "" || canonicalParent === "/") return true;
  if (canonicalParent === canonicalChild) return true;
  if (canonicalParent.endsWith("/**")) {
    return canonicalChild.startsWith(canonicalParent.slice(0, -2));
  }
  if (canonicalParent.endsWith("/*")) {
    const prefix = canonicalParent.slice(0, -1);
    if (!canonicalChild.startsWith(prefix)) return false;
    const remainder = canonicalChild.slice(prefix.length);
    return remainder.length > 0 && !remainder.includes("/");
  }
  return canonicalParent.endsWith("/") && canonicalChild.startsWith(canonicalParent);
}

function shareKeyMatchesDid(key: JWK, didUrl: string): boolean {
  if (
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    typeof key.x !== "string" ||
    typeof key.d !== "string"
  ) return false;
  try {
    const didBytes = bases.base58btc.decode(principalDid(didUrl).slice("did:key:".length));
    const publicKey = didBytes.length === 34 && didBytes[0] === 0xed && didBytes[1] === 0x01
      ? didBytes.slice(2)
      : null;
    if (!publicKey) return false;
    const jwkBytes = decodeBase64UrlBytes(key.x);
    const privateKey = decodeBase64UrlBytes(key.d);
    const derivedPublicKey = ed25519.getPublicKey(privateKey);
    return (
      privateKey.length === 32 &&
      publicKey.length === jwkBytes.length &&
      publicKey.every((byte, index) => byte === jwkBytes[index]) &&
      derivedPublicKey.length === jwkBytes.length &&
      derivedPublicKey.every((byte, index) => byte === jwkBytes[index])
    );
  } catch {
    return false;
  }
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  let encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  while (encoded.length % 4) encoded += "=";
  if (typeof atob !== "undefined") {
    return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}

function verifySignedChild(
  result: CreateDelegationWasmResult,
  expected: {
    delegateDID: string;
    issuerDID: string;
    parentCid: string;
    service: string;
    spaceId: string;
    path: string;
    actions: string[];
    expiresAt: Date;
    parentExpiresAt: Date;
  },
  computeCid: NonNullable<SharingServiceConfig["computeCid"]>,
): { delegateDID: string; expiresAt: Date; resource: CreateDelegationWasmResult["resources"][number] } | null {
  const parts = result.delegation.split(".");
  if (parts.length !== 3) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64UrlBytes(parts[1]))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const delegateDID = typeof payload.aud === "string" ? principalDid(payload.aud) : "";
  const issuerDID = typeof payload.iss === "string" ? principalDid(payload.iss) : "";
  const proofs = Array.isArray(payload.prf) ? payload.prf : [];
  const expirationSecs = typeof payload.exp === "number" && Number.isInteger(payload.exp) ? payload.exp : 0;
  const expiresAt = new Date(expirationSecs * 1000);
  if (
    delegateDID !== expected.delegateDID ||
    issuerDID !== expected.issuerDID ||
    proofs.length !== 1 ||
    proofs[0] !== expected.parentCid ||
    expiresAt <= new Date() ||
    expiresAt > expected.expiresAt ||
    expiresAt > expected.parentExpiresAt ||
    computeCid(new TextEncoder().encode(result.delegation), 0x55n) !== result.cid
  ) return null;

  const att = payload.att;
  if (!att || typeof att !== "object" || Array.isArray(att)) return null;
  const entries = Object.entries(att as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [resourceUri, abilityValue] = entries[0];
  const prefix = `${expected.spaceId}/${expected.service}/`;
  if (!resourceUri.startsWith(prefix) || resourceUri.slice(prefix.length) !== expected.path) return null;
  if (!abilityValue || typeof abilityValue !== "object" || Array.isArray(abilityValue)) return null;
  const signedActions = Object.keys(abilityValue as Record<string, unknown>).sort();
  const expectedActions = [...expected.actions].sort();
  if (
    signedActions.length !== expectedActions.length ||
    !signedActions.every((action, index) => action === expectedActions[index])
  ) return null;

  if (principalDid(result.delegateDID) !== delegateDID || result.resources.length !== 1) return null;
  if (result.expiry.getTime() !== expiresAt.getTime()) return null;
  const resource = result.resources[0];
  if (
    resource.service !== expected.service ||
    resource.space !== expected.spaceId ||
    resource.path !== expected.path
  ) return null;
  const actualActions = [...resource.actions].sort();
  if (
    actualActions.length !== expectedActions.length ||
    !actualActions.every((action, index) => action === expectedActions[index])
  ) return null;
  return { delegateDID, expiresAt, resource };
}
