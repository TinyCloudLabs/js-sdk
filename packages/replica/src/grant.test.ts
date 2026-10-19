import { describe, expect, test } from "bun:test";

import { SPACE, device, deviceGrant, keyPair, owner, signUcan } from "../test/fixtures.js";
import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import { assertGrantInstallable, grantCovers, grantUnconstrained, parseUcanGrant, syncGrantSpaces, ucanCid } from "./grant.js";
import { assertFolderPrefix, kvPrefixCovers, requiresSecretsOptIn } from "./scope.js";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ReplicaError ? error.code : String(error);
  }
  return undefined;
}

describe("folder prefixes", () => {
  test("accepts whole space and slash-terminated folders, rejects empty and malformed paths", () => {
    for (const prefix of ["/", "notes/", "notes/private/"]) expect(() => assertFolderPrefix(prefix)).not.toThrow();
    for (const prefix of ["", "notes", "notes//", "/notes/"]) expect(() => assertFolderPrefix(prefix)).toThrow(ReplicaError);
  });

  test("whole-space selection covers every key and requires the secrets opt-in", () => {
    expect(kvPrefixCovers("/", "notes/a")).toBe(true);
    expect(kvPrefixCovers("notes/", "notes/a")).toBe(true);
    expect(kvPrefixCovers("notes/", "notes-x")).toBe(false);
    expect(requiresSecretsOptIn("space", "/")).toBe(true);
  });
});

const install = { deviceDid: device.did, space: SPACE, prefix: "notes/", now: Date.now() };

describe("parseUcanGrant", () => {
  test("reads audience, window, attenuation and proofs from the signed payload", () => {
    const jwt = signUcan(owner, {
      aud: device.did,
      nbf: 100,
      exp: 4_000_000_000,
      att: { [`${SPACE}/kv/notes/`]: { "tinycloud.kv/sync": [{}], "tinycloud.kv/get": [{}] } },
      prf: ["bafyparent"],
    });
    const grant = parseUcanGrant(`Bearer ${jwt}`);
    expect(grant).toMatchObject({ issuer: owner.did, audience: device.did, notBefore: 100, expiresAt: 4_000_000_000, prf: ["bafyparent"], jwt });
    expect(grant.cid).toBe(ucanCid(jwt));
    expect(grant.cid).toMatch(/^bafkr4i[a-z2-7]{52}$/);
  });

  test("a payload edited after signing fails verification", () => {
    const [head, , sig] = deviceGrant().jwt.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: owner.did, aud: keyPair().did, exp: 4_000_000_000, att: {} })).toString("base64url");
    expect(codeOf(() => parseUcanGrant(`${head}.${forged}.${sig}`))).toBe(ReplicaErrorCode.GRANT_INVALID);
  });

  test("a signature by someone other than the issuer fails verification", () => {
    const imposter = keyPair();
    const jwt = signUcan({ secret: imposter.secret, did: owner.did }, { aud: device.did, att: {} });
    expect(codeOf(() => parseUcanGrant(jwt))).toBe(ReplicaErrorCode.GRANT_INVALID);
  });

  test("SIWE/CACAO and non-Ed25519 grants are unsupported", () => {
    expect(codeOf(() => parseUcanGrant("omFoo2V4YW1wbGU"))).toBe(ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED);
    const es256k = signUcan(owner, { aud: device.did, att: {} }, { alg: "ES256K", typ: "JWT" });
    expect(codeOf(() => parseUcanGrant(es256k))).toBe(ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED);
  });
});

