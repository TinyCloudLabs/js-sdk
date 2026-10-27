/**
 * DelegationManager - Handles delegation CRUD operations.
 *
 * This class manages the revocation, status, and querying
 * of delegations within TinyCloud. It extracts and improves upon the
 * delegation functionality previously in ITinyCloudStorage.
 *
 * @packageDocumentation
 */

import type {
  FetchFunction,
  FetchResponse,
  InvokeAnyFunction,
  InvokeFunction,
  ServiceSession,
  ServiceHeaders,
} from "@tinycloud/sdk-services";
import {
  Result,
  DelegationErrorCodes,
  Delegation,
  DelegationStatus,
  DelegationStatusSchema,
  DelegationRevocationReceipt,
  DelegationRevocationReceiptSchema,
  AccountDelegationPage,
  AccountDelegationPageSchema,
  AccountDelegationQueryOptionsSchema,
  AccountDelegationQueryOptions,
  AccountDelegationRecord,
  SessionInvocationSigner,
  DelegationChain,
  DelegationManagerConfig,
} from "./types";
import { DelegationAction, createError } from "./shared";
import type { IssuedContext } from "./issued";

/**
 * Parses the JSON body of an `/invoke` response. The node answers an
 * invocation it has no handler for with an empty 2xx body; report that as an
 * unsupported operation rather than letting JSON.parse throw.
 */
