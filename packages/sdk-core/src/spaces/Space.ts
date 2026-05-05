/**
 * Space - Represents a scoped access point to a TinyCloud space.
 *
 * The Space object provides scoped access to services within a specific space,
 * whether owned by the user or delegated from another user.
 *
 * @packageDocumentation
 */

import type {
  IDataVaultService,
  IKVService,
  Result,
  ServiceError,
} from "@tinycloud/sdk-services";
import type { SpaceInfo } from "../delegations/types";

/**
 * Interface for space-scoped delegation operations.
 *
 * Provides delegation management scoped to a specific space.
 */
export interface ISpaceScopedDelegations {
  /**
   * List delegations created by the user in this space (outgoing).
   */
  list(): Promise<Result<import("../delegations/types").Delegation[], ServiceError>>;

  /**
   * List delegations received by the user for this space (incoming).
   */
  listReceived(): Promise<Result<import("../delegations/types").Delegation[], ServiceError>>;

  /**
   * Create a delegation within this space.
   */
  create(
    params: Omit<import("../delegations/types").CreateDelegationParams, "spaceId">
  ): Promise<Result<import("../delegations/types").Delegation, ServiceError>>;

  /**
   * Revoke a delegation within this space.
   */
  revoke(cid: string): Promise<Result<void, ServiceError>>;
}

/**
 * Interface for space-scoped sharing operations.
 *
 * Provides sharing link management scoped to a specific space.
 */
export interface ISpaceScopedSharing {
  /**
   * Generate a sharing link for a resource in this space.
   */
  generate(
    params: Omit<import("../delegations/types").GenerateShareParams, "spaceId">
  ): Promise<Result<import("../delegations/types").ShareLink, ServiceError>>;

  /**
   * List active sharing links in this space.
   */
  list(): Promise<Result<import("../delegations/types").ShareLink[], ServiceError>>;

  /**
   * Revoke a sharing link.
   */
  revoke(token: string): Promise<Result<void, ServiceError>>;
}

/**
 * Interface for a Space object.
 *
 * Provides scoped access to services within a specific space.
 */
export interface ISpace {
  /**
   * The space identifier.
   */
  readonly id: string;

  /**
   * The short name of the space.
   */
  readonly name: string;

  /**
   * KV operations scoped to this space.
   */
  readonly kv: IKVService;

  /**
   * Data Vault operations scoped to this space.
   */
  readonly vault: IDataVaultService;

  /**
   * Delegation operations scoped to this space.
   */
  readonly delegations: ISpaceScopedDelegations;

  /**
   * Sharing operations scoped to this space.
   */
  readonly sharing: ISpaceScopedSharing;

  /**
   * Get space metadata.
   */
  info(): Promise<Result<SpaceInfo, ServiceError>>;
}

/**
 * Configuration for creating a Space object.
 */
export interface SpaceConfig {
  /**
   * The space identifier (full URI).
   */
  id: string;

  /**
   * The short name of the space.
   */
  name: string;

  /**
   * Factory function to create a space-scoped KV service.
   */
  createKV: (spaceId: string) => IKVService;

  /**
   * Factory function to create a space-scoped Data Vault service.
   */
  createVault: (spaceId: string) => IDataVaultService;

  /**
   * Factory function to create space-scoped delegations.
   */
  createDelegations: (spaceId: string) => ISpaceScopedDelegations;

  /**
   * Factory function to create space-scoped sharing.
   */
  createSharing: (spaceId: string) => ISpaceScopedSharing;

  /**
   * Function to get space info.
   */
  getInfo: (spaceId: string) => Promise<Result<SpaceInfo, ServiceError>>;
}

/**
 * Space - Provides scoped access to services within a specific space.
 *
 * @example
 * ```typescript
 * const space = sdk.space('default');
 *
 * // KV operations scoped to this space
 * await space.kv.put('key', 'value');
 * const result = await space.kv.get('key');
 *
 * // Delegation operations scoped to this space
 * await space.delegations.create({
 *   delegateDID: 'did:pkh:eip155:1:0x...',
 *   path: '/shared/',
 *   actions: ['tinycloud.kv/get']
 * });
 *
 * // Get space metadata
 * const info = await space.info();
 * ```
 */
export class Space implements ISpace {
  private readonly _id: string;
  private readonly _name: string;
  private readonly _kv: IKVService;
  private readonly _vault: IDataVaultService;
  private readonly _delegations: ISpaceScopedDelegations;
  private readonly _sharing: ISpaceScopedSharing;
  private readonly _getInfo: (spaceId: string) => Promise<Result<SpaceInfo, ServiceError>>;

  /**
   * Create a new Space instance.
   *
   * @param config - Space configuration
   */
  constructor(config: SpaceConfig) {
    this._id = config.id;
    this._name = config.name;
    this._kv = config.createKV(config.id);
    this._vault = config.createVault(config.id);
    this._delegations = config.createDelegations(config.id);
    this._sharing = config.createSharing(config.id);
    this._getInfo = config.getInfo;
  }

  /**
   * The space identifier (full URI).
   */
  get id(): string {
    return this._id;
  }

  /**
   * The short name of the space.
   */
  get name(): string {
    return this._name;
  }

  /**
   * KV operations scoped to this space.
   */
  get kv(): IKVService {
    return this._kv;
  }

  /**
   * Data Vault operations scoped to this space.
   */
  get vault(): IDataVaultService {
    return this._vault;
  }

  /**
   * Delegation operations scoped to this space.
   */
  get delegations(): ISpaceScopedDelegations {
    return this._delegations;
  }

  /**
   * Sharing operations scoped to this space.
   */
  get sharing(): ISpaceScopedSharing {
    return this._sharing;
  }

  /**
   * Get space metadata.
   *
   * @returns Result containing space information
   */
  async info(): Promise<Result<SpaceInfo, ServiceError>> {
    return this._getInfo(this._id);
  }
}
