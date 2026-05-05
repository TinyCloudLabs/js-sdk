/**
 * SpaceService - Global singleton for managing spaces (owned and delegated).
 *
 * SpaceService provides a unified interface for discovering, creating,
 * and accessing spaces. It handles both owned spaces (created by the user)
 * and delegated spaces (shared by other users).
 *
 * @packageDocumentation
 */

import type {
  IDataVaultService,
  IKVService,
  Result,
  ServiceError,
  ServiceSession,
  FetchFunction,
  InvokeFunction,
} from "@tinycloud/sdk-services";
import { ok, err, serviceError } from "@tinycloud/sdk-services";
import type {
  SpaceInfo,
  SpaceOwnership,
  Delegation,
  CreateDelegationParams,
  ShareLink,
  GenerateShareParams,
} from "../delegations/types";
import type { ICapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import type { ISharingService } from "../delegations/SharingService";
import {
  Space,
  type ISpace,
  type ISpaceScopedDelegations,
  type ISpaceScopedSharing,
  type SpaceConfig,
} from "./Space";
import {
  validateServerDelegationsResponse,
  validateServerOwnedSpacesResponse,
  validateServerCreateSpaceResponse,
  validateServerSpaceInfoResponse,
  type ServerDelegationsResponse,
} from "./spaces.schema.js";

// =============================================================================
// Service Name and Error Codes
// =============================================================================

const SERVICE_NAME = "space";

/**
 * Error codes for SpaceService operations.
 */
export const SpaceErrorCodes = {
  /** Space not found */
  NOT_FOUND: "SPACE_NOT_FOUND",
  /** Space already exists */
  ALREADY_EXISTS: "SPACE_ALREADY_EXISTS",
  /** Creation failed */
  CREATION_FAILED: "SPACE_CREATION_FAILED",
  /** Authentication required */
  AUTH_REQUIRED: "AUTH_REQUIRED",
  /** Invalid space name or URI */
  INVALID_NAME: "INVALID_SPACE_NAME",
  /** Network error */
  NETWORK_ERROR: "NETWORK_ERROR",
  /** Not initialized */
  NOT_INITIALIZED: "NOT_INITIALIZED",
} as const;

export type SpaceErrorCode = (typeof SpaceErrorCodes)[keyof typeof SpaceErrorCodes];

// =============================================================================
// Types
// =============================================================================

/**
 * Parameters for creating a space-scoped delegation.
 * Extends CreateDelegationParams with the spaceId.
 */
export interface SpaceDelegationParams extends Omit<CreateDelegationParams, "spaceId"> {
  /** The space ID to create the delegation for */
  spaceId: string;
}

/**
 * Function type for creating delegations.
 * Platform SDKs provide this to handle SIWE-based delegation creation.
 */
export type CreateDelegationFunction = (
  params: SpaceDelegationParams
) => Promise<Result<Delegation, ServiceError>>;

/**
 * Configuration for SpaceService.
 */
export interface SpaceServiceConfig {
  /** TinyCloud host URLs */
  hosts: string[];
  /** Active session for authentication */
  session: ServiceSession;
  /** Platform-specific invoke function */
  invoke: InvokeFunction;
  /** Optional custom fetch implementation */
  fetch?: FetchFunction;
  /** Optional capability key registry for delegated space discovery */
  capabilityRegistry?: ICapabilityKeyRegistry;
  /** Factory function to create a space-scoped KV service */
  createKVService?: (spaceId: string) => IKVService;
  /** Factory function to create a space-scoped Data Vault service */
  createVaultService?: (spaceId: string) => IDataVaultService;
  /** User's PKH DID (derived from address or provided explicitly) */
  userDid?: string;
  /** Optional SharingService for v2 sharing links (client-side) */
  sharingService?: ISharingService;
  /**
   * Factory function to create delegations using SIWE-based flow.
   * Platform SDKs (web-sdk, node-sdk) provide this using their WASM bindings.
   * Required for space.delegations.create() to work.
   */
  createDelegation?: CreateDelegationFunction;
}

/**
 * Interface for SpaceService.
 */
export interface ISpaceService {
  /**
   * List all spaces the user has access to (owned + delegated).
   */
  list(): Promise<Result<SpaceInfo[], ServiceError>>;

  /**
   * Create a new space.
   *
   * @param name - The name for the new space
   */
  create(name: string): Promise<Result<SpaceInfo, ServiceError>>;

  /**
   * Get a Space object by name or full URI.
   *
   * For owned spaces, use the short name: `sdk.space('default')`
   * For delegated spaces, use the full URI: `sdk.space('tinycloud:pkh:eip155:1:0x...:photos')`
   *
   * @param nameOrUri - Short name or full URI
   */
  get(nameOrUri: string): ISpace;

  /**
   * Check if a space exists and the user has access.
   *
   * @param nameOrUri - Short name or full URI
   */
  exists(nameOrUri: string): Promise<Result<boolean, ServiceError>>;

  /**
   * Get the current user's primary space ID.
   */
  getCurrentSpaceId(): string | undefined;

  /**
   * Update the service configuration.
   */
  updateConfig(config: Partial<SpaceServiceConfig>): void;
}

// =============================================================================
// Public Space Utilities
// =============================================================================

/**
 * Construct the deterministic public space ID for a given address and chain ID.
 *
 * Public space IDs follow the format:
 * `tinycloud:pkh:eip155:{chainId}:{address}:public`
 *
 * Given an address and chain ID, any client can construct this ID
 * to discover and read a user's public data without prior interaction.
 *
 * @param address - Ethereum address (0x-prefixed)
 * @param chainId - Chain ID (e.g., 1 for mainnet)
 * @returns The full public space ID URI
 *
 * @example
 * ```typescript
 * const spaceId = makePublicSpaceId('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 1);
 * // => "tinycloud:pkh:eip155:1:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:public"
 * ```
 */
export function makePublicSpaceId(address: string, chainId: number): string {
  return `tinycloud:pkh:eip155:${chainId}:${address}:public`;
}

// =============================================================================
// Space URI Utilities
// =============================================================================

/**
 * Parse a space URI to extract components.
 *
 * Full URI format: `tinycloud:pkh:eip155:{chainId}:{address}:{name}`
 * Short name format: `{name}`
 *
 * @param uri - The space URI or short name
 * @returns Parsed components or null if invalid
 */
export function parseSpaceUri(
  uri: string
): { owner: string; name: string; chainId?: string; address?: string } | null {
  // Full URI format: tinycloud:pkh:eip155:{chainId}:{address}:{name}
  const fullUriMatch = uri.match(
    /^tinycloud:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40}):(.+)$/
  );
  if (fullUriMatch) {
    const [, chainId, address, name] = fullUriMatch;
    return {
      owner: `did:pkh:eip155:${chainId}:${address}`,
      name,
      chainId,
      address,
    };
  }

  // Short name format - just return the name, owner will be inferred
  if (/^[a-zA-Z0-9_-]+$/.test(uri)) {
    return {
      owner: "", // Will be filled in from session
      name: uri,
    };
  }

  return null;
}

