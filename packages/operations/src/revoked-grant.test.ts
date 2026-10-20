import { describe, expect, test } from "bun:test";

import { authorizationFailure } from "./kv-failure.js";
import { isRevokedGrantRefusal, REVOKED_GRANT_MESSAGE } from "./revoked-grant.js";

const CID = "bafkr4iag2ij7qgnvseczoggdnkwr4w3ygcpn4mgd3gbsitrplbtfcx3z3u";
const refusal = (body: string, status = 401) => ({
  code: "KV_ERROR", message: `Failed to list keys: ${status} - ${body}`, meta: { status },
});

describe("revoked grant refusal", () => {
  test.each(["delegation-revoked", "delegation-ancestor-revoked"])("the node's %s 401 body is recognised", (reason) => {
    expect(isRevokedGrantRefusal(refusal(`${reason}: ${CID}`))).toBe(true);
  });

  test("an SDK error that wraps the node's body as its cause is recognised", () => {
    expect(isRevokedGrantRefusal({ code: "NETWORK_ERROR", meta: { status: 401 }, message: "Failed", cause: new Error(`401 - delegation-revoked: ${CID}`) })).toBe(true);
  });

  test("any other 401, and a revoked-looking body on another status, keep their meaning", () => {
    expect(isRevokedGrantRefusal(refusal("expired session"))).toBe(false);
    expect(isRevokedGrantRefusal(refusal("delegation-expired: x"))).toBe(false);
    expect(isRevokedGrantRefusal(refusal(`delegation-revoked: ${CID}`, 403))).toBe(false);
    expect(isRevokedGrantRefusal(refusal(`delegation-revoked: ${CID}`, 500))).toBe(false);
    expect(isRevokedGrantRefusal(new Error("401 - delegation-revoked"))).toBe(false);
    expect(isRevokedGrantRefusal(undefined)).toBe(false);
  });

  test("the operation error says the grant was revoked, still as AUTH_REQUIRED, and never echoes the node body", () => {
    const outcome = authorizationFailure(refusal(`delegation-revoked: ${CID}`), "list KV keys");
    expect(outcome).toMatchObject({ status: "error", error: { code: "AUTH_REQUIRED", message: REVOKED_GRANT_MESSAGE } });
    expect(JSON.stringify(outcome)).not.toContain(CID);
    expect(REVOKED_GRANT_MESSAGE).toMatch(/revoked.*Ask the owner for a new grant/);
  });

  test("an ordinary 401 still asks for authentication, a 403 still denies permission", () => {
    expect(authorizationFailure(refusal("expired session"), "list KV keys")).toMatchObject({ error: { code: "AUTH_REQUIRED", message: "Authentication is required to list KV keys." } });
    expect(authorizationFailure(refusal("nope", 403), "list KV keys")).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
  });
});
