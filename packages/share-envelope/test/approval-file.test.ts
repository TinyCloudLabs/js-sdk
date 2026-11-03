import { describe, expect, test } from "bun:test";
import {
  QUARANTINE_RETENTION_MS,
  parseApprovalFile,
  purgeAt,
  serializeApprovalFile,
  sweepApprovalFile,
  type ApprovalFile,
} from "../src/links/index.js";
import { CONTENT_KEY, E, R, RELAY_KEY, RESULT_EXPIRES, RESULT_REF, S, STAGED_KEY, T0, entryIn, iso, preparedRecord, requestBody } from "./approval-machine-fixtures.js";

// TC-2377: one `approval-pending.json` (v2). The CLI's v1 file is an ARRAY of entries, Courier's v1 file is ONE object;
// both are read, never lose a pending approval, and are written back as v2 only. A pending approval holds private keys,
// so an entry that cannot be read is preserved (quarantined), never silently dropped.

const id = (n: number) => `abcdefghijklmnopqrstuvwx${"abcdefghij"[Math.floor(n / 10)]}${"234567abcd"[n % 10]}`;

/** What the CLI wrote (v1): `signingKey` is the staged rotation key; `record` is the full record the links API returned. */
function cliV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, request: requestBody, requestId: id(0), bodyCid: preparedRecord.bodyCid, approvalUrl: `https://openkey.example/a/${id(0)}#v=4&k=${CONTENT_KEY}`,
    requestExpiresAt: preparedRecord.record.header.expiresAt, record: preparedRecord.record,
    apiOrigin: "https://api.openkey.example", linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example",
    relayPrivateKey: RELAY_KEY, ackId: "ack-id-0123456789abcdef", ...over,
  };
}
/** What Courier wrote (v1): a single object, no CLI-only fields. */
const courierV1 = (over: Record<string, unknown> = {}) => cliV1(over);

const T = T0 + 5_000;
function ok(raw: unknown) {
  const parsed = parseApprovalFile(raw, { now: T });
  if (parsed.kind !== "ok") throw new Error(`expected ok, got ${parsed.kind}`);
  return parsed;
}
const byId = (file: ApprovalFile, requestId: string) => file.entries.find((entry) => entry.requestId === requestId)!;

