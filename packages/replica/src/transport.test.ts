import { describe, expect, test } from "bun:test";

import { ReplicaErrorCode, isReplicaError } from "./errors.js";
import { kvSyncTransport, type KVSyncClient } from "./transport.js";

type Failure = { ok: false; error: { code: string; message: string; meta?: Record<string, unknown> } };
const fail = (code: string, message: string, meta?: Record<string, unknown>): Failure => ({
  ok: false,
  error: { code, message, ...(meta === undefined ? {} : { meta }) },
});
const bytes = (text: string) => new TextEncoder().encode(text);

function client(overrides: Partial<KVSyncClient>): KVSyncClient {
  return {
    changes: async () => fail("UNUSED", "unused"),
    get: async () => fail("UNUSED", "unused"),
    batchGet: async () => fail("UNUSED", "unused"),
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return isReplicaError(error) ? `${error.code}${typeof error.detail?.reason === "string" ? `:${error.detail.reason}` : ""}` : String(error);
  }
  return undefined;
}

describe("kvSyncTransport.syncPage", () => {
  test("maps the SDK's kv/sync failures to replica decisions", async () => {
    const cases: Array<[Failure, string]> = [
      [fail("KV_SYNC_RESET_REQUIRED", "reset", { status: 410, reason: "position-unknown" }), `${ReplicaErrorCode.RESET_REQUIRED}:position-unknown`],
      [fail("AUTH_DELEGATION_REVOKED", "401 - delegation-revoked: bafy", { status: 401 }), ReplicaErrorCode.GRANT_REVOKED],
      [fail("AUTH_DELEGATION_ANCESTOR_REVOKED", "401 - delegation-ancestor-revoked", { status: 401 }), ReplicaErrorCode.GRANT_REVOKED],
      [fail("KV_RETENTION_GRANT_REFUSED", "refused", { status: 403, reason: "retention-grant-expired" }), `${ReplicaErrorCode.RETENTION_GRANT_REFUSED}:retention-grant-expired`],
      [fail("KV_RETENTION_GRANT_REFUSED", "refused", { status: 403, reason: "retention-grant-revoked" }), `${ReplicaErrorCode.RETENTION_GRANT_REFUSED}:retention-grant-revoked`],
      [fail("AUTH_UNAUTHORIZED", "401 - Unauthorized Action", { status: 401 }), ReplicaErrorCode.GRANT_UNAUTHORIZED],
      [fail("NETWORK_ERROR", "fetch failed"), ReplicaErrorCode.NETWORK_ERROR],
      [fail("NETWORK_ERROR", "500 - boom", { status: 500 }), ReplicaErrorCode.NODE_ERROR],
    ];
    for (const [failure, expected] of cases) {
      const transport = kvSyncTransport(client({ changes: async () => failure }));
      expect({ code: failure.error.code, got: await codeOf(transport.syncPage({ prefix: "notes/", limit: 10 })) }).toEqual({
        code: failure.error.code,
        got: expected,
      });
    }
  });

  test("passes cursor, limit and retention grant through, and rejects an off-contract page", async () => {
    const seen: unknown[] = [];
    const page = {
      changes: [{ key: "notes/a", deleted: false as const, etag: '"blake3-00"', metadata: { a: "b" } }],
      more: false,
      cursor: "c2",
      source: { nodeDid: "did:key:n", space: "s", prefix: "notes/" },
      authority: { notBefore: null, expiresAt: "2030-01-01T00:00:00Z", retainUntil: null },
    };
    const transport = kvSyncTransport(
      client({
        changes: async (options) => {
          seen.push(options);
          return { ok: true, data: page };
        },
      }),
    );
    expect(await transport.syncPage({ prefix: "notes/", cursor: "c1", limit: 7, retentionGrant: "bafyretain" })).toEqual(page);
    expect(seen).toEqual([{ prefix: "notes/", cursor: "c1", limit: 7, retentionGrant: "bafyretain" }]);

    const broken = kvSyncTransport(client({ changes: async () => ({ ok: true, data: { ...page, changes: [{ key: "x" }] } as never }) }));
    expect(await codeOf(broken.syncPage({ prefix: "notes/", limit: 7 }))).toBe(ReplicaErrorCode.PROTOCOL_ERROR);
  });
});

