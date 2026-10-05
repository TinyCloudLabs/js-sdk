import { describe, expect, test } from "bun:test";

import { SPACE, device, deviceGrant, keyPair, owner, signUcan } from "../test/fixtures.js";
import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import { assertGrantInstallable, grantCovers, parseUcanGrant, ucanCid } from "./grant.js";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ReplicaError ? error.code : String(error);
  }
  return undefined;
}

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
  test("accepts a device grant covering sync and get on the prefix", () => {
    expect(codeOf(() => assertGrantInstallable(deviceGrant(), install))).toBeUndefined();
    expect(codeOf(() => assertGrantInstallable(deviceGrant({ prefix: "notes" }), install))).toBeUndefined();
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