/**
 * Build a full space URI from components.
 *
 * @param owner - Owner DID (did:pkh:eip155:{chainId}:{address})
 * @param name - Space name
 * @returns Full space URI
 */
export function buildSpaceUri(owner: string, name: string): string {
  // Extract chain ID and address from PKH DID
  const pkhMatch = owner.match(/^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  if (pkhMatch) {
    const [, chainId, address] = pkhMatch;
    return `tinycloud:pkh:eip155:${chainId}:${address}:${name}`;
  }
  // Fallback - shouldn't happen with valid PKH DIDs
  return `tinycloud:${owner}:${name}`;
}

// =============================================================================
// Server Response Transformation
// =============================================================================

/**
 * Transform validated server delegation response to SDK's Delegation[] format.
 *
 * Server returns { [cid: string]: DelegationInfo } where:
 * - Key is the delegation CID
 * - Value is DelegationInfo with delegator, delegate, capabilities, etc.
 *
 * SDK expects Delegation[] with cid field included.
 *
 * @param validatedData - Pre-validated server response from validateServerDelegationsResponse()
 * @param defaultSpaceId - Default space ID to use if not extractable from resource
 */
function transformServerDelegations(
  validatedData: ServerDelegationsResponse,
  defaultSpaceId: string
): Delegation[] {
  const result: Delegation[] = [];

  for (const [cid, info] of Object.entries(validatedData)) {
    // Extract path from capabilities (use first capability's resource path)
    const capabilities = info.capabilities;
    let path = "";
    let spaceId = defaultSpaceId;
    const actions: string[] = [];

    for (const cap of capabilities) {
      actions.push(cap.ability);
      // Parse resource to extract space and path
      // Resource format: tinycloud:pkh:eip155:{chainId}:{address}:{spaceName}/{service}/{path}
      const resourceMatch = cap.resource.match(
        /^(tinycloud:pkh:eip155:\d+:0x[a-fA-F0-9]+:[^/]+)\/[^/]+\/(.*)$/
      );
      if (resourceMatch) {
        spaceId = resourceMatch[1];
        path = resourceMatch[2] || "";
      }
    }

    // Extract first string parent CID (server may return byte arrays for some CIDs)
    const firstStringParent = info.parents?.find((p): p is string => typeof p === 'string');

    result.push({
      cid,
      delegateDID: info.delegate,
      delegatorDID: info.delegator,
      spaceId,
      path,
      actions,
      expiry: info.expiry ? new Date(info.expiry) : new Date(Date.now() + 24 * 60 * 60 * 1000),
      isRevoked: false,
      createdAt: info.issued_at ? new Date(info.issued_at) : undefined,
      parentCid: firstStringParent,
    });
  }

  return result;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * SpaceService - Global singleton for managing spaces.
 *
 * @example
 * ```typescript
 * const spaceService = new SpaceService({
 *   hosts: ['https://node.tinycloud.xyz'],
 *   session,
 *   invoke,
 * });
 *
 * // List all accessible spaces
 * const result = await spaceService.list();
 * if (result.ok) {
 *   for (const space of result.data) {
 *     console.log(`${space.name} (${space.type})`);
 *   }
 * }
 *
 * // Create a new space
 * const createResult = await spaceService.create('photos');
 *
 * // Get a space object for operations
 * const space = spaceService.get('photos');
 * await space.kv.put('album/vacation', { photos: [...] });
 * ```
 */
export class SpaceService implements ISpaceService {
  private hosts: string[];
  private session: ServiceSession;
  private invoke: InvokeFunction;
  private fetchFn: FetchFunction;
  private capabilityRegistry?: ICapabilityKeyRegistry;
  private createKVServiceFn?: (spaceId: string) => IKVService;
  private createVaultServiceFn?: (spaceId: string) => IDataVaultService;
  private _userDid?: string;
  private sharingService?: ISharingService;
  private createDelegationFn?: CreateDelegationFunction;

  /** Cache of created Space objects */
  private spaceCache: Map<string, ISpace> = new Map();

  /** Cache of space info */
  private infoCache: Map<string, { info: SpaceInfo; cachedAt: number }> = new Map();

  /** Cache TTL in milliseconds (5 minutes) */
  private readonly cacheTTL = 5 * 60 * 1000;

  /**
   * Create a new SpaceService instance.
   *
   * @param config - Service configuration
   */
  constructor(config: SpaceServiceConfig) {
    this.hosts = config.hosts;
    this.session = config.session;
    this.invoke = config.invoke;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.capabilityRegistry = config.capabilityRegistry;
    this.createKVServiceFn = config.createKVService;
    this.createVaultServiceFn = config.createVaultService;
    this._userDid = config.userDid;
    this.sharingService = config.sharingService;
    this.createDelegationFn = config.createDelegation;
  }

  /**
   * Update the service configuration.
   */
  updateConfig(config: Partial<SpaceServiceConfig>): void {
    if (config.hosts) this.hosts = config.hosts;
    if (config.session) this.session = config.session;
    if (config.invoke) this.invoke = config.invoke;
    if (config.fetch) this.fetchFn = config.fetch;
    if (config.capabilityRegistry) this.capabilityRegistry = config.capabilityRegistry;
    if (config.createKVService) this.createKVServiceFn = config.createKVService;
    if (config.createVaultService) this.createVaultServiceFn = config.createVaultService;
    if (config.userDid !== undefined) this._userDid = config.userDid;
    if (config.sharingService) this.sharingService = config.sharingService;
    if (config.createDelegation) this.createDelegationFn = config.createDelegation;

    // Clear caches when config changes
    this.spaceCache.clear();
    this.infoCache.clear();
  }

  /**
   * Get the current user's primary space ID.
   */
  getCurrentSpaceId(): string | undefined {
    return this.session?.spaceId;
  }

  /**
   * Get the primary host URL.
   */
  private get host(): string {
    return this.hosts[0];
  }

  /**
   * Get the current user's PKH DID.
   */
  private get userDid(): string | undefined {
    // Return explicitly set user DID, or try to derive from verificationMethod
    if (this._userDid) {
      return this._userDid;
    }
    // verificationMethod might be did:key format - cannot derive PKH from it
    // The caller should provide userDid explicitly for full functionality
    return undefined;
  }

  // ===========================================================================
  // List Spaces
  // ===========================================================================

  /**
   * List all spaces the user has access to.
   *
   * Combines owned spaces (from the server) with delegated spaces
   * (from the capability registry).
   */
  async list(): Promise<Result<SpaceInfo[], ServiceError>> {
    if (!this.session) {
      return err(
        serviceError(SpaceErrorCodes.AUTH_REQUIRED, "Authentication required", SERVICE_NAME)
      );
    }

    try {
      const spaces: SpaceInfo[] = [];

      // 1. Get owned spaces from the server
      const ownedResult = await this.listOwnedSpaces();
      if (ownedResult.ok) {
        spaces.push(...ownedResult.data);
      }

      // 2. Get delegated spaces from capability registry
      if (this.capabilityRegistry) {
        const delegatedSpaces = this.discoverDelegatedSpaces();
        spaces.push(...delegatedSpaces);
      }

      // Remove duplicates (prefer owned over delegated)
      const uniqueSpaces = this.deduplicateSpaces(spaces);

      return ok(uniqueSpaces);
    } catch (error) {
      return err(
        serviceError(
          SpaceErrorCodes.NETWORK_ERROR,
          `Failed to list spaces: ${String(error)}`,
          SERVICE_NAME,
          { cause: error instanceof Error ? error : undefined }
        )
      );
    }
  }

  /**
   * List owned spaces from the server.
   */
  private async listOwnedSpaces(): Promise<Result<SpaceInfo[], ServiceError>> {
    try {
      const headers = this.invoke(this.session, "space", "", "tinycloud.space/list");

      const response = await this.fetchFn(`${this.host}/invoke`, {
        method: "POST",
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return err(
          serviceError(
            SpaceErrorCodes.NETWORK_ERROR,
            `Failed to list owned spaces: ${response.status} - ${errorText}`,
            SERVICE_NAME,
            { meta: { status: response.status } }
          )
        );
      }

      const rawData = await response.json();

      // Validate server response
      const validationResult = validateServerOwnedSpacesResponse(rawData);
      if (!validationResult.ok) {
        return err(
          serviceError(
            SpaceErrorCodes.NETWORK_ERROR,
            validationResult.error.message,
            SERVICE_NAME,
            { meta: validationResult.error.meta }
          )
        );
      }

      const spaces: SpaceInfo[] = validationResult.data.map((item) => ({
        id: item.id,
        name: item.name ?? this.extractNameFromId(item.id),
        owner: item.owner,
        type: "owned" as SpaceOwnership,
        permissions: ["*"], // Full permissions for owned spaces
      }));

      return ok(spaces);
    } catch (error) {
      return err(
        serviceError(
          SpaceErrorCodes.NETWORK_ERROR,
          `Network error listing owned spaces: ${String(error)}`,
          SERVICE_NAME,
          { cause: error instanceof Error ? error : undefined }
        )
      );
    }
  }

  /**
   * Discover delegated spaces from the capability registry.
   */
  private discoverDelegatedSpaces(): SpaceInfo[] {
    if (!this.capabilityRegistry) {
      return [];
    }

    const spaces: Map<string, SpaceInfo> = new Map();

    // Get all capabilities and extract unique space IDs
    const capabilities = this.capabilityRegistry.getAllCapabilities();

    for (const capability of capabilities) {
      const spaceId = capability.delegation.spaceId;

      // Skip if we already have this space
      if (spaces.has(spaceId)) {
        const existing = spaces.get(spaceId)!;
        // Merge permissions
        if (existing.permissions) {
          const actions = capability.delegation.actions;
          for (const action of actions) {
            if (!existing.permissions.includes(action)) {
              existing.permissions.push(action);
            }
          }
        }
        continue;
      }

      // Skip if this is the user's own space
      if (spaceId === this.session?.spaceId) {
        continue;
      }

      const parsed = parseSpaceUri(spaceId);

      spaces.set(spaceId, {
        id: spaceId,
        name: parsed?.name ?? this.extractNameFromId(spaceId),
        owner: capability.delegation.delegatorDID ?? parsed?.owner ?? "",
        type: "delegated",
        permissions: [...capability.delegation.actions],
        expiresAt: capability.expiresAt,
      });
    }

    return Array.from(spaces.values());
  }

  /**
   * Extract space name from a full space ID.
   */
  private extractNameFromId(id: string): string {
    const parsed = parseSpaceUri(id);
    if (parsed) {
      return parsed.name;
    }
    // Fallback: take last segment
    const parts = id.split(":");
    return parts[parts.length - 1] || id;
  }

  /**
   * Deduplicate spaces, preferring owned over delegated.
   */
  private deduplicateSpaces(spaces: SpaceInfo[]): SpaceInfo[] {
    const seen = new Map<string, SpaceInfo>();

    for (const space of spaces) {
      const existing = seen.get(space.id);
      if (!existing || (existing.type === "delegated" && space.type === "owned")) {
        seen.set(space.id, space);
      }
    }

    return Array.from(seen.values());
  }

  // ===========================================================================
  // Create Space
  // ===========================================================================

  /**
   * Create a new space.
   *
   * @param name - The name for the new space
   */
  async create(name: string): Promise<Result<SpaceInfo, ServiceError>> {
    if (!this.session) {
      return err(
        serviceError(SpaceErrorCodes.AUTH_REQUIRED, "Authentication required", SERVICE_NAME)
      );
    }

    // Validate name
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return err(
        serviceError(
          SpaceErrorCodes.INVALID_NAME,
          "Space name must contain only alphanumeric characters, underscores, and hyphens",
          SERVICE_NAME
        )
      );
    }

    try {
      const headers = this.invoke(this.session, "space", name, "tinycloud.space/create");

      const response = await this.fetchFn(`${this.host}/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 409) {
          return err(
            serviceError(
              SpaceErrorCodes.ALREADY_EXISTS,
              `Space "${name}" already exists`,
              SERVICE_NAME
            )
          );
        }

        return err(
          serviceError(
            SpaceErrorCodes.CREATION_FAILED,
            `Failed to create space: ${response.status} - ${errorText}`,
            SERVICE_NAME,
            { meta: { status: response.status } }
          )
        );
      }

      const rawData = await response.json();

      // Validate server response
      const validationResult = validateServerCreateSpaceResponse(rawData);
      if (!validationResult.ok) {
        return err(
          serviceError(
            SpaceErrorCodes.CREATION_FAILED,
            validationResult.error.message,
            SERVICE_NAME,
            { meta: validationResult.error.meta }
          )
        );
      }

      const spaceInfo: SpaceInfo = {
        id: validationResult.data.id,
        name: validationResult.data.name || name,
        owner: validationResult.data.owner || this.userDid || "",
        type: "owned",
        permissions: ["*"],
      };

      // Cache the info
      this.infoCache.set(spaceInfo.id, { info: spaceInfo, cachedAt: Date.now() });

      return ok(spaceInfo);
    } catch (error) {
      return err(
        serviceError(
          SpaceErrorCodes.NETWORK_ERROR,
          `Network error creating space: ${String(error)}`,
          SERVICE_NAME,
          { cause: error instanceof Error ? error : undefined }
        )
      );
    }
  }

  // ===========================================================================
  // Get Space
  // ===========================================================================

  /**
   * Get a Space object by name or full URI.
   *
   * @param nameOrUri - Short name or full URI
   */
  get(nameOrUri: string): ISpace {
    // Resolve the full space ID
    const spaceId = this.resolveSpaceId(nameOrUri);

    // Check cache
    const cached = this.spaceCache.get(spaceId);
    if (cached) {
      return cached;
    }

    // Create new Space object
    const parsed = parseSpaceUri(spaceId);
    const name = parsed?.name ?? this.extractNameFromId(spaceId);

    const config: SpaceConfig = {
      id: spaceId,
      name,
      createKV: this.createSpaceScopedKV.bind(this),
      createVault: this.createSpaceScopedVault.bind(this),
      createDelegations: this.createSpaceScopedDelegations.bind(this),
      createSharing: this.createSpaceScopedSharing.bind(this),
      getInfo: this.getSpaceInfo.bind(this),
    };

    const space = new Space(config);
    this.spaceCache.set(spaceId, space);

    return space;
  }

  /**
   * Resolve a name or URI to a full space ID.
   */
  private resolveSpaceId(nameOrUri: string): string {
    const parsed = parseSpaceUri(nameOrUri);

    if (!parsed) {
      // Invalid format, return as-is
      return nameOrUri;
    }

    if (parsed.owner) {
      // Full URI - return as-is
      return nameOrUri;
    }

    // Short name - build full URI from user's DID
    if (this.userDid) {
      return buildSpaceUri(this.userDid, parsed.name);
    }

    // No user DID available, return as-is
    return nameOrUri;
  }

  // ===========================================================================
  // Exists Check
  // ===========================================================================

  /**
   * Check if a space exists and the user has access.
   */
  async exists(nameOrUri: string): Promise<Result<boolean, ServiceError>> {
    const spaceId = this.resolveSpaceId(nameOrUri);

    // Check info cache first
    const cached = this.infoCache.get(spaceId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTTL) {
      return ok(true);
    }

    // Query the server
    const infoResult = await this.getSpaceInfo(spaceId);
    return ok(infoResult.ok);
  }

  // ===========================================================================
  // Space Info
  // ===========================================================================

  /**
   * Get space info from server or cache.
   */
  private async getSpaceInfo(spaceId: string): Promise<Result<SpaceInfo, ServiceError>> {
    // Check cache
    const cached = this.infoCache.get(spaceId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTTL) {
      return ok(cached.info);
    }

    if (!this.session) {
      return err(
        serviceError(SpaceErrorCodes.AUTH_REQUIRED, "Authentication required", SERVICE_NAME)
      );
    }

    try {
      const headers = this.invoke(this.session, "space", spaceId, "tinycloud.space/info");

      const response = await this.fetchFn(`${this.host}/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ spaceId }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return err(
            serviceError(SpaceErrorCodes.NOT_FOUND, `Space not found: ${spaceId}`, SERVICE_NAME)
          );
        }

        const errorText = await response.text();
        return err(
          serviceError(
            SpaceErrorCodes.NETWORK_ERROR,
            `Failed to get space info: ${response.status} - ${errorText}`,
            SERVICE_NAME
          )
        );
      }

      const rawData = await response.json();

      // Validate server response
      const validationResult = validateServerSpaceInfoResponse(rawData);
      if (!validationResult.ok) {
        return err(
          serviceError(
            SpaceErrorCodes.NETWORK_ERROR,
            validationResult.error.message,
            SERVICE_NAME,
            { meta: validationResult.error.meta }
          )
        );
      }

      const data = validationResult.data;
      const spaceInfo: SpaceInfo = {
        id: data.id,
        name: data.name ?? this.extractNameFromId(data.id),
        owner: data.owner,
        type: data.type ?? (data.owner === this.userDid ? "owned" : "delegated"),
        permissions: data.permissions,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      };

      // Cache the info
      this.infoCache.set(spaceId, { info: spaceInfo, cachedAt: Date.now() });

      return ok(spaceInfo);
    } catch (error) {
      return err(
        serviceError(
          SpaceErrorCodes.NETWORK_ERROR,
          `Network error getting space info: ${String(error)}`,
          SERVICE_NAME,
          { cause: error instanceof Error ? error : undefined }
        )
      );
    }
  }

  // ===========================================================================
  // Space-Scoped Service Factories
  // ===========================================================================

  /**
   * Create a space-scoped KV service.
   */
  private createSpaceScopedKV(spaceId: string): IKVService {
    if (this.createKVServiceFn) {
      return this.createKVServiceFn(spaceId);
    }

    // Return a proxy that throws a helpful error
    return new Proxy({} as IKVService, {
      get: () => {
        throw new Error(
          "KV service factory not configured. Provide createKVService in SpaceServiceConfig."
        );
      },
    });
  }

  /**
   * Create a space-scoped Data Vault service.
   */
  private createSpaceScopedVault(spaceId: string): IDataVaultService {
    if (this.createVaultServiceFn) {
      return this.createVaultServiceFn(spaceId);
    }

    return new Proxy({} as IDataVaultService, {
      get: () => {
        throw new Error(
          "Vault service factory not configured. Provide createVaultService in SpaceServiceConfig."
        );
      },
    });
  }

  /**
   * Create space-scoped delegation operations.
   */
  private createSpaceScopedDelegations(spaceId: string): ISpaceScopedDelegations {
    const self = this;

    return {
      async list(): Promise<Result<Delegation[], ServiceError>> {
        // List outgoing delegations (created by user) using tinycloud.capabilities/read
        try {
          // Facts contain the query params for the capabilities/read capability
          const facts = [
            {
              capabilitiesReadParams: {
                type: "list",
                filters: { direction: "created" },
              },
            },
          ];

          // The capabilities/read endpoint requires path="all" to match server routing
          const headers = self.invoke(
            self.session,
            "capabilities",
            "all",
            "tinycloud.capabilities/read",
            facts
          );

          const response = await self.fetchFn(`${self.host}/invoke`, {
            method: "POST",
            headers,
          });

          if (!response.ok) {
            const errorText = await response.text();
            return err(
              serviceError(
                SpaceErrorCodes.NETWORK_ERROR,
                `Failed to list delegations: ${response.status} - ${errorText}`,
                SERVICE_NAME
              )
            );
          }

          // Server returns { [cid: string]: DelegationInfo } - validate and transform to Delegation[]
          const rawData = await response.json();

          // Validate server response
          const validationResult = validateServerDelegationsResponse(rawData);
          if (!validationResult.ok) {
            return err(
              serviceError(
                SpaceErrorCodes.NETWORK_ERROR,
                validationResult.error.message,
                SERVICE_NAME,
                { meta: validationResult.error.meta }
              )
            );
          }

          const delegations = transformServerDelegations(validationResult.data, spaceId);
          return ok(delegations);
        } catch (error) {
          return err(
            serviceError(
              SpaceErrorCodes.NETWORK_ERROR,
              `Network error listing delegations: ${String(error)}`,
              SERVICE_NAME
            )
          );
        }
      },

      async listReceived(): Promise<Result<Delegation[], ServiceError>> {
        // List incoming delegations (received by user) using tinycloud.capabilities/read
        try {
          // Facts contain the query params for the capabilities/read capability
          const facts = [
            {
              capabilitiesReadParams: {
                type: "list",
                filters: { direction: "received" },
              },
            },
          ];

          // The capabilities/read endpoint requires path="all" to match server routing
          const headers = self.invoke(
            self.session,
            "capabilities",
            "all",
            "tinycloud.capabilities/read",
            facts
          );

          const response = await self.fetchFn(`${self.host}/invoke`, {
            method: "POST",
            headers,
          });

          if (!response.ok) {
            const errorText = await response.text();
            return err(
              serviceError(
                SpaceErrorCodes.NETWORK_ERROR,
                `Failed to list received delegations: ${response.status} - ${errorText}`,
                SERVICE_NAME
              )
            );
          }

          // Server returns { [cid: string]: DelegationInfo } - validate and transform to Delegation[]
          const rawData = await response.json();

          // Validate server response
          const validationResult = validateServerDelegationsResponse(rawData);
          if (!validationResult.ok) {
            return err(
              serviceError(
                SpaceErrorCodes.NETWORK_ERROR,
                validationResult.error.message,
                SERVICE_NAME,
                { meta: validationResult.error.meta }
              )
            );
          }

          const delegations = transformServerDelegations(validationResult.data, spaceId);
          return ok(delegations);
        } catch (error) {
          return err(
            serviceError(
              SpaceErrorCodes.NETWORK_ERROR,
              `Network error listing received delegations: ${String(error)}`,
              SERVICE_NAME
            )
          );
        }
      },

      async create(
        params: Omit<CreateDelegationParams, "spaceId">
      ): Promise<Result<Delegation, ServiceError>> {
        // Use the platform-provided createDelegation function (SIWE-based flow)
        if (self.createDelegationFn) {
          return self.createDelegationFn({ ...params, spaceId });
        }

        // Fallback: return error if no createDelegation function provided
        // The old invoke-based approach doesn't work because /delegate expects
        // SIWE delegation headers, not invocation headers
        return err(
          serviceError(
            SpaceErrorCodes.NOT_INITIALIZED,
            "Delegation creation requires a createDelegation function. " +
              "This should be provided by the platform SDK (web-sdk or node-sdk).",
            SERVICE_NAME
          )
        );
      },

      async revoke(cid: string): Promise<Result<void, ServiceError>> {
        try {
          const headers = self.invoke(
            self.session,
            "delegation",
            cid,
            "tinycloud.delegation/revoke"
          );

          const response = await self.fetchFn(`${self.host}/revoke`, {
            method: "POST",
            headers,
            body: JSON.stringify({ cid, spaceId }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            return err(
              serviceError(
                SpaceErrorCodes.NETWORK_ERROR,
                `Failed to revoke delegation: ${response.status} - ${errorText}`,
                SERVICE_NAME
              )
            );
          }

          return ok(undefined);
        } catch (error) {
          return err(
            serviceError(
              SpaceErrorCodes.NETWORK_ERROR,
              `Network error revoking delegation: ${String(error)}`,
              SERVICE_NAME
            )
          );
        }
      },
    };
  }

  /**
   * Create space-scoped sharing operations.
   *
   * When a SharingService is configured, delegates to client-side v2 sharing.
   * V2 sharing links are self-contained with embedded private keys - no server tracking.
   */
  private createSpaceScopedSharing(spaceId: string): ISpaceScopedSharing {
    const self = this;

    return {
      async generate(
        params: Omit<GenerateShareParams, "spaceId">
      ): Promise<Result<ShareLink, ServiceError>> {
        // Use v2 SharingService when available (client-side sharing links)
        if (self.sharingService) {
          // Note: SharingService uses session.spaceId for the space.
          // For space-scoped sharing on delegated spaces, ensure the session
          // is configured for the correct space before calling generate().
          const result = await self.sharingService.generate(params);
          if (!result.ok) {
            return err(
              serviceError(
                SpaceErrorCodes.NETWORK_ERROR,
                result.error.message || "Failed to generate share link",
                SERVICE_NAME
              )
            );
          }
          return ok(result.data);
        }

        // Fallback: return error since server endpoint doesn't exist
        return err(
          serviceError(
            SpaceErrorCodes.NOT_INITIALIZED,
            "SharingService not configured. V2 sharing requires a SharingService instance.",
            SERVICE_NAME
          )
        );
      },

      async list(): Promise<Result<ShareLink[], ServiceError>> {
        // V2 sharing links are self-contained (not server-tracked)
        // This operation is not supported in the v2 spec
        return err(
          serviceError(
            SpaceErrorCodes.NOT_INITIALIZED,
            "Listing share links is not supported in v2. Share links are self-contained tokens that are not tracked on the server.",
            SERVICE_NAME
          )
        );
      },

      async revoke(token: string): Promise<Result<void, ServiceError>> {
        // V2 sharing links are revoked by revoking the underlying delegation
        // This requires the delegation CID, not the share token
        return err(
          serviceError(
            SpaceErrorCodes.NOT_INITIALIZED,
            "Revoking share links by token is not supported in v2. To revoke access, revoke the underlying delegation using space.delegations.revoke(cid).",
            SERVICE_NAME
          )
        );
      },
    };
  }
}

/**
 * Create a new SpaceService instance.
 *
 * @param config - Service configuration
 * @returns A new SpaceService instance
 */
export function createSpaceService(config: SpaceServiceConfig): ISpaceService {
  return new SpaceService(config);
}
