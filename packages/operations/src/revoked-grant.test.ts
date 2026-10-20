import { describe, expect, test } from "bun:test";

import { authorizationFailure } from "./kv-failure.js";
import { isRevokedGrantRefusal, REVOKED_GRANT_MESSAGE } from "./revoked-grant.js";

const CID = "bafkr4iag2ij7qgnvseczoggdnkwr4w3ygcpn4mgd3gbsitrplbtfcx3z3u";
const refusal = (body: string, status = 401) => ({
  code: "KV_ERROR", message: `Failed to list keys: ${status} - ${body}`, meta: { status },
});

describe("revoked grant refusal", () => {
  test.each([
    `delegation-revoked: ${CID}`,
    `delegation-ancestor-revoked: ancestor=${CID} invoked=${CID}`,
  ])("the node's 401 body %s is recognised", (body) => {
    expect(isRevokedGrantRefusal(refusal(body))).toBe(true);
  });

  test("the older node's `Invalid invocation:` prefix and the ancestor body's two CIDs are recognised", () => {
    expect(isRevokedGrantRefusal(refusal(`Invalid invocation: delegation-revoked: ${CID}`))).toBe(true);
    expect(isRevokedGrantRefusal(refusal(`delegation-ancestor-revoked: ancestor=${CID} invoked=${CID}`))).toBe(true);
    expect(isRevokedGrantRefusal(refusal(`Invalid invocation: delegation-ancestor-revoked: ancestor=${CID} invoked=${CID}`))).toBe(true);
  });

  test("the KV service's typed revoked codes are recognised on a 401", () => {
    for (const code of ["AUTH_DELEGATION_REVOKED", "AUTH_DELEGATION_ANCESTOR_REVOKED"]) {
      expect(isRevokedGrantRefusal({ code, message: "refused", meta: { status: 401 } })).toBe(true);
      expect(isRevokedGrantRefusal({ code, message: "refused", meta: { status: 403 } })).toBe(false);
    }
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
    // Any other 401 that merely mentions "revoked", a key that is named like the node's body, or text after the body.
    for (const body of [
      "the key was revoked by the owner",
      "revoked",
      "session revoked: please sign in",
      "delegation-revoked",
      "delegation-revoked: ",
      "delegation-revoked: bafy and then some other text",
      "delegation-revoked-by-owner: bafy",
      "delegation-ancestor-revoked: ancestor=bafy",
      "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:default/kv/notes/delegation-revoked/ / tinycloud.kv/get",
      "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:default/kv/delegation-revoked: bafy / tinycloud.kv/get",
      "Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:default/kv/notes/delegation-revoked: bafyx",
    ]) expect(isRevokedGrantRefusal(refusal(body))).toBe(false);
    expect(isRevokedGrantRefusal({ code: "KV_ERROR", message: "Failed 401 - revoked", meta: { status: 401 } })).toBe(false);
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