describe("CLI v1 (an array) migrates to v2 without losing an entry", () => {
  const raw = [
    cliV1({ requestId: id(1) }),
    cliV1({ requestId: id(2), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }),
    cliV1({ requestId: id(3), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, resultEnvelope: { relay: "opaque" } }),
    cliV1({ requestId: id(4), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, resultEnvelope: { relay: "opaque" }, committed: true }),
    cliV1({
      requestId: id(5), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, committed: true, acknowledged: true,
      commandIntent: "auth-grant:abc", expectedOwner: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      command: { request: { marker: "request" }, result: { expiry: iso(E + 3_600_000) } },
    }),
    cliV1({ requestId: id(6), signingKey: STAGED_KEY, resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }),
  ];
  const parsed = ok(raw);

  test("reports the migration, keeps every request id and the phases", () => {
    expect(parsed.migratedFrom).toBe(1);
    expect(parsed.file.version).toBe(2);
    expect(parsed.file.entries.map((entry) => entry.requestId)).toEqual([id(1), id(2), id(3), id(4), id(5), id(6)]);
    expect(parsed.file.entries.map((entry) => entry.phase)).toEqual(["open", "discovered", "fetched", "committed", "acked", "discovered"]);
    expect(parsed.file.unrecognized).toEqual([]);
  });

  test("the staged rotation key survives, byte for byte (it exists nowhere else)", () => {
    expect(byId(parsed.file, id(6)).keys).toEqual({ relayPrivateKey: RELAY_KEY, stagedSigningKey: STAGED_KEY });
    expect(byId(parsed.file, id(1)).keys).toEqual({ relayPrivateKey: RELAY_KEY });
  });

  test("an acknowledged command entry becomes a key-free `acked` entry kept until its child grant expires, CLI fields under ext.cli", () => {
    const acked = byId(parsed.file, id(5));
    expect(acked.keys).toBeUndefined();
    expect(acked.resultEnvelope).toBeUndefined();
    expect(acked.retainUntil).toBe(iso(E + 3_600_000));
    expect(acked.ext).toEqual({ cli: { commandIntent: "auth-grant:abc", expectedOwner: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001", command: { request: { marker: "request" }, result: { expiry: iso(E + 3_600_000) } } } });
  });

  test("an acknowledged command entry without a readable child expiry is kept for a bounded time, not forever", () => {
    const acked = byId(ok([cliV1({ requestId: id(7), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, committed: true, acknowledged: true, command: { request: {}, result: {} } })]).file, id(7));
    expect(acked.phase).toBe("acked");
    expect(purgeAt(acked)).toBe(E + R + S);
  });

  test("a committed entry that still holds a staged key keeps it (migration never destroys a key)", () => {
    const committed = byId(ok([cliV1({ requestId: id(8), signingKey: STAGED_KEY, resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, resultEnvelope: { relay: "x" }, committed: true })]).file, id(8));
    expect(committed.phase).toBe("committed");
    expect(committed.keys?.stagedSigningKey).toEqual(STAGED_KEY);
  });

  test("the unsigned `requestExpiresAt` is dropped; the signed header is the expiry, and a mismatch is reported", () => {
    const mismatch = ok([cliV1({ requestId: id(9), requestExpiresAt: iso(E + 999_000) })]);
    expect(mismatch.notes).toEqual([{ requestId: id(9), note: "request-expiry-mismatch" }]);
    expect(JSON.stringify(mismatch.file)).not.toContain("requestExpiresAt");
    expect(ok([cliV1()]).notes).toEqual([]);
  });

  test("createdAt is the signed header's issuedAt (the v1 file has no creation time)", () => {
    expect(parsed.file.entries[0]!.createdAt).toBe(preparedRecord.record.header.issuedAt);
  });
});

describe("Courier v1 (one object) migrates too", () => {
  test.each([
    ["open", {}, "open"],
    ["discovered", { resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }, "discovered"],
    ["fetched", { resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, resultEnvelope: { relay: "x" } }, "fetched"],
    ["committed", { resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, resultEnvelope: { relay: "x" }, committed: true }, "committed"],
  ])("%s", (_name, over, phase) => {
    const parsed = ok(courierV1({ requestId: id(11), ...over }));
    expect(parsed.migratedFrom).toBe(1);
    expect(parsed.file.entries).toHaveLength(1);
    expect(parsed.file.entries[0]).toMatchObject({ requestId: id(11), phase, ext: {}, keys: { relayPrivateKey: RELAY_KEY } });
  });
});

describe("v2 and the shapes that are not a v2 file", () => {
  test("a v2 file passes through unchanged and round-trips through serialize", () => {
    const file: ApprovalFile = {
      version: 2, entries: [entryIn("open", { staged: true, requestId: id(20) }), entryIn("acked", { requestId: id(21) })],
      unrecognized: [{ raw: { whatever: true }, quarantinedAt: iso(T) }],
    };
    const parsed = ok(JSON.parse(serializeApprovalFile(file)));
    expect(parsed.migratedFrom).toBe(0);
    expect(parsed.file).toEqual(file);
    expect(serializeApprovalFile(parsed.file)).toBe(serializeApprovalFile(file));
  });

  test("a newer version is reported, not read and not touched", () => {
    expect(parseApprovalFile({ version: 3, entries: [] }, { now: T })).toEqual({ kind: "newer", version: 3 });
  });

  test("an unrecognised top-level value is corrupt (the adapter sets the file aside)", () => {
    for (const raw of [null, "text", 7, {}, { version: 1 }, { version: "2" }]) {
      expect(parseApprovalFile(raw, { now: T }).kind).toBe("corrupt");
    }
  });

  test("an empty CLI array is an empty file", () => {
    expect(ok([]).file.entries).toEqual([]);
  });

  test("an entry that cannot be parsed is quarantined with its raw bytes, the others are untouched", () => {
    const broken = cliV1({ requestId: id(31), relayPrivateKey: 12 });
    const parsed = ok([cliV1({ requestId: id(30) }), broken, "not an object", { version: 9 }, cliV1({ requestId: id(32) })]);
    expect(parsed.file.entries.map((entry) => entry.requestId)).toEqual([id(30), id(32)]);
    expect(parsed.file.unrecognized).toEqual([
      { raw: broken, quarantinedAt: iso(T) }, { raw: "not an object", quarantinedAt: iso(T) }, { raw: { version: 9 }, quarantinedAt: iso(T) },
    ]);
  });

  test("a v2 entry with a field this reader does not know is quarantined, never rewritten lossily", () => {
    const file = JSON.parse(serializeApprovalFile({ version: 2, entries: [entryIn("open", { requestId: id(40) })], unrecognized: [] }));
    file.entries[0].fromTheFuture = true;
    const parsed = ok(file);
    expect(parsed.file.entries).toEqual([]);
    expect(parsed.file.unrecognized).toHaveLength(1);
    expect(parsed.file.unrecognized[0]!.raw).toEqual(file.entries[0]);
  });

  test("count + request id set are preserved over a mixed file (entries + quarantined = input)", () => {
    const raw = [cliV1({ requestId: id(50) }), { garbage: 1 }, cliV1({ requestId: id(51), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES })];
    const parsed = ok(raw);
    expect(parsed.file.entries.length + parsed.file.unrecognized.length).toBe(raw.length);
  });
});

describe("sweepApprovalFile: private keys never outlive their use", () => {
  test("drops entries past their purge time with the outcome, keeps the rest untouched", () => {
    const kept = entryIn("acked", { requestId: id(60), retainUntil: E + 10 * R });
    const stale = entryIn("open", { requestId: id(61) });
    const file: ApprovalFile = { version: 2, entries: [kept, stale], unrecognized: [] };
    const swept = sweepApprovalFile(file, purgeAt(stale));
    expect(swept.file.entries).toEqual([kept]);
    expect(swept.dropped.map((drop) => [drop.requestId, drop.outcome.kind])).toEqual([[id(61), "lapsed"]]);
    const early = sweepApprovalFile(file, T);
    expect(early.file).toEqual(file);
    expect(early.dropped).toEqual([]);
  });

  test("a discovered entry is dropped as gone (an approval existed)", () => {
    const entry = entryIn("discovered", { requestId: id(62) });
    const swept = sweepApprovalFile({ version: 2, entries: [entry], unrecognized: [] }, purgeAt(entry));
    expect(swept.dropped).toEqual([{ requestId: id(62), outcome: { kind: "gone", reason: "purged", grantMayBeLive: "yes" } }]);
  });

  test("a quarantined entry is purged 24 h + retention + skew after it was set aside", () => {
    expect(QUARANTINE_RETENTION_MS).toBe((86_400 + 600 + 30) * 1000);
    const file: ApprovalFile = { version: 2, entries: [], unrecognized: [{ raw: cliV1(), quarantinedAt: iso(T) }, { raw: cliV1(), quarantinedAt: iso(T + 10_000) }] };
    expect(sweepApprovalFile(file, T + QUARANTINE_RETENTION_MS - 1).file.unrecognized).toHaveLength(2);
    expect(sweepApprovalFile(file, T + QUARANTINE_RETENTION_MS).file.unrecognized).toHaveLength(1);
    expect(sweepApprovalFile(file, T + 10_000 + QUARANTINE_RETENTION_MS).file.unrecognized).toHaveLength(0);
  });

  test("a committed entry past its purge time completes with a warning (the grant is saved) and its keys go", () => {
    const entry = entryIn("committed", { requestId: id(64) });
    const swept = sweepApprovalFile({ version: 2, entries: [entry], unrecognized: [] }, purgeAt(entry));
    expect(swept.file.entries).toEqual([]);
    expect(swept.dropped).toEqual([{ requestId: id(64), outcome: { kind: "completed", warning: "ack-expired" } }]);
  });

  test("a held entry is not given a longer life", () => {
    const entry = { ...entryIn("open", { requestId: id(63) }), hold: { kind: "clock" as const, since: iso(T) } };
    expect(sweepApprovalFile({ version: 2, entries: [entry], unrecognized: [] }, purgeAt(entry)).file.entries).toEqual([]);
  });
});

describe("the CLI's real signing key carries a `kid`; nothing else is accepted on it", () => {
  // `TCWSessionManager.jwk()` (published node-sdk-wasm 1.7.x) emits { crv, d, kid, kty, x }; the CLI stores it unchanged as `signingKey`.
  const withKey = (signingKey: unknown, requestId = id(70)) => ok([cliV1({ requestId, signingKey, resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES })]);

  test("a CLI entry with the real key migrates to ONE entry, nothing quarantined, kid and key kept byte for byte", () => {
    expect(Object.keys(STAGED_KEY).sort()).toEqual(["crv", "d", "kid", "kty", "x"]);
    const parsed = withKey(STAGED_KEY);
    expect(parsed.file.entries).toHaveLength(1);
    expect(parsed.file.unrecognized).toEqual([]);
    expect(parsed.file.entries[0]!.keys!.stagedSigningKey).toEqual(STAGED_KEY);
  });

  test("a v2 file written with the key as-is round-trips and is read back without quarantine", () => {
    const file: ApprovalFile = { version: 2, entries: [entryIn("open", { staged: true, requestId: id(71) })], unrecognized: [] };
    expect(file.entries[0]!.keys!.stagedSigningKey).toEqual(STAGED_KEY);
    const again = ok(JSON.parse(serializeApprovalFile(withKey(STAGED_KEY, id(72)).file)));
    expect(again.file.entries[0]!.keys!.stagedSigningKey!.kid).toBe("cli");
    expect(again.file.unrecognized).toEqual([]);
    expect(ok(JSON.parse(serializeApprovalFile(file))).file).toEqual(file);
  });

  test("a key without kid (a user-imported key.json) and one with alg/use are accepted too", () => {
    const { kid: _kid, ...bare } = STAGED_KEY;
    expect(withKey(bare).file.entries).toHaveLength(1);
    expect(withKey({ ...STAGED_KEY, alg: "EdDSA", use: "sig" }).file.entries).toHaveLength(1);
  });

  test.each([
    ["an unknown field", { ...STAGED_KEY, extra: "x" }],
    ["an oversized kid", { ...STAGED_KEY, kid: "k".repeat(10_000) }],
    ["a non-string kid", { ...STAGED_KEY, kid: 7 }],
    ["an oversized alg", { ...STAGED_KEY, alg: "a".repeat(1_000) }],
    ["a key_ops list", { ...STAGED_KEY, key_ops: ["sign"] }],
    ["a wrong curve", { ...STAGED_KEY, crv: "Ed448" }],
    ["a short d", { ...STAGED_KEY, d: "AAAA" }],
  ])("%s is still refused: the entry is quarantined with its raw content, not read", (_name, key) => {
    const parsed = withKey(key);
    expect(parsed.file.entries).toEqual([]);
    expect(parsed.file.unrecognized).toHaveLength(1);
  });
});

describe("hostile or inconsistent files", () => {
  const header = preparedRecord.record.header;
  const withHeader = (expiresAt: string, over: Record<string, unknown> = {}) =>
    cliV1({ requestId: id(73), record: { ...preparedRecord.record, header: { ...header, expiresAt } }, requestExpiresAt: expiresAt, ...over });

  test("a request life above 24 h (or an expiry in 2099) is quarantined: a key's life is bounded by construction", () => {
    const issued = Date.parse(header.issuedAt);
    expect(ok([withHeader(iso(issued + 86_400_000))]).file.entries).toHaveLength(1);
    for (const expiresAt of [iso(issued + 86_401_000), "2099-01-01T00:00:00.000Z"]) {
      const parsed = ok([withHeader(expiresAt)]);
      expect(parsed.file.entries).toEqual([]);
      expect(parsed.file.unrecognized).toHaveLength(1);
    }
  });

  test("a v2 entry whose creation time is more than a day (plus the 120 s window) before its expiry is quarantined", () => {
    const entry = JSON.parse(serializeApprovalFile({ version: 2, entries: [entryIn("open", { requestId: id(74) })], unrecognized: [] }));
    entry.entries[0].createdAt = iso(E - 86_400_000 - 121_000);
    expect(ok(entry).file.unrecognized).toHaveLength(1);
    entry.entries[0].createdAt = iso(E - 86_400_000 - 120_000);
    expect(ok(entry).file.entries).toHaveLength(1);
  });

  test("a duplicate requestId is quarantined; the first entry is kept and a remove can never take a sibling", () => {
    const first = cliV1({ requestId: id(75) });
    const second = cliV1({ requestId: id(75), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES });
    const legacy = ok([first, second]);
    expect(legacy.file.entries.map((entry) => entry.phase)).toEqual(["open"]);
    expect(legacy.file.unrecognized).toEqual([{ raw: second, quarantinedAt: iso(T) }]);
    const v2 = JSON.parse(serializeApprovalFile({ version: 2, entries: [entryIn("open", { requestId: id(76) }), entryIn("discovered", { requestId: id(76) })], unrecognized: [] }));
    const parsed = ok(v2);
    expect(parsed.file.entries.map((entry) => entry.phase)).toEqual(["open"]);
    expect(parsed.file.unrecognized).toHaveLength(1);
    expect(new Set(parsed.file.entries.map((entry) => entry.requestId)).size).toBe(parsed.file.entries.length);
  });

  test("a quarantined entry stamped in the future is clamped to now, so it is purged on schedule", () => {
    const file = { version: 2, entries: [], unrecognized: [{ raw: { keep: "me" }, quarantinedAt: "9999-01-01T00:00:00.000Z" }, { raw: 1, quarantinedAt: iso(T - 5_000) }] };
    const parsed = ok(file);
    expect(parsed.file.unrecognized.map((item) => item.quarantinedAt)).toEqual([iso(T), iso(T - 5_000)]);
    expect(sweepApprovalFile(parsed.file, T + QUARANTINE_RETENTION_MS).file.unrecognized).toHaveLength(0);
    expect(sweepApprovalFile(parsed.file, T + QUARANTINE_RETENTION_MS - 1).file.unrecognized).toHaveLength(1);
  });
});

describe("an acknowledged entry holds no content key", () => {
  const acked = () => ok([cliV1({
    requestId: id(77), resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES, committed: true, acknowledged: true,
    command: { request: {}, result: { expiry: iso(E + 3_600_000) } },
  })]).file.entries[0]!;

  test("migration drops the approval URL (its fragment holds the content key) and the sealed body", () => {
    const entry = acked();
    expect(entry.approvalUrl).toBeUndefined();
    expect(entry.record.body).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(CONTENT_KEY);
  });

  test("the format refuses an acked entry that still carries an approval URL, and a live entry without one", () => {
    const file = JSON.parse(serializeApprovalFile({ version: 2, entries: [entryIn("acked", { requestId: id(78) }), entryIn("open", { requestId: id(79) })], unrecognized: [] }));
    file.entries[0].approvalUrl = `https://openkey.example/a/${id(78)}#v=4&k=${CONTENT_KEY}`;
    delete file.entries[1].approvalUrl;
    const parsed = ok(file);
    expect(parsed.file.entries).toEqual([]);
    expect(parsed.file.unrecognized).toHaveLength(2);
  });
});

describe("an acknowledged entry holds no sealed body either (D-4)", () => {
  test("a v2 acked entry that still carries record.body is refused on read (quarantined)", () => {
    const file = JSON.parse(serializeApprovalFile({ version: 2, entries: [entryIn("acked", { requestId: id(79) })], unrecognized: [] }));
    file.entries[0].record.body = "AAAA";
    const parsed = ok(file);
    expect(parsed.file.entries).toEqual([]);
    expect(parsed.file.unrecognized).toHaveLength(1);
  });

  test("a live entry may keep its body (it is the signed record the CLI got back)", () => {
    const file = JSON.parse(serializeApprovalFile({ version: 2, entries: [entryIn("open", { requestId: id(78) })], unrecognized: [] }));
    file.entries[0].record.body = "AAAA";
    expect(ok(file).file.entries).toHaveLength(1);
  });
});
