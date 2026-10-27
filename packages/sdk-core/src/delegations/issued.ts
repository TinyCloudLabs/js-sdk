/**
 * Issued-delegation listing and proofless revocation.
 *
 * DelegationManager loads this module with a dynamic `import()` the first time
 * `query({ direction: "issued" })`, `queryAllIssued` or `revokeIssued` runs, so
 * bundles that never list or revoke issued delegations do not carry it. It
 * must not import DelegationManager as a value.
 *
 * @packageDocumentation
 */

import type { FetchFunction, FetchResponse } from "@tinycloud/sdk-services";
import {
  DelegationErrorCodes,
  DelegationRevocationReceiptSchema,
  AccountDelegationPageSchema,
} from "./types.schema";
import type {
  Result,
  DelegationError,
  DelegationRevocationReceipt,
  AccountDelegationPage,
  AccountDelegationQueryOptions,
  AccountDelegationRecord,
  SessionInvocationSigner,
} from "./types.schema";
import { DelegationAction, createError } from "./shared";

/** `GET /info` feature that marks a node able to answer `direction: "issued"` queries. */
const ISSUED_QUERY_FEATURE = "delegation-issued-query-v1";

/** What the issued-delegation functions need from the DelegationManager that owns them. */
export interface IssuedContext {
  host: string;
  fetchFn: FetchFunction;
  sessionInvocationSigner?: SessionInvocationSigner;
  /** Set once the node's `/info` lists the issued-query feature; owned by the manager. */
  state: { issuedQuerySupported: boolean };
}

/** The node's plain-text refusal reason, without control characters and bounded in length. */
async function refusalText(response: FetchResponse): Promise<string> {
  const text = await response.text();
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
}

/**
 * Maps a non-2xx answer to an issued-delegation query or proofless revocation.
 * The node refuses with a plain-text 401 or 403, answers 400 for a cursor it will not
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
  if (response.status === 401 || response.status === 403) {
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
      "This delegation chain is too long for the node to check right now; try again later",
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
 * Whether the node advertises `delegation-issued-query-v1` in `GET /info`.
 * A positive answer is remembered; an absent flag is read again next time.
 */
async function nodeListsIssued(ctx: IssuedContext): Promise<Result<boolean>> {
  if (ctx.state.issuedQuerySupported) return { ok: true, data: true };
  const response = await ctx.fetchFn(`${ctx.host}/info`);
  if (!response.ok) {
    return {
      ok: false,
      error: createError(
        DelegationErrorCodes.NETWORK_ERROR,
        `Couldn't read the node's info: ${response.status}`,
        undefined,
        { status: response.status },
      ),
    };
  }
  const info = (await response.json()) as { features?: unknown };
  ctx.state.issuedQuerySupported =
    Array.isArray(info.features) && info.features.includes(ISSUED_QUERY_FEATURE);
  return { ok: true, data: ctx.state.issuedQuerySupported };
}

/**
 * Lists the delegations this session's own key issued: one invocation signed
 * by that key with the single capability `tinycloud.delegation/list` on
 * `<key DID>/delegation` and no proof. Pages are ordered by delegation CID,
 * not by time, and may be short; only a missing `nextCursor` ends the list.
 */
export async function queryIssued(
  ctx: IssuedContext,
  options: AccountDelegationQueryOptions,
): Promise<Result<AccountDelegationPage>> {
  const signer = ctx.sessionInvocationSigner;
  if (!signer) {
    return {
      ok: false,
      error: createError(
        DelegationErrorCodes.NOT_INITIALIZED,
        "Listing issued delegations needs a session key signer",
      ),
    };
  }
  try {
    const supported = await nodeListsIssued(ctx);
    if (!supported.ok) return supported;
    if (!supported.data) {
      return {
        ok: false,
        error: createError(
          DelegationErrorCodes.UNSUPPORTED_OPERATION,
          "This node doesn't support listing issued delegations yet",
          undefined,
          { feature: ISSUED_QUERY_FEATURE },
        ),
      };
    }
    const authorization = await signer.sign({
      [`${signer.did()}/delegation`]: { [DelegationAction.LIST]: [{}] },
    });
    const response = await ctx.fetchFn(`${ctx.host}/delegation/query`, {
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
 * in CID order (each carries `issuedAt`). `query` is the manager's public
 * `query`, so every page goes through its option validation.
 */
export async function queryAllIssued(
  query: (options: AccountDelegationQueryOptions) => Promise<Result<AccountDelegationPage>>,
  options: Pick<AccountDelegationQueryOptions, "status" | "space"> & {
    pageSize?: number;
    maxItems?: number;
    untilCid?: string;
  },
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
    const page = await query({
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
            "The node returned the same page cursor twice while listing issued delegations",
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
 * `tinycloud.delegation/revoke`. Revoking a delegation that is already revoked
 * succeeds. A refusal (the key is not the delegator) carries the node's
 * message; 503 means the chain is too deep right now, retry later.
 */
export async function revokeIssued(
  ctx: IssuedContext,
  cid: string,
): Promise<Result<DelegationRevocationReceipt>> {
  if (!cid) {
    return {
      ok: false,
      error: createError(DelegationErrorCodes.INVALID_INPUT, "cid is required"),
    };
  }
  const signer = ctx.sessionInvocationSigner;
  if (!signer) {
    return {
      ok: false,
      error: createError(
        DelegationErrorCodes.NOT_INITIALIZED,
        "Revoking an issued delegation needs a session key signer",
      ),
    };
  }
  try {
    const authorization = await signer.sign({
      [`urn:cid:${cid}`]: { [DelegationAction.REVOKE]: [{}] },
    });
    const response = await ctx.fetchFn(`${ctx.host}/revoke`, {
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
