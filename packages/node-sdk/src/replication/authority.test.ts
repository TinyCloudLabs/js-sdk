/**
 * Unit tests for the TC-858 replication authority (plan v3 §4, §10.1):
 * config validation, the sign-in augmentation gates, UCAN `att` reading,
 * and `createReplicationAuthority` over host fakes. No WASM, no network.
 */

import { describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { ucanCid } from "@tinycloud/replica";

import type { PermissionEntry, TinyCloudSession } from "@tinycloud/sdk-core";

import {
  assertRenewalParent,
  assertValidReplicationConfig,
  augmentSignInEntriesWithReplication,
  createReplicationAuthority,
  hasUnrestrictedGetCoverage,
  ucanAttCovers,
  ucanAttUnconstrainedFor,
  type ReplicationAuthorityHost,
} from "./authority";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const SHORT_SPACE = "default";

function kvEntry(over: Partial<PermissionEntry> = {}): PermissionEntry {
  return {
    service: "tinycloud.kv",
    space: SPACE,
    path: "",
    actions: ["tinycloud.kv/get"],
    ...over,
  };
}

describe("assertValidReplicationConfig (§3.1)", () => {
  const storage = {};

  test("undefined or disabled config is a no-op", () => {
    expect(() => assertValidReplicationConfig(undefined)).not.toThrow();
    expect(() => assertValidReplicationConfig({ enabled: false, prefixes: [] })).not.toThrow();
  });

  test("enabled without storage throws", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, prefixes: ["notes/"] }),
    ).toThrow(TypeError);
  });

  test("empty, bare, malformed, and leading-slash prefixes are invalid; root and folders pass", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: [] }),
    ).toThrow(TypeError);
    for (const prefix of ["", "notes", "notes//", "/notes/"]) {
      expect(() =>
        assertValidReplicationConfig({ enabled: true, storage, prefixes: [prefix] }),
      ).toThrow(TypeError);
    }
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["/"] }),
    ).toThrow(/allowSecrets/);
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["/"], allowSecrets: true }),
    ).not.toThrow();
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/"] }),
    ).not.toThrow();
  });

  test("overlapping folder prefixes throw; sibling prefixes pass", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/", "notes/todo/"] }),
    ).toThrow(/overlap/);
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/", "note-s/"] }),
    ).not.toThrow();
  });

  test("a vault prefix requires allowSecrets", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["vault/keys/"] }),
    ).toThrow(/allowSecrets/);
    expect(() =>
      assertValidReplicationConfig({
        enabled: true,
        storage,
        prefixes: ["vault/keys/"],
        allowSecrets: true,
      }),
    ).not.toThrow();
  });
});

describe("hasUnrestrictedGetCoverage (§4.1 gate)", () => {
  test("a covering uncaveated get passes on the full space id and the short name", () => {
    const entries = [kvEntry({ path: "notes/" })];
    expect(hasUnrestrictedGetCoverage(entries, SPACE, "notes/a")).toBe(true);
    expect(hasUnrestrictedGetCoverage([kvEntry({ space: SHORT_SPACE, path: "notes/" })], SPACE, "notes/a")).toBe(true);
  });

  test("a caveated covering get fails the gate", () => {
    const entries = [kvEntry({ path: "notes/", caveats: [{ maxValueSize: 1 }] })];
    expect(hasUnrestrictedGetCoverage(entries, SPACE, "notes/a")).toBe(false);
  });

  test("a non-covering path or a non-get action fails", () => {
    expect(
      hasUnrestrictedGetCoverage([kvEntry({ path: "other/" })], SPACE, "notes/a"),
    ).toBe(false);
    expect(
      hasUnrestrictedGetCoverage([kvEntry({ actions: ["tinycloud.kv/put"] })], SPACE, "notes/"),
    ).toBe(false);
  });

  test("kv/* action and root path cover; unrelated service does not", () => {
    expect(
      hasUnrestrictedGetCoverage([kvEntry({ path: "", actions: ["tinycloud.kv/*"] })], SPACE, "notes/"),
    ).toBe(true);
    expect(
      hasUnrestrictedGetCoverage(
        [{ service: "tinycloud.sql", space: SPACE, path: "", actions: ["tinycloud.kv/get"] }],
        SPACE,
        "notes/",
      ),
    ).toBe(false);
  });

  test("sdk-core containment covers folder prefixes with one get grant", () => {
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "notes" })], SPACE, "notes/")).toBe(false);
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "notes/" })], SPACE, "notes/")).toBe(true);
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "" })], SPACE, "notes/")).toBe(true);
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "parent/" })], SPACE, "parent/notes/")).toBe(true);
    expect(augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "notes" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["notes/"] },
    })).toEqual([]);
  });
});