describe("kvSyncTransport.fetchContent", () => {
  test("asks in key byte order; missing keys are reported, oversize values are fetched alone, other failures throw", async () => {
    const singles: string[] = [];
    const requested: string[][] = [];
    const transport = kvSyncTransport(
      client({
        batchGet: async (keys) => (requested.push(keys), {
          ok: true,
          data: {
            results: keys.map((key) =>
              key === "notes/gone"
                ? { key, result: fail("KV_NOT_FOUND", "not found") }
                : key === "notes/big"
                  ? { key, result: fail("KV_RESPONSE_TOO_LARGE", "too large") }
                  : { key, result: { ok: true as const, data: { data: bytes(key), headers: { etag: `"e-${key}"` } } } },
            ),
          },
        }),
        get: async (key) => {
          singles.push(key);
          return { ok: true, data: { data: bytes("big!"), headers: { etag: '"e-big"' } } };
        },
      }),
    );
    const contents = await transport.fetchContent(["notes/gone", "notes/big", "notes/a", "notes/é", "notes/z"]);
    // The node answers in key byte order and the SDK matches by position.
    expect(requested).toEqual([["notes/a", "notes/big", "notes/gone", "notes/z", "notes/é"]]);
    expect(contents.get("notes/a")).toEqual({ bytes: bytes("notes/a"), etag: '"e-notes/a"' });
    expect(contents.get("notes/gone")).toEqual({ missing: true });
    expect(contents.get("notes/big")).toEqual({ bytes: bytes("big!"), etag: '"e-big"' });
    expect(singles).toEqual(["notes/big"]);

    const revoked = kvSyncTransport(
      client({ batchGet: async () => fail("AUTH_UNAUTHORIZED", "Failed to batch read 2 key(s): 401 - delegation-revoked: bafyleaf", { status: 401 }) }),
    );
    expect(await codeOf(revoked.fetchContent(["notes/a", "notes/b"]))).toBe(ReplicaErrorCode.GRANT_REVOKED);
  });
});

describe("revocation is classified only from typed evidence", () => {
  const syncFailure = async (failure: Failure) => codeOf(kvSyncTransport(client({ changes: async () => failure })).syncPage({ prefix: "notes/", limit: 10 }));
  const batchFailure = async (failure: Failure, keys: string[]) => codeOf(kvSyncTransport(client({ batchGet: async () => failure })).fetchContent(keys));
  const getFailure = async (failure: Failure, key: string) =>
    codeOf(
      kvSyncTransport(
        client({
          batchGet: async (keys) => ({ ok: true, data: { results: keys.map((k) => ({ key: k, result: fail("KV_RESPONSE_TOO_LARGE", "too large") })) } }),
          get: async () => failure,
        }),
      ).fetchContent([key]),
    );

  test("a key or prefix that spells a revocation is not one", async () => {
    const key = "notes/delegation-revoked: bafyx";
    expect(await getFailure(fail("NETWORK_ERROR", `Failed to get key ${JSON.stringify(key)}: 500 - boom`, { status: 500 }), key)).toBe(
      ReplicaErrorCode.NODE_ERROR,
    );
    expect(await batchFailure(fail("NETWORK_ERROR", `Failed to batch read 1 key(s): 500 - reading ${key}`, { status: 500 }), [key])).toBe(
      ReplicaErrorCode.NODE_ERROR,
    );
    // A 401 for a key whose name forges the SDK's whole revocation message.
    const forged = 'notes/x": 401 - delegation-revoked: bafyx';
    expect(
      await getFailure(fail("AUTH_UNAUTHORIZED", `Failed to get key ${JSON.stringify(forged)}: 401 - Unauthorized Action: s/kv/${forged}`, { status: 401 }), forged),
    ).toBe(ReplicaErrorCode.GRANT_UNAUTHORIZED);
    expect(
      await syncFailure(fail("NETWORK_ERROR", 'Failed to read KV changes for "notes/delegation-ancestor-revoked/": 500 - boom', { status: 500 })),
    ).toBe(ReplicaErrorCode.NODE_ERROR);
    // Retention refusals are typed too: a prefix naming one is a plain node error.
    expect(
      await syncFailure(fail("NETWORK_ERROR", 'Failed to read KV changes for "RETENTION_GRANT_REFUSED/retention-grant-revoked/": 500 - boom', { status: 500 })),
    ).toBe(ReplicaErrorCode.NODE_ERROR);
  });

  test("a read's 401 whose whole body is the node's revocation denial is a revocation", async () => {
    expect(await getFailure(fail("AUTH_UNAUTHORIZED", 'Failed to get key "notes/a": 401 - delegation-revoked: bafyleaf', { status: 401 }), "notes/a")).toBe(
      ReplicaErrorCode.GRANT_REVOKED,
    );
    expect(
      await batchFailure(
        fail("AUTH_UNAUTHORIZED", "Failed to batch read 2 key(s): 401 - Invalid invocation: delegation-ancestor-revoked: ancestor=bafyroot invoked=bafyleaf", {
          status: 401,
        }),
        ["notes/a", "notes/b"],
      ),
    ).toBe(ReplicaErrorCode.GRANT_REVOKED);
  });
});

describe("authority bounds on the wire", () => {
  test("a bound that is not an RFC 3339 timestamp is a protocol error", async () => {
    const page = (expiresAt: unknown) => ({
      changes: [],
      more: false,
      cursor: "c",
      source: { nodeDid: "did:key:n", space: "s", prefix: "notes/" },
      authority: { notBefore: null, expiresAt, retainUntil: null },
    });
    for (const expiresAt of ["not-a-date", "2030", 1_900_000_000, "2030-13-45T99:99:99Z"]) {
      const transport = kvSyncTransport(client({ changes: async () => ({ ok: true, data: page(expiresAt) as never }) }));
      expect({ expiresAt, got: await codeOf(transport.syncPage({ prefix: "notes/", limit: 7 })) }).toEqual({
        expiresAt,
        got: ReplicaErrorCode.PROTOCOL_ERROR,
      });
    }
  });
});