async function readInvokedJson<T>(response: FetchResponse, action: string): Promise<Result<T>> {
  const text = await response.text();
  if (text.trim() === "") {
    return {
      ok: false,
      error: createError(
        DelegationErrorCodes.UNSUPPORTED_OPERATION,
        `The node answered ${action} with an empty ${response.status} response; it does not support this operation`,
        undefined,
        { status: response.status, action },
      ),
    };
  }
  return { ok: true, data: JSON.parse(text) as T };
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
 * // Revoke a delegation
 * const result = await delegations.revoke("bafy...");
 *
 * if (result.ok) {
 *   console.log("Revoked");
 * }
 * ```
 */
export class DelegationManager {
  private hosts: string[];
  private session: ServiceSession;
  private invoke: InvokeFunction;
  private invokeAny?: InvokeAnyFunction;
  private signOwnerRevocation?: (cid: string) => Promise<string>;
  private fetchFn: FetchFunction;
  private accountSpaceId?: string;
  private sessionInvocationSigner?: SessionInvocationSigner;
  private issuedState = { issuedQuerySupported: false };

  /**
   * Creates a new DelegationManager instance.
   *
   * @param config - Configuration including hosts, session, and invoke function
   */
  constructor(config: DelegationManagerConfig) {
    this.hosts = config.hosts;
    this.session = config.session;
    this.invoke = config.invoke;
    this.invokeAny = config.invokeAny;
    this.signOwnerRevocation = config.signOwnerRevocation;
    this.sessionInvocationSigner = config.sessionInvocationSigner;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.accountSpaceId = config.accountSpaceId;
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
   * Revokes an existing delegation.
   *
   * Once revoked, the delegation can no longer be used to access resources.
   * This also invalidates any sub-delegations derived from this delegation.
   *
   * Explicit target-space or authority options keep the delegated session
   * signing path even when an owner signer is available.
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
  async revoke(
    cid: string,
    options?: {
      targetSpaceId?: string;
      authorityCid?: string;
    },
  ): Promise<Result<DelegationRevocationReceipt>> {
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
      const ownerSigner =
        options?.targetSpaceId === undefined && options?.authorityCid === undefined
          ? this.signOwnerRevocation
          : undefined;
      if (!ownerSigner && !this.invokeAny) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.NOT_INITIALIZED,
            "Revocation requires an owner signer or invokeAny function that can sign the target CID"
          ),
        };
      }

      let headers: ServiceHeaders;
      if (ownerSigner) {
        headers = { Authorization: await ownerSigner(cid) };
      } else {
        const entry = {
          resource: `urn:cid:${cid}`,
          ...(options?.targetSpaceId === undefined ? {} : { spaceId: options.targetSpaceId }),
          service: "delegation",
          path: "",
          action: DelegationAction.REVOKE,
        } as Parameters<InvokeAnyFunction>[1][number] & { revokeAuthorityCid?: string };
        if (options?.authorityCid !== undefined) {
          Object.defineProperty(entry, "revokeAuthorityCid", {
            value: options.authorityCid,
            enumerable: false,
          });
        }
        headers = this.invokeAny!(this.session, [entry]);
      }
      const response = await this.fetchFn(`${this.host}/revoke`, {
        method: "POST",
        headers,
      });

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

      const parsed = DelegationRevocationReceiptSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.cid !== cid) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.REVOCATION_FAILED,
            "Node returned an invalid delegation revocation receipt",
            undefined,
            { cid },
          ),
        };
      }
      return { ok: true, data: parsed.data };
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
   * Reads the node-confirmed lifecycle state of one delegation without
   * exposing delegation metadata.
   */
  async status(cid: string): Promise<Result<DelegationStatus>> {
    if (!cid) {
      return {
        ok: false,
        error: createError(DelegationErrorCodes.INVALID_INPUT, "cid is required"),
      };
    }
    if (!this.invokeAny) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Delegation status requires an invokeAny function that can sign the target CID"
        ),
      };
    }

    try {
      const headers = this.invokeAny(this.session, [{
        resource: `urn:cid:${cid}`,
        service: "delegation",
        path: "",
        action: DelegationAction.STATUS,
      }]);
      const response = await this.fetchFn(`${this.host}/delegation/status`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ cid }),
      });
      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.NETWORK_ERROR,
            `Failed to get delegation status: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status, cid }
          ),
        };
      }
      const parsed = DelegationStatusSchema.safeParse(await response.json());
      const responseStatusMatches = parsed.success && (
        response.status === 404
          ? parsed.data.status === "not_found" && !parsed.data.exists
          : parsed.data.status !== "not_found"
      );
      if (!parsed.success || parsed.data.cid !== cid || !responseStatusMatches) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.INVALID_TOKEN,
            "Node returned an invalid delegation status response",
            undefined,
            { cid }
          ),
        };
      }
      return { ok: true, data: parsed.data };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          error: createError(DelegationErrorCodes.ABORTED, "Request aborted", error),
        };
      }
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during delegation status: ${String(error)}`,
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  /**
   * Query lifecycle-complete delegation history for the authenticated account.
   *
   * `scope.spaces` lists the spaces to sign `tinycloud.delegation/list` for, in order. Omitted, the
   * account space is tried, then the session's own space. A caller that knows which of them the session
   * holds passes only those; an empty list sends nothing and answers PERMISSION_DENIED.
   */
  async query(
    options: AccountDelegationQueryOptions = {},
    scope: { readonly spaces?: readonly string[] } = {},
  ): Promise<Result<AccountDelegationPage>> {
    const validated = AccountDelegationQueryOptionsSchema.safeParse(options);
    if (!validated.success) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.INVALID_INPUT,
          "Invalid delegation query options",
          undefined,
          { issues: validated.error.issues },
        ),
      };
    }
    if (validated.data.direction === "issued") return this.queryIssued(validated.data);
    if (!this.invokeAny) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Delegation query requires an invokeAny function",
        ),
      };
    }
    const accountSpaceId = this.accountSpaceId;
    if (!accountSpaceId) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Delegation query requires an account space",
        ),
      };
    }
    try {
      // The node reads the account from the space's owner DID only, so delegation/list on any of the
      // owner's spaces works. Sign for the account space if the session holds it there, else for the
      // session's own space (a plain OpenKey login grants only that one).
      let response: FetchResponse | undefined;
      for (const spaceId of new Set(scope.spaces ?? [accountSpaceId, this.session.spaceId])) {
        // A signing failure is not a permission refusal: it propagates as a typed error below.
        const headers = Object.fromEntries(new Headers(this.invokeAny(this.session, [{
          spaceId,
          service: "delegation",
          path: "",
          action: DelegationAction.LIST,
        }])).entries());
        headers["content-type"] = "application/json";
        response = await this.fetchFn(`${this.host}/delegation/query`, {
          method: "POST",
          headers,
          body: JSON.stringify(validated.data),
        });
        if (response.status !== 403) break;
      }
      if (!response || response.status === 403) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.PERMISSION_DENIED,
            "This session does not hold tinycloud.delegation/list on the account space or its own space",
            undefined,
            { status: 403 },
          ),
        };
      }
      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.NETWORK_ERROR,
            `Failed to query delegations: ${response.status} - ${errorText}`,
            undefined,
            { status: response.status },
          ),
        };
      }
      const parsed = AccountDelegationPageSchema.safeParse(await response.json());
      if (!parsed.success) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.INVALID_TOKEN,
            "Node returned an invalid delegation query response",
          ),
        };
      }
      return { ok: true, data: parsed.data };
    } catch (error) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during delegation query: ${String(error)}`,
          error instanceof Error ? error : undefined,
        ),
      };
    }
  }

  /** The state the lazily loaded issued-delegation module reads and updates. */
  private issuedContext(): IssuedContext {
    return {
      host: this.host,
      fetchFn: this.fetchFn,
      sessionInvocationSigner: this.sessionInvocationSigner,
      state: this.issuedState,
    };
  }

  /**
   * Lists the delegations this session's own key issued (`direction: "issued"`).
   * The implementation loads on first use.
   */
  private async queryIssued(
    options: AccountDelegationQueryOptions,
  ): Promise<Result<AccountDelegationPage>> {
    // Deferred so bundles that never list issued delegations do not carry ./issued.
    const issued = await import("./issued");
    return issued.queryIssued(this.issuedContext(), options);
  }

  /**
   * Every delegation this session's key issued, following `nextCursor` until
   * it is absent. `maxItems` stops early once that many are collected;
   * `untilCid` stops after the page that contains that delegation. Items come
   * in CID order (each carries `issuedAt`). The implementation loads on first use.
   */
  async queryAllIssued(
    options: Pick<AccountDelegationQueryOptions, "status" | "space"> & {
      pageSize?: number;
      maxItems?: number;
      untilCid?: string;
    } = {},
  ): Promise<Result<AccountDelegationRecord[]>> {
    // Deferred so bundles that never list issued delegations do not carry ./issued.
    const issued = await import("./issued");
    return issued.queryAllIssued((page) => this.query(page), options);
  }

  /**
   * Revokes a delegation this session's key issued, with no proof: a UCAN
   * signed by the session's own did:key carrying `urn:cid:<cid>` and
   * `tinycloud.delegation/revoke`. Revoking a delegation that is already revoked
   * succeeds. A refusal (the key is not the delegator) carries the node's
   * message; 503 means the chain is too deep right now, retry later.
   * The implementation loads on first use.
   */
  async revokeIssued(cid: string): Promise<Result<DelegationRevocationReceipt>> {
    // Deferred so bundles that never revoke issued delegations do not carry ./issued.
    const issued = await import("./issued");
    return issued.revokeIssued(this.issuedContext(), cid);
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

      const parsed = await readInvokedJson<{
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
      }>(response, DelegationAction.GET);
      if (!parsed.ok) return parsed;
      const data = parsed.data;

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

      const body2 = await readInvokedJson<{ allowed: boolean }>(response, DelegationAction.CHECK);
      if (!body2.ok) return body2;
      return { ok: true, data: body2.data.allowed };
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