describe("augmentSignInEntriesWithReplication (§4.1)", () => {
  const replication = { prefixes: ["notes/", "other/"] };

  test("narrow get coverage keeps one least-privilege entry per configured prefix", () => {
    const out = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "notes/" }), kvEntry({ path: "other/" })],
      primarySpaceId: SPACE,
      replication,
    });
    expect(out).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "other/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
  });

  test("whole-space owner get coverage adds sync once at the root", () => {
    const out = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication,
    });
    expect(out).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    expect(augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["notes/", "/"], allowSecrets: true },
    }).map((entry) => entry.path)).toEqual([""]);
  });

  test("prefix sync scope keeps whole-space owner sync on declared prefixes", () => {
    const out = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["notes/", "other/"], syncScope: "prefixes" },
    });
    expect(out).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "other/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    expect(out.some((entry) => entry.path === "" && entry.actions.includes("tinycloud.kv/sync"))).toBe(false);
    expect(() => assertValidReplicationConfig({
      enabled: true,
      storage: {},
      prefixes: ["notes/"],
      syncScope: "root" as "prefixes",
    })).toThrow(/replication\.syncScope/);
  });


  test("a caveated covering get produces no entry", () => {
    const out = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "", caveats: [{ ifMatch: "x" }] })],
      primarySpaceId: SPACE,
      replication,
    });
    expect(out).toEqual([]);
  });

  test("secrets gate: a vault prefix requires allowSecrets (§10.1)", () => {
    const out = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["vault/keys/", "notes/"] },
    });
    expect(out.map((entry) => entry.path)).toEqual(["notes/"]);
    const opted = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["vault/keys/"], allowSecrets: true },
    });
    expect(opted.map((entry) => entry.path)).toEqual([""]);
  });

  test("undefined replication config yields no entries", () => {
    expect(
      augmentSignInEntriesWithReplication({ entries: [], primarySpaceId: SPACE }),
    ).toEqual([]);
  });
});

