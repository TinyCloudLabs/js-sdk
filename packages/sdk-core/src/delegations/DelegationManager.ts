/**
 * DelegationManager - Handles delegation CRUD operations.
 *
 * This class manages the creation, revocation, listing, and querying
 * of delegations within TinyCloud. It extracts and improves upon the
 * delegation functionality previously in ITinyCloudStorage.
 *
 * @packageDocumentation
 */

import type {
  FetchFunction,
  FetchResponse,
  InvokeFunction,
  ServiceSession,
} from "@tinycloud/sdk-services";
import {
  Result,
  DelegationError,
  DelegationErrorCodes,
  Delegation,
  CreateDelegationParams,
  DelegationChain,
  DelegationManagerConfig,
  DelegationApiResponse,
} from "./types";
import { EXPIRY } from "../expiry";

/**
 * Delegation action constants.
 */
const DelegationAction = {
  CREATE: "tinycloud.delegation/create",
  REVOKE: "tinycloud.delegation/revoke",
  LIST: "tinycloud.delegation/list",
  GET: "tinycloud.delegation/get",
  CHECK: "tinycloud.delegation/check",
} as const;

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
 * DelegationManager handles all delegation-related operations.
 *
 * @example
 * ```typescript
 * import { DelegationManager } from "@tinycloud/sdk-core/delegations";
 *
 * const delegations = new DelegationManager({
 *   hosts: ["https://node.tinycloud.xyz"],
 *   session,
 *   invoke,
 * });
 *
 * // Create a delegation
 * const result = await delegations.create({
 *   delegateDID: "did:pkh:eip155:1:0x...",
 *   path: "shared/",
 *   actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
 *   expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
 * });
 *
 * if (result.ok) {
 *   console.log("Created delegation:", result.data.cid);
 * }
 * ```
 */
export class DelegationManager {
  private hosts: string[];
  private session: ServiceSession;
  private invoke: InvokeFunction;
  private fetchFn: FetchFunction;

