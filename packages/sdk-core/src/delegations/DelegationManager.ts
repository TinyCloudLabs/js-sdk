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
  DelegationError,
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

/**
 * Delegation action constants.
 */
const DelegationAction = {
  REVOKE: "tinycloud.delegation/revoke",
  STATUS: "tinycloud.delegation/status",
  LIST: "tinycloud.delegation/list",
  GET: "tinycloud.delegation/get",
  CHECK: "tinycloud.delegation/check",
} as const;

/** `GET /info` feature that marks a node able to answer `direction: "issued"` queries. */
const ISSUED_QUERY_FEATURE = "delegation-issued-query-v1";

/** The node's plain-text refusal reason, without control characters and bounded in length. */
async function refusalText(response: FetchResponse): Promise<string> {
  const text = await response.text();
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
}

/**
 * Maps a non-2xx answer to an issued-delegation query or proofless revocation.
 * The node refuses with a plain-text 403, answers 400 for a cursor it will not
 * accept (the same answer for a malformed, foreign or other-filter cursor) and
 * 503 "Delegation query unavailable" for a chain it will not evaluate (deeper
 * than 64 levels or 4096 nodes; the whole page fails, no partial items).
 */
async function issuedHttpError(
  response: FetchResponse,
  what: string,
  meta: Record<string, unknown>,
): Promise<DelegationError> {
  const text = await refusalText(response);
  const details = { ...meta, status: response.status };
  if (response.status === 403) {
    return createError(
      DelegationErrorCodes.PERMISSION_DENIED,
      text === "" ? "The node refused the request" : text,
      undefined,
      details,
    );
  }
  if (response.status === 400 && text.includes("invalid delegation query cursor")) {
    return createError(
      DelegationErrorCodes.INVALID_CURSOR,
      "The node rejected the page cursor; list again from the start",
      undefined,
      details,
    );
  }
  if (response.status === 503) {
    return createError(
      DelegationErrorCodes.CHAIN_TOO_DEEP,
      "A delegation chain is too deep for the node to evaluate right now; try again later",
      undefined,
      { ...details, retryable: true },
    );
  }
  return createError(
    DelegationErrorCodes.NETWORK_ERROR,
    `${what}: ${response.status} - ${text}`,
    undefined,
    details,
  );
}

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
  private issuedQuerySupported = false;

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

  /**
   * Whether the node advertises `delegation-issued-query-v1` in `GET /info`.
   * A positive answer is remembered; an absent flag is read again next time.
   */
  private async nodeListsIssued(): Promise<Result<boolean>> {
    if (this.issuedQuerySupported) return { ok: true, data: true };
    const response = await this.fetchFn(`${this.host}/info`);
    if (!response.ok) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Failed to read node info: ${response.status}`,
          undefined,
          { status: response.status },
        ),
      };
    }
    const info = (await response.json()) as { features?: unknown };
    this.issuedQuerySupported =
      Array.isArray(info.features) && info.features.includes(ISSUED_QUERY_FEATURE);
    return { ok: true, data: this.issuedQuerySupported };
  }

  /**
   * Lists the delegations this session's own key issued: one invocation signed
   * by that key with the single capability `tinycloud.delegation/list` on
   * `<key DID>/delegation` and no proof. Pages are ordered by delegation CID,
   * not by time, and may be short; only a missing `nextCursor` ends the list.
   */
  private async queryIssued(
    options: AccountDelegationQueryOptions,
  ): Promise<Result<AccountDelegationPage>> {
    const signer = this.sessionInvocationSigner;
    if (!signer) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Listing issued delegations requires a session key signer",
        ),
      };
    }
    try {
      const supported = await this.nodeListsIssued();
      if (!supported.ok) return supported;
      if (!supported.data) {
        return {
          ok: false,
          error: createError(
            DelegationErrorCodes.UNSUPPORTED_OPERATION,
            "this node does not support listing issued delegations yet",
            undefined,
            { feature: ISSUED_QUERY_FEATURE },
          ),
        };
      }
      const authorization = await signer.sign({
        [`${signer.did()}/delegation`]: { [DelegationAction.LIST]: [{}] },
      });
      const response = await this.fetchFn(`${this.host}/delegation/query`, {
        method: "POST",
        headers: { Authorization: authorization, "content-type": "application/json" },
        body: JSON.stringify(options),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: await issuedHttpError(response, "Failed to query issued delegations", {}),
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

  /**
   * Every delegation this session's key issued, following `nextCursor` until
   * it is absent. `maxItems` stops early once that many are collected;
   * `untilCid` stops after the page that contains that delegation. Items come
   * in CID order (each carries `issuedAt`).
   */
  async queryAllIssued(
    options: Pick<AccountDelegationQueryOptions, "status" | "space"> & {
      pageSize?: number;
      maxItems?: number;
      untilCid?: string;
    } = {},
  ): Promise<Result<AccountDelegationRecord[]>> {
    const { pageSize = 100, maxItems, untilCid, ...filters } = options;
    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 1)) {
      return {
        ok: false,
        error: createError(DelegationErrorCodes.INVALID_INPUT, "maxItems must be a positive integer"),
      };
    }
    const items: AccountDelegationRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const limit = Math.min(pageSize, maxItems === undefined ? pageSize : maxItems - items.length);
      const page = await this.query({
        ...filters,
        direction: "issued",
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page.ok) return page;
      items.push(...page.data.items);
      cursor = page.data.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) {
          return {
            ok: false,
            error: createError(
              DelegationErrorCodes.INVALID_TOKEN,
              "Node returned a repeated page cursor for the issued delegation query",
            ),
          };
        }
        seen.add(cursor);
      }
    } while (
      cursor !== undefined &&
      (maxItems === undefined || items.length < maxItems) &&
      !(untilCid !== undefined && items.some((item) => item.cid === untilCid))
    );
    return { ok: true, data: maxItems === undefined ? items : items.slice(0, maxItems) };
  }

  /**
   * Revokes a delegation this session's key issued, with no proof: a UCAN
   * signed by the session's own did:key carrying `urn:cid:<cid>` and
   * `tinycloud.delegation/revoke`. It does not depend on the session's own
   * delegation staying valid. Revoking a delegation that is already revoked
   * succeeds. A refusal (the key is not the delegator) carries the node's
   * message; 503 means the chain is too deep right now, retry later.
   */
  async revokeIssued(cid: string): Promise<Result<DelegationRevocationReceipt>> {
    if (!cid) {
      return {
        ok: false,
        error: createError(DelegationErrorCodes.INVALID_INPUT, "cid is required"),
      };
    }
    const signer = this.sessionInvocationSigner;
    if (!signer) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NOT_INITIALIZED,
          "Revoking an issued delegation requires a session key signer",
        ),
      };
    }
    try {
      const authorization = await signer.sign({
        [`urn:cid:${cid}`]: { [DelegationAction.REVOKE]: [{}] },
      });
      const response = await this.fetchFn(`${this.host}/revoke`, {
        method: "POST",
        headers: { Authorization: authorization },
      });
      if (!response.ok) {
        if (response.status === 404) {
          return {
            ok: false,
            error: createError(DelegationErrorCodes.NOT_FOUND, `Delegation not found: ${cid}`),
          };
        }
        return {
          ok: false,
          error: await issuedHttpError(response, "Failed to revoke delegation", { cid }),
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
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.NETWORK_ERROR,
          `Network error during delegation revocation: ${String(error)}`,
          error instanceof Error ? error : undefined,
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