describe("ucanAttCovers / ucanAttUnconstrainedFor (§4.2)", () => {
  const resource = `tinycloud://${SPACE}/kv/`;

  test("unconstrained get+sync on a covering resource", () => {
    const att = { [resource]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} } };
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes/")).toBe(true);
    expect(ucanAttUnconstrainedFor({ [`tinycloud://${SPACE}/kv/unrelated/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} } }, SPACE, "notes/")).toBe(false);
  });
  test("canonical root KV resources cover `/` and folders, not unrelated resource boundaries", () => {
    const abilities = { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} };
    const bareRoot = { [`${SPACE}/kv`]: abilities };
    const slashRoot = { [`tinycloud://${SPACE}/kv/`]: abilities };
    expect(ucanAttUnconstrainedFor(bareRoot, SPACE, "/")).toBe(true);
    expect(ucanAttUnconstrainedFor(slashRoot, SPACE, "/")).toBe(true);
    expect(ucanAttCovers(bareRoot, SPACE, "notes/", "tinycloud.kv/get")).toBe(true);
    expect(ucanAttCovers({ [`${SPACE}/kv-extra`]: abilities }, SPACE, "/", "tinycloud.kv/get")).toBe(false);
    expect(ucanAttCovers({ [`tinycloud://${SPACE}-other/kv`]: abilities }, SPACE, "/", "tinycloud.kv/get")).toBe(false);
  });
  test("an exact-key get cannot cover a folder; a slash grant covers descendants", () => {
    const exact = { [`tinycloud://${SPACE}/kv/notes`]: { "tinycloud.kv/get": {} } };
    expect(ucanAttCovers(exact, SPACE, "notes/", "tinycloud.kv/get")).toBe(false);
    const slash = { [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {} } };
    expect(ucanAttCovers(slash, SPACE, "notes/", "tinycloud.kv/get")).toBe(true);
    expect(ucanAttCovers(slash, SPACE, "notes/a/", "tinycloud.kv/get")).toBe(true);
    expect(ucanAttCovers(slash, SPACE, "notes/a/b/", "tinycloud.kv/get")).toBe(true);
  });


  test("caveated branch: coverage under ignoreCaveats, refusal otherwise", () => {
    const att = {
      [resource]: {
        "tinycloud.kv/get": { maxValueSize: [1000] },
        "tinycloud.kv/sync": {},
      },
    };
    expect(ucanAttCovers(att, SPACE, "notes/", "tinycloud.kv/get", { ignoreCaveats: true })).toBe(true);
    expect(ucanAttCovers(att, SPACE, "notes/", "tinycloud.kv/get")).toBe(false);
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes/")).toBe(false);
  });

  test("empty caveat arrays count as unconstrained", () => {
    const att = {
      [resource]: {
        "tinycloud.kv/get": {},
        "tinycloud.kv/sync": [{}],
      },
    };
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createReplicationAuthority over host fakes
// ---------------------------------------------------------------------------

const DEVICE_DID = "did:key:zDevice";

const SESSION_SECRET = new Uint8Array(32).fill(7);
const SESSION_PUBLIC = ed25519.getPublicKey(SESSION_SECRET);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)]! + encoded;
    value /= 58n;
  }
  return encoded;
}
const KEY_MULTIBASE = `z${base58(Uint8Array.from([0xed, 0x01, ...SESSION_PUBLIC]))}`;
const SESSION_DID = `did:key:${KEY_MULTIBASE}#${KEY_MULTIBASE}`;

function fakeSessionUcan(att: Record<string, Record<string, unknown>>, claims: { prf?: string[]; iat?: number; nbf?: number } = {}): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "EdDSA" });
  const payload = b64({
    iss: SESSION_DID.split("#", 1)[0],
    aud: SESSION_DID,
    att,
    prf: claims.prf ?? ["bafyParent"],
    ...(claims.iat === undefined ? {} : { iat: claims.iat }),
    ...(claims.nbf === undefined ? {} : { nbf: claims.nbf }),
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  const signingInput = `${header}.${payload}`;
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(signingInput), SESSION_SECRET)).toString("base64url");
  return `${signingInput}.${signature}`;
}

function fakeSession(over: Partial<TinyCloudSession> = {}): TinyCloudSession {
  const session = {
    address: ADDRESS,
    chainId: 1,
    sessionKey: "default",
    spaceId: SPACE,
    delegationCid: "bafySession",
    delegationHeader: { Authorization: fakeSessionUcan({}) },
    verificationMethod: SESSION_DID,
    jwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(SESSION_PUBLIC).toString("base64url"),
      d: Buffer.from(SESSION_SECRET).toString("base64url"),
    },
    siwe: "siwe",
    signature: "0x",
    ...over,
  };
  return {
    ...session,
    delegationCid: ucanCid(session.delegationHeader.Authorization.replace(/^Bearer\s+/i, "")),
  };
}

function makeHost(over: Partial<ReplicationAuthorityHost> = {}): ReplicationAuthorityHost {
  const session = fakeSession();
  return {
    replicationSession: () => session,
    verifiedConsentAnchor: (bound) => bound.siwe === undefined ? null : { at: 1_000_000, source: "siwe" },
    siweExpiration: () => new Date(Date.now() + 86_400_000),
    planDelegation: mock(() => ({
      path: "runtime" as const,
      parentCid: "bafyParent",
      expiresAt: Date.now() + 3_600_000,
    })),
    mintDelegation: mock(async () => ({
      ucan: "minted-ucan",
      expiresAt: Date.now() + 3_600_000,
    })),
    ...over,
  };
}

