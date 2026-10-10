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
      assertValidReplicationConfig({ enabled: true, prefixes: ["notes"] }),
    ).toThrow(TypeError);
  });

  test("empty or blank prefixes throw", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: [] }),
    ).toThrow(TypeError);
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: [""] }),
    ).toThrow(TypeError);
  });

  test("overlapping prefixes throw; sibling prefixes pass", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/", "notes/todo"] }),
    ).toThrow(/overlap/);
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/", "note-s/"] }),
    ).not.toThrow();
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes", "notes/todo"] }),
    ).toThrow(/overlap/);
  });

  test("a vault prefix requires allowSecrets", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["vault/keys"] }),
    ).toThrow(/allowSecrets/);
    expect(() =>
      assertValidReplicationConfig({
        enabled: true,
        storage,
        prefixes: ["vault/keys"],
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
      hasUnrestrictedGetCoverage([kvEntry({ actions: ["tinycloud.kv/put"] })], SPACE, "notes"),
    ).toBe(false);
  });

  test("kv/* action and root path cover; unrelated service does not", () => {
    expect(
      hasUnrestrictedGetCoverage([kvEntry({ path: "", actions: ["tinycloud.kv/*"] })], SPACE, "notes"),
    ).toBe(true);
    expect(
      hasUnrestrictedGetCoverage(
        [{ service: "tinycloud.sql", space: SPACE, path: "", actions: ["tinycloud.kv/get"] }],
        SPACE,
        "notes",
      ),
    ).toBe(false);
  });

  test("selected namespace requires authority on the exact key and descendants", () => {
    const exact = [kvEntry({ path: "notes" })];
    expect(hasUnrestrictedGetCoverage(exact, SPACE, "notes")).toBe(false);
    const slash = [kvEntry({ path: "notes/" })];
    expect(hasUnrestrictedGetCoverage(slash, SPACE, "notes")).toBe(false);
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "notes" }), kvEntry({ path: "notes/" })], SPACE, "notes")).toBe(true);
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "" })], SPACE, "notes")).toBe(true);
    expect(hasUnrestrictedGetCoverage([kvEntry({ path: "parent/" })], SPACE, "parent/notes")).toBe(true);
    const out = augmentSignInEntriesWithReplication({
      entries: exact,
      primarySpaceId: SPACE,
      replication: { prefixes: ["notes/", "notes/private", "notesX"] },
    });
    expect(out).toEqual([]);
  });
});