  /**
   * Creates a new DelegationManager instance.
   *
   * @param config - Configuration including hosts, session, and invoke function
   */
  constructor(config: DelegationManagerConfig) {
    this.hosts = config.hosts;
    this.session = config.session;
    this.invoke = config.invoke;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Updates the session (e.g., after re-authentication).
   *
   * @param session - New session to use for operations
   */
  public updateSession(session: ServiceSession): void {
    this.session = session;
  }

  /**
   * Gets the primary host URL.
   */
  private get host(): string {
    return this.hosts[0];
  }

  /**
   * Executes an invoke operation against the delegation API.
   */
  private async invokeOperation(
    path: string,
    action: string,
    body?: string
  ): Promise<FetchResponse> {
    const headers = this.invoke(this.session, "delegation", path, action);

    return this.fetchFn(`${this.host}/invoke`, {
      method: "POST",
      headers,
      body,
    });
  }

  /**
   * Creates a new delegation.
   *
   * Delegates specific permissions to another DID for a given path.
   * The delegatee can then use these permissions to access resources
   * within the specified scope.
   *
   * @param params - Parameters for the delegation
   * @returns Result containing the created Delegation or an error
   *
   * @example
   * ```typescript
   * const result = await manager.create({
   *   delegateDID: bob.did,
   *   path: "documents/shared/",
   *   actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
   *   expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
   * });
   * ```
   */
  async create(params: CreateDelegationParams): Promise<Result<Delegation>> {
    // Validate inputs
    if (!params.delegateDID) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "delegateDID is required"
        ),
      };
    }

    if (!params.path) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "path is required"
        ),
      };
    }

    if (!params.actions || params.actions.length === 0) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "at least one action is required"
        ),
      };
    }

    try {
      const body = JSON.stringify({
        delegateDID: params.delegateDID,
        path: params.path,
        actions: params.actions,
        expiry: params.expiry?.toISOString(),
        disableSubDelegation: params.disableSubDelegation ?? false,
        statement: params.statement,
      });

      const response = await this.invokeOperation(
        params.path,
        DelegationAction.CREATE,
        body
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.CREATION_FAILED,
            `Failed to create delegation: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status, path: params.path }
          ),
        };
      }

      const apiResponse = (await response.json()) as DelegationApiResponse;

      const delegation: Delegation = {
        cid: apiResponse.cid ?? "",
        delegateDID: params.delegateDID,
        spaceId: this.session.spaceId,
        path: params.path,
        actions: params.actions,
        expiry: params.expiry ?? new Date(Date.now() + EXPIRY.SHARE_MS),
        isRevoked: false,
        allowSubDelegation: !(params.disableSubDelegation ?? false),
        createdAt: new Date(),
      };

      return { ok: true, data: delegation };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.ABORTED,
            "Request aborted",
            error
          ),
        };
      }
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during delegation creation: ${String(error)}`,
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  /**
   * Revokes an existing delegation.
   *
   * Once revoked, the delegation can no longer be used to access resources.
   * This also invalidates any sub-delegations derived from this delegation.
   *
   * @param cid - The CID of the delegation to revoke
   * @returns Result indicating success or an error
   *
   * @example
   * ```typescript
   * const result = await manager.revoke("bafy...");
   * if (result.ok) {
   *   console.log("Delegation revoked successfully");
   * }
   * ```
   */
  async revoke(cid: string): Promise<Result<void>> {
    if (!cid) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "cid is required"
        ),
      };
    }

    try {
      const body = JSON.stringify({ cid });

      const response = await this.invokeOperation(
        cid,
        DelegationAction.REVOKE,
        body
      );

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 404) {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.NOT_FOUND,
              `Delegation not found: ${cid}`
            ),
          };
        }

        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.REVOCATION_FAILED,
            `Failed to revoke delegation: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status, cid }
          ),
        };
      }

      return { ok: true, data: undefined };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.ABORTED,
            "Request aborted",
            error
          ),
        };
      }
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during delegation revocation: ${String(error)}`,
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  /**
   * Lists all delegations for the current session's space.
   *
   * Returns both delegations created by the current user (as delegator)
   * and delegations granted to the current user (as delegatee).
   *
   * @returns Result containing an array of Delegations or an error
   *
   * @example
   * ```typescript
   * const result = await manager.list();
   * if (result.ok) {
   *   for (const delegation of result.data) {
   *     console.log(`${delegation.cid}: ${delegation.path} -> ${delegation.delegateDID}`);
   *   }
   * }
   * ```
   */
  async list(): Promise<Result<Delegation[]>> {
    try {
      const response = await this.invokeOperation("", DelegationAction.LIST);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.NETWORK_ERROR,
            `Failed to list delegations: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status }
          ),
        };
      }

      const data = (await response.json()) as Array<{
        cid: string;
        delegateDID: string;
        delegatorDID?: string;
        spaceId: string;
        path: string;
        actions: string[];
        expiry: string;
        isRevoked: boolean;
        createdAt?: string;
        parentCid?: string;
        allowSubDelegation?: boolean;
      }>;

      const delegations: Delegation[] = data.map((item) => ({
        cid: item.cid,
        delegateDID: item.delegateDID,
        delegatorDID: item.delegatorDID,
        spaceId: item.spaceId,
        path: item.path,
        actions: item.actions,
        expiry: new Date(item.expiry),
        isRevoked: item.isRevoked,
        createdAt: item.createdAt ? new Date(item.createdAt) : undefined,
        parentCid: item.parentCid,
        allowSubDelegation: item.allowSubDelegation,
      }));

      return { ok: true, data: delegations };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.ABORTED,
            "Request aborted",
            error
          ),
        };
      }
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during delegation list: ${String(error)}`,
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  /**
   * Gets the full delegation chain for a given delegation.
   *
   * Returns the chain of delegations from the root (original delegator)
   * to the specified delegation, including all intermediate sub-delegations.
   *
   * @param cid - The CID of the delegation to get the chain for
   * @returns Result containing the DelegationChain or an error
   *
   * @example
   * ```typescript
   * const result = await manager.getChain("bafy...");
   * if (result.ok) {
   *   console.log("Chain length:", result.data.length);
   *   for (const delegation of result.data) {
   *     console.log(`- ${delegation.delegatorDID} -> ${delegation.delegateDID}`);
   *   }
   * }
   * ```
   */
  async getChain(cid: string): Promise<Result<DelegationChain>> {
    if (!cid) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "cid is required"
        ),
      };
    }

    try {
      const body = JSON.stringify({ cid, includeChain: true });

      const response = await this.invokeOperation(
        cid,
        DelegationAction.GET,
        body
      );

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 404) {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.NOT_FOUND,
              `Delegation not found: ${cid}`
            ),
          };
        }

        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.NETWORK_ERROR,
            `Failed to get delegation chain: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status, cid }
          ),
        };
      }

      const data = (await response.json()) as {
        chain: Array<{
          cid: string;
          delegateDID: string;
          delegatorDID?: string;
          spaceId: string;
          path: string;
          actions: string[];
          expiry: string;
          isRevoked: boolean;
          createdAt?: string;
          parentCid?: string;
          allowSubDelegation?: boolean;
        }>;
      };

      const chain: DelegationChain = data.chain.map((item) => ({
        cid: item.cid,
        delegateDID: item.delegateDID,
        delegatorDID: item.delegatorDID,
        spaceId: item.spaceId,
        path: item.path,
        actions: item.actions,
        expiry: new Date(item.expiry),
        isRevoked: item.isRevoked,
        createdAt: item.createdAt ? new Date(item.createdAt) : undefined,
        parentCid: item.parentCid,
        allowSubDelegation: item.allowSubDelegation,
      }));

      return { ok: true, data: chain };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.ABORTED,
            "Request aborted",
            error
          ),
        };
      }
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during chain retrieval: ${String(error)}`,
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  /**
   * Checks if the current session has permission for a given path and action.
   *
   * This can be used to verify permissions before attempting an operation,
   * or to implement custom access control logic.
   *
   * @param path - The resource path to check
   * @param action - The action to check (e.g., "tinycloud.kv/get")
   * @returns Result containing a boolean indicating permission or an error
   *
   * @example
   * ```typescript
   * const result = await manager.checkPermission("documents/private/", "tinycloud.kv/put");
   * if (result.ok && result.data) {
   *   console.log("Permission granted");
   * } else {
   *   console.log("Permission denied");
   * }
   * ```
   */
  async checkPermission(path: string, action: string): Promise<Result<boolean>> {
    if (!path) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "path is required"
        ),
      };
    }

    if (!action) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "action is required"
        ),
      };
    }

    try {
      const body = JSON.stringify({ path, action });

      const response = await this.invokeOperation(
        path,
        DelegationAction.CHECK,
        body
      );

      if (!response.ok) {
        // 403 means permission denied, which is a valid result
        if (response.status === 403) {
          return { ok: true, data: false };
        }

        const errorText = await response.text();
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.NETWORK_ERROR,
            `Failed to check permission: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status, path, action }
          ),
        };
      }

      const data = (await response.json()) as { allowed: boolean };
      return { ok: true, data: data.allowed };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.ABORTED,
            "Request aborted",
            error
          ),
        };
      }
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during permission check: ${String(error)}`,
          error instanceof Error ? error : undefined
        ),
      };
    }
  }
}