describe("assertGrantInstallable", () => {
  test("requires authority to cover the complete selected namespace", () => {
    expect(codeOf(() => assertGrantInstallable(deviceGrant(), install))).toBeUndefined();
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ prefix: "notes" }), install))).toBe(ReplicaErrorCode.GRANT_NOT_COVERING);
    expect(codeOf(() => assertGrantInstallable(deviceGrant(), { ...install, prefix: "notes" }))).toBe(ReplicaErrorCode.GRANT_NOT_COVERING);
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ prefix: "" }), { ...install, prefix: "notes" }))).toBeUndefined();
  });

  test("rejects another device's grant", () => {
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ aud: keyPair().did }), install))).toBe(
      ReplicaErrorCode.GRANT_AUDIENCE_MISMATCH,
    );
  });

  test("rejects a grant without sync, without get, or on a different prefix", () => {
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ actions: ["get", "list"] }), install))).toBe(
      ReplicaErrorCode.GRANT_NOT_COVERING,
    );
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ actions: ["sync"] }), install))).toBe(
      ReplicaErrorCode.GRANT_NOT_COVERING,
    );
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ prefix: "notes-secret/" }), install))).toBe(
      ReplicaErrorCode.GRANT_NOT_COVERING,
    );
    expect(codeOf(() => assertGrantInstallable(deviceGrant(), { ...install, prefix: "notes" }))).toBe(
      ReplicaErrorCode.GRANT_NOT_COVERING,
    );
  });

  test("root grants cover the whole space; exact-key grants do not", () => {
    const root = deviceGrant({ prefix: "/" });
    expect(grantCovers(root, SPACE, "/", "tinycloud.kv/get")).toBe(true);
    expect(grantCovers(root, SPACE, "notes/", "tinycloud.kv/sync")).toBe(true);
    const exact = deviceGrant({ prefix: "notes" });
    expect(grantCovers(exact, SPACE, "notes/", "tinycloud.kv/get")).toBe(false);
    const slashResource = parseUcanGrant(signUcan(owner, {
      aud: device.did,
      att: { [`${SPACE}/kv/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/sync": [{}] } },
    }));
    expect(grantCovers(slashResource, SPACE, "/", "tinycloud.kv/get")).toBe(true);
    expect(syncGrantSpaces(root)).toEqual([SPACE]);
    expect(syncGrantSpaces(slashResource)).toEqual([SPACE]);
  });
  test("a wildcard never implies tinycloud.kv/sync", () => {
    expect(grantCovers(deviceGrant({ actions: ["*"] }), SPACE, "notes/", "tinycloud.kv/sync")).toBe(false);
    expect(grantCovers(deviceGrant({ actions: ["*"] }), SPACE, "notes/", "tinycloud.kv/get")).toBe(true);
  });

  test("rejects a grant outside its signed window", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ exp: now - 1 }), install))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ nbf: now + 600 }), install))).toBe(ReplicaErrorCode.GRANT_NOT_YET_VALID);
  });
});

describe("unconstrained grants", () => {
  const grantWith = (att: Record<string, Record<string, unknown>>) =>
    parseUcanGrant(signUcan(owner, { aud: device.did, exp: Math.floor(Date.now() / 1000) + 3600, att, prf: ["bafyparent"] }));
  const notes = `${SPACE}/kv/notes/`;

  test("get and sync with no caveats, or one empty branch, are unconstrained", () => {
    expect(grantUnconstrained(deviceGrant(), SPACE, "notes/")).toBe(true);
    expect(grantUnconstrained(grantWith({ [notes]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": [] } }), SPACE, "notes/")).toBe(true);
    expect(grantUnconstrained(grantWith({ [`${SPACE}/kv`]: { "tinycloud.kv/*": [{}], "tinycloud.kv/sync": [{}] } }), SPACE, "notes/")).toBe(true);
  });

  test("a caveat on get or on sync makes the grant constrained", () => {
    const caveat = [{ maxBytes: 10 }];
    expect(grantUnconstrained(grantWith({ [notes]: { "tinycloud.kv/get": caveat, "tinycloud.kv/sync": [{}] } }), SPACE, "notes/")).toBe(false);
    expect(grantUnconstrained(grantWith({ [notes]: { "tinycloud.kv/get": [{}], "tinycloud.kv/sync": caveat } }), SPACE, "notes/")).toBe(false);
    expect(grantUnconstrained(grantWith({ [notes]: { "tinycloud.kv/get": [{}, { a: 1 }], "tinycloud.kv/sync": [{}] } }), SPACE, "notes/")).toBe(false);
    expect(grantUnconstrained(grantWith({ [notes]: { "tinycloud.kv/get": "weird", "tinycloud.kv/sync": [{}] } }), SPACE, "notes/")).toBe(false);
  });

  test("an unconstrained branch elsewhere still covers a caveated one", () => {
    expect(
      grantUnconstrained(
        grantWith({ [notes]: { "tinycloud.kv/get": [{ a: 1 }], "tinycloud.kv/sync": [{}] }, [`${SPACE}/kv`]: { "tinycloud.kv/get": [{}] } }),
        SPACE,
        "notes/",
      ),
    ).toBe(true);
  });

  test("missing sync is not unconstrained coverage", () => {
    expect(grantUnconstrained(grantWith({ [notes]: { "tinycloud.kv/*": [{}] } }), SPACE, "notes/")).toBe(false);
  });
});