describe("owner-backed consent recency", () => {
  test("arbitrary did:key compact leaves cannot establish consent from iat, nbf or empty prf", () => {
    const claims = [
      { prf: [], iat: Math.floor(Date.now() / 1000) },
      { prf: ["bafyOldOwner"], nbf: Math.floor(Date.now() / 1000) },
      { prf: [] },
    ];
    for (const leaf of claims) {
      const session = fakeSession({ delegationHeader: { Authorization: fakeSessionUcan({}, leaf) } });
      const authority = createReplicationAuthority(makeHost({
        replicationSession: () => ({ ...session, siwe: undefined }),
      }));
      expect(authority.consentAnchor?.()).toBeNull();
      expect(authority.canRenew).toBe(false);
    }
  });
  test("a bound owner anchor cannot move to a replacement session or renew its grants", () => {
    let current = fakeSession();
    const authority = createReplicationAuthority(makeHost({
      replicationSession: () => current,
      verifiedConsentAnchor: () => ({ at: 1_000_000, source: "siwe" }),
    }));
    expect(authority.consentAnchor?.()).toEqual({ at: 1_000_000, source: "siwe" });
    expect(authority.canRenew).toBe(true);
    current = fakeSession({ address: "0x0000000000000000000000000000000000000002" });
    expect(authority.consentAnchor?.()).toBeNull();
    expect(authority.canRenew).toBe(false);
  });
  test("a replaced owner session cannot reuse the old authority to plan or mint", async () => {
    let current = fakeSession();
    const mintDelegation = mock(async () => ({ ucan: "unexpected", expiresAt: 2_000_000 }));
    const authority = createReplicationAuthority(makeHost({
      replicationSession: () => current,
      verifiedConsentAnchor: () => ({ at: 1_000_000, source: "siwe" }),
      mintDelegation,
    }));
    current = fakeSession({ address: "0x0000000000000000000000000000000000000002" });
    expect(authority.sessionGrant("notes/")).toEqual({ refused: "SESSION_EXPIRING" });
    expect(authority.plan("notes/")).toEqual({ refused: "SESSION_EXPIRING" });
    await expect(authority.mint(DEVICE_DID, "notes/", new AbortController().signal)).rejects.toThrow(/session|consent/i);
    expect(mintDelegation).not.toHaveBeenCalled();
  });
  test("a full SIWE without independently verified finite expiry cannot mint", async () => {
    const mintDelegation = mock(async () => ({ ucan: "unexpected", expiresAt: 2_000_000 }));
    const authority = createReplicationAuthority(makeHost({
      verifiedConsentAnchor: () => null,
      mintDelegation,
    }));
    await expect(authority.mint(DEVICE_DID, "notes/", new AbortController().signal)).rejects.toThrow(/consent/i);
    expect(mintDelegation).not.toHaveBeenCalled();
  });
  test("a renewal cannot silently switch from a session parent to a runtime parent at mint time", async () => {
    let path: "session" | "runtime" = "session";
    const mintDelegation = mock(async () => ({ ucan: "minted-ucan", expiresAt: Date.now() + 60_000 }));
    const authority = createReplicationAuthority(makeHost({
      verifiedConsentAnchor: () => ({ at: 1_000_000, source: "siwe" }),
      planDelegation: () => ({ path, parentCid: "bafyParent", expiresAt: Date.now() + 60_000 }),
      mintDelegation,
    }));
    expect(authority.plan("notes/")).toMatchObject({ path: "session" });
    path = "runtime";
    await expect(authority.mint(DEVICE_DID, "notes/", new AbortController().signal, { expiryMs: 30_000, renewalOnly: true })).rejects.toThrow(/session parent/i);
    expect(mintDelegation).not.toHaveBeenCalled();
    await authority.mint(DEVICE_DID, "notes/", new AbortController().signal, { expiryMs: 30_000 });
    expect(mintDelegation).toHaveBeenCalledTimes(1);
  });
  test("prepared renewal grants must be signed by the bound session with its exact parent", () => {
    const session = fakeSession();
    expect(() => assertRenewalParent(fakeSessionUcan({}, { prf: [session.delegationCid] }), session)).not.toThrow();
    expect(() => assertRenewalParent(fakeSessionUcan({}, { prf: ["bafyRuntime"] }), session)).toThrow(/session parent/i);
    expect(() => assertRenewalParent(fakeSessionUcan({}, { prf: [session.delegationCid, "bafyRuntime"] }), session)).toThrow(/session parent/i);
    expect(() => assertRenewalParent(fakeSessionUcan({}, { prf: [session.delegationCid] }), fakeSession({ verificationMethod: "did:key:zOther" }))).toThrow(/session parent/i);
  });
  test("first-install storage time is not an independent authority consent anchor", () => {
    const authority = createReplicationAuthority(makeHost({
      verifiedConsentAnchor: () => ({ at: 1_000_000, source: "first_install" }),
    }));
    expect(authority.consentAnchor?.()).toBeNull();
    expect(authority.canRenew).toBe(false);
  });
});