describe("augmentSignInEntriesWithReplication (§4.1)", () => {
  const replication = { prefixes: ["notes", "other"] };

  test("bare selectors emit exact and descendant get/sync grant entries", () => {
    const out = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication,
    });
    expect(out).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "other", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "other/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    expect(augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["notes/", ""] },
    }).map((entry) => entry.path)).toEqual(["notes/", ""]);
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
      replication: { prefixes: ["vault/keys", "notes"] },
    });
    expect(out.map((entry) => entry.path)).toEqual(["notes", "notes/"]);
    const opted = augmentSignInEntriesWithReplication({
      entries: [kvEntry({ path: "" })],
      primarySpaceId: SPACE,
      replication: { prefixes: ["vault/keys"], allowSecrets: true },
    });
    expect(opted.map((entry) => entry.path)).toEqual(["vault/keys", "vault/keys/"]);
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
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes")).toBe(true);
    expect(ucanAttUnconstrainedFor({ [`tinycloud://${SPACE}/kv/unrelated/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} } }, SPACE, "notes")).toBe(false);
  });
  test("signed exact-key authority cannot cover a selected namespace's descendants", () => {
    const exact = { [`tinycloud://${SPACE}/kv/notes`]: { "tinycloud.kv/get": {} } };
    for (const prefix of ["notes", "notes/", "notes/private", "notesX"]) {
      expect(ucanAttCovers(exact, SPACE, prefix, "tinycloud.kv/get")).toBe(false);
    }
    const slash = { [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {} } };
    expect(ucanAttCovers(slash, SPACE, "notes", "tinycloud.kv/get")).toBe(false);
    expect(ucanAttCovers(slash, SPACE, "notes/a", "tinycloud.kv/get")).toBe(true);
    expect(ucanAttCovers(slash, SPACE, "notes/a/b", "tinycloud.kv/get")).toBe(true);
  });
  test("exact and slash grants together cover a bare selector", () => {
    const att = {
      [`tinycloud://${SPACE}/kv/notes`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
      [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
    };
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes")).toBe(true);
  });


  test("caveated branch: coverage under ignoreCaveats, refusal otherwise", () => {
    const att = {
      [resource]: {
        "tinycloud.kv/get": { maxValueSize: [1000] },
        "tinycloud.kv/sync": {},
      },
    };
    expect(ucanAttCovers(att, SPACE, "notes", "tinycloud.kv/get", { ignoreCaveats: true })).toBe(true);
    expect(ucanAttCovers(att, SPACE, "notes", "tinycloud.kv/get")).toBe(false);
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes")).toBe(false);
  });

  test("empty caveat arrays count as unconstrained", () => {
    const att = {
      [resource]: {
        "tinycloud.kv/get": {},
        "tinycloud.kv/sync": [{}],
      },
    };
    expect(ucanAttUnconstrainedFor(att, SPACE, "notes")).toBe(true);
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

function fakeSessionUcan(att: Record<string, Record<string, unknown>>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "EdDSA" });
  const payload = b64({
    iss: SESSION_DID.split("#", 1)[0],
    aud: SESSION_DID,
    att,
    prf: ["bafyParent"],
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
  return {
    replicationSession: () => fakeSession(),
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
    const result = authority.sessionGrant("notes");
    if ("refused" in result) throw new Error(`unexpected refusal ${result.refused}`);
    expect(result.device.did).toBe(SESSION_DID);
  });
  test("sessionGrant requires authority over exact key and descendants", () => {
    const session = fakeSession({
      delegationHeader: {
        Authorization: fakeSessionUcan({
          [`tinycloud://${SPACE}/kv/notes`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
        }),
      },
    });
    const authority = createReplicationAuthority(makeHost({ replicationSession: () => session }));
    expect(authority.sessionGrant("notes")).toEqual({ refused: "NOT_COVERED" });
    for (const prefix of ["notes/", "notes/private", "notesX"]) {
      expect(authority.sessionGrant(prefix)).toEqual({ refused: "NOT_COVERED" });
    }
    const slashOnly = fakeSession({
      delegationHeader: {
        Authorization: fakeSessionUcan({
          [`tinycloud://${SPACE}/kv/notes/`]: { "tinycloud.kv/get": {}, "tinycloud.kv/sync": {} },
        }),
      },
    });
    expect(createReplicationAuthority(makeHost({ replicationSession: () => slashOnly })).sessionGrant("notes"))
      .toEqual({ refused: "NOT_COVERED" });
  });


  test("sessionGrant refuses NOT_COVERED for a non-UCAN header and uncovered prefix", () => {
    const authority = createReplicationAuthority(
      makeHost({
        replicationSession: () =>
          fakeSession({ delegationHeader: { Authorization: "Bearer not-a-ucan" } }),
      }),
    );
    expect(authority.sessionGrant("notes")).toEqual({ refused: "NOT_COVERED" });
    const uncovered = createReplicationAuthority(makeHost());
    expect(uncovered.sessionGrant("notes")).toEqual({ refused: "NOT_COVERED" });
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
    expect(authority.sessionGrant("notes")).toEqual({ refused: "CAVEATED_AUTHORITY" });
  });

  test("sessionGrant refuses SESSION_EXPIRING inside the 60s margin", () => {
    const authority = createReplicationAuthority(
      makeHost({ siweExpiration: () => new Date(Date.now() + 30_000) }),
    );
    expect(authority.sessionGrant("notes")).toEqual({ refused: "SESSION_EXPIRING" });
  });

  test("plan passes exact and descendant grant paths for a bare selector", () => {
    const planDelegation = mock(() => ({
      path: "runtime" as const,
      parentCid: "bafyA",
      expiresAt: 1_700_000_000_000,
    }));
    const authority = createReplicationAuthority(makeHost({ planDelegation }));
    const plan = authority.plan("notes");
    expect(plan).toEqual({ path: "runtime", parentCid: "bafyA", expiresAt: 1_700_000_000_000 });
    const entries = planDelegation.mock.calls[0]![0] as PermissionEntry[];
    expect(entries).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);

    const refused = createReplicationAuthority(
      makeHost({ planDelegation: () => ({ refused: "CAVEATED_AUTHORITY" as const }) }),
    );
    expect(refused.plan("notes")).toEqual({ refused: "CAVEATED_AUTHORITY" });
  });

  test("mint carries the plan's parentCid and the minted ucan+expiry; a refusal throws typed", async () => {
    const plan = { path: "runtime" as const, parentCid: "bafyB", expiresAt: 1_800_000_000_000 };
    const mintDelegation = mock(async () => ({ ucan: "signed-ucan", expiresAt: plan.expiresAt }));
    const authority = createReplicationAuthority(
      makeHost({ planDelegation: () => plan, mintDelegation }),
    );
    const result = await authority.mint(DEVICE_DID, "notes", new AbortController().signal);
    expect(result).toEqual({ ucan: "signed-ucan", parentCid: "bafyB", expiresAt: plan.expiresAt });
    expect(mintDelegation.mock.calls[0]![0]).toBe(DEVICE_DID);
    expect(mintDelegation.mock.calls[0]![1]).toEqual([
      { service: "tinycloud.kv", space: SPACE, path: "notes", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
      { service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);

    const refused = createReplicationAuthority(
      makeHost({ planDelegation: () => ({ refused: "NOT_COVERED" as const }) }),
    );
    await expect(
      refused.mint(DEVICE_DID, "notes", new AbortController().signal),
    ).rejects.toThrow(/NOT_COVERED/);
  });

  test("mint honours abort", async () => {
    const authority = createReplicationAuthority(makeHost());
    const controller = new AbortController();
    controller.abort();
    await expect(
      authority.mint(DEVICE_DID, "notes", controller.signal),
    ).rejects.toThrow();
  });
});