describe("createReplicationAuthority (§4.2-4.3)", () => {
  test("sessionGrant returns the session UCAN when it carries unconstrained get+sync", () => {
    const resource = `tinycloud://${SPACE}/kv/`;
    const session = fakeSession({
      delegationHeader: {
        Authorization: fakeSessionUcan({
          [resource]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
        }),
      },
    });
    const authority = createReplicationAuthority(
      makeHost({ replicationSession: () => session }),
    );
    const result = authority.sessionGrant("notes/");
    if ("refused" in result) throw new Error(`unexpected refusal ${result.refused}`);
    expect(result.device.did).toBe(SESSION_DID);
  });

  test("compact signed coverage can reuse an installed grant without gaining consent or mint authority", async () => {
    const session = fakeSession({
      siwe: undefined,
      signature: undefined,
      delegationHeader: { Authorization: fakeSessionUcan({
        [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
      }) },
    });
    const mintDelegation = mock(async () => ({ ucan: "unexpected", expiresAt: Date.now() + 60_000 }));
    const authority = createReplicationAuthority(makeHost({
      replicationSession: () => session,
      verifiedConsentAnchor: () => null,
      mintDelegation,
    }));
    expect(authority.sessionOnly).toBe(true);
    expect(authority.consentAnchor?.()).toBeNull();
    expect(authority.sessionGrant("notes/")).toEqual({
      ucan: session.delegationHeader.Authorization,
      device: { did: SESSION_DID, jwk: session.jwk },
    });
    expect(authority.plan("notes/")).toEqual({ refused: "NOT_COVERED" });
    await expect(authority.mint(DEVICE_DID, "notes/", new AbortController().signal)).rejects.toThrow(/compact/i);
    expect(mintDelegation).not.toHaveBeenCalled();
  });

  test("compact session coverage still rejects wrong-space, disjoint and caveated grants", () => {
    const notes = `tinycloud://${SPACE}/kv/notes/`;
    for (const [att, refusal] of [
      [{ [`tinycloud://other-space/kv/notes/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} } }, "NOT_COVERED"],
      [{ [notes]: { "tinycloud.kv/get": {} }, [`tinycloud://${SPACE}/kv/other/`]: { "tinycloud.kv/sync": {} } }, "NOT_COVERED"],
      [{ [notes]: { "tinycloud.kv/get": { ifMatch: ["etag"] }, "tinycloud.kv/sync": {} } }, "CAVEATED_AUTHORITY"],
    ] as const) {
      const session = fakeSession({ siwe: undefined, delegationHeader: { Authorization: fakeSessionUcan(att) } });
      const authority = createReplicationAuthority(makeHost({ replicationSession: () => session, verifiedConsentAnchor: () => null }));
      expect(authority.sessionGrant("notes/")).toEqual({ refused: refusal });
    }
  });

  test("unverified full owner session still cannot offer a reusable grant", () => {
    const session = fakeSession({
      delegationHeader: { Authorization: fakeSessionUcan({
        [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
      }) },
    });
    const authority = createReplicationAuthority(makeHost({ replicationSession: () => session, verifiedConsentAnchor: () => null }));
    expect(authority.sessionGrant("notes/")).toEqual({ refused: "NOT_COVERED" });
  });

  test("an exact-key grant cannot cover folders; a trailing-slash grant can", () => {
    const exactSession = fakeSession({
      delegationHeader: {
        Authorization: fakeSessionUcan({
          [`tinycloud://${SPACE}/kv/notes`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
        }),
      },
    });
    const exactAuthority = createReplicationAuthority(makeHost({ replicationSession: () => exactSession }));
    expect(exactAuthority.sessionGrant("notes/")).toEqual({ refused: "NOT_COVERED" });

    const folderSession = fakeSession({
      delegationHeader: {
        Authorization: fakeSessionUcan({
          [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
        }),
      },
    });
    const folderGrant = createReplicationAuthority(makeHost({ replicationSession: () => folderSession })).sessionGrant("notes/");
    expect(folderGrant).toMatchObject({ device: { did: SESSION_DID } });
  });


  test("sessionGrant refuses NOT_COVERED for a non-UCAN header and uncovered prefix", () => {
    const session = fakeSession({ delegationHeader: { Authorization: "Bearer not-a-ucan" } });
    const authority = createReplicationAuthority(
      makeHost({ replicationSession: () => session }),
    );
    expect(authority.sessionGrant("notes/")).toEqual({ refused: "NOT_COVERED" });
    const uncovered = createReplicationAuthority(makeHost());
    expect(uncovered.sessionGrant("notes/")).toEqual({ refused: "NOT_COVERED" });
  });

  test("sessionGrant refuses CAVEATED_AUTHORITY when coverage is caveated only", () => {
    const resource = `tinycloud://${SPACE}/kv/`;
    const session = fakeSession({
      delegationHeader: {
        Authorization: fakeSessionUcan({
          [resource]: {
            "tinycloud.kv/get": { ifMatch: ["x"] },
            "tinycloud.kv/sync": {},
          },
        }),
      },
    });
    const authority = createReplicationAuthority(
      makeHost({ replicationSession: () => session }),
    );
    expect(authority.sessionGrant("notes/")).toEqual({ refused: "CAVEATED_AUTHORITY" });
  });

  test("sessionGrant refuses SESSION_EXPIRING inside the 60s margin", () => {
    const authority = createReplicationAuthority(
      makeHost({ siweExpiration: () => new Date(Date.now() + 30_000) }),
    );
    expect(authority.sessionGrant("notes/")).toEqual({ refused: "SESSION_EXPIRING" });
  });

  test("plan passes one get+sync entry for a folder prefix", () => {
    const planDelegation = mock(() => ({
      path: "runtime" as const,
      parentCid: "bafyA",
      expiresAt: 1_700_000_000_000,
    }));
    const authority = createReplicationAuthority(makeHost({ planDelegation }));
    const plan = authority.plan("notes/");
    expect(plan).toEqual({ path: "runtime", parentCid: "bafyA", expiresAt: 1_700_000_000_000 });
    const entries = planDelegation.mock.calls[0]![0] as PermissionEntry[];
    expect(entries).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    const rootPlanDelegation = mock(() => ({
      path: "runtime" as const,
      parentCid: "bafyRoot",
      expiresAt: 1_700_000_000_000,
    }));
    const rootAuthority = createReplicationAuthority(makeHost({ planDelegation: rootPlanDelegation }));
    expect(rootAuthority.plan("/")).toEqual({ path: "runtime", parentCid: "bafyRoot", expiresAt: 1_700_000_000_000 });
    expect(rootPlanDelegation.mock.calls[0]![0]).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);

    const refused = createReplicationAuthority(
      makeHost({ planDelegation: () => ({ refused: "CAVEATED_AUTHORITY" as const }) }),
    );
    expect(refused.plan("notes/")).toEqual({ refused: "CAVEATED_AUTHORITY" });
  });

  test("mint carries the plan's parentCid and the minted ucan+expiry; a refusal throws typed", async () => {
    const plan = { path: "runtime" as const, parentCid: "bafyB", expiresAt: 1_800_000_000_000 };
    const mintDelegation = mock(async () => ({ ucan: "signed-ucan", expiresAt: plan.expiresAt }));
    const authority = createReplicationAuthority(
      makeHost({ verifiedConsentAnchor: () => ({ at: 1_000_000, source: "siwe" }), planDelegation: () => plan, mintDelegation }),
    );
    const result = await authority.mint(DEVICE_DID, "notes/", new AbortController().signal);
    expect(result).toEqual({ ucan: "signed-ucan", parentCid: "bafyB", expiresAt: plan.expiresAt });
    expect(mintDelegation.mock.calls[0]![0]).toBe(DEVICE_DID);
    expect(mintDelegation.mock.calls[0]![1]).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    await authority.mint(DEVICE_DID, "/", new AbortController().signal);
    expect(mintDelegation.mock.calls[1]![1]).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);

    const refused = createReplicationAuthority(
      makeHost({ verifiedConsentAnchor: () => ({ at: 1_000_000, source: "siwe" }), planDelegation: () => ({ refused: "NOT_COVERED" as const }) }),
    );
    await expect(
      refused.mint(DEVICE_DID, "notes/", new AbortController().signal),
    ).rejects.toThrow(/NOT_COVERED/);
  });

  test("mint honours abort", async () => {
    const authority = createReplicationAuthority(makeHost({ verifiedConsentAnchor: () => ({ at: 1_000_000, source: "siwe" }) }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      authority.mint(DEVICE_DID, "notes/", controller.signal),
    ).rejects.toThrow();
  });
});
