import { describe, expect, test } from "bun:test";
import {
  APPROVAL_FILE,
  LEGACY_APPROVAL_FILE,
  discardApprovalFiles,
  loadApprovalFiles,
  serializeApprovalFile,
  type ApprovalFile,
  type ApprovalFileOp,
  type ApprovalFilesInput,
} from "../src/links/index.js";
import { CONTENT_KEY, RELAY_KEY, RESULT_EXPIRES, RESULT_REF, T0, entryIn, preparedRecord, requestBody } from "./approval-machine-fixtures.js";

// TC-2377 hold remedy: the v2 file is `approval-pending.v2.json`. A published tc reads `approval-pending.json` as its v1 array with no
// version check, so v2 content must never be written under that name. A v1 file is migrated into the v2 file and deleted only after
// the v2 file is written; logout and the key sweep delete both names.

const NOW = T0 + 5_000;
const id = (n: number) => `abcdefghijklmnopqrstuvwx${"bcdefg"[n]}${"234567"[n]}`;

/** What a published tc writes under `approval-pending.json`. */
function cliV1(requestId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, request: requestBody, requestId, bodyCid: preparedRecord.bodyCid, approvalUrl: `https://openkey.example/a/${requestId}#v=4&k=${CONTENT_KEY}`,
    requestExpiresAt: preparedRecord.record.header.expiresAt, record: preparedRecord.record,
    apiOrigin: "https://api.openkey.example", linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example",
    relayPrivateKey: RELAY_KEY, ackId: "ack-id-0123456789abcdef", ...over,
  };
}
/** The v2 file as a reader finds it on disk (written, then read back as JSON). */
const v2Json = (file: ApprovalFile): unknown => JSON.parse(serializeApprovalFile(file));
const v2Of = (...requestIds: string[]): unknown => v2Json({ version: 2, entries: requestIds.map((requestId) => entryIn("open", { requestId })), unrecognized: [] });

/** A profile directory as the adapter sees it, and the adapter's part: apply `ops` in order. */
function applyOps(disk: Map<string, unknown>, file: ApprovalFile, ops: readonly ApprovalFileOp[]): string[] {
  const log: string[] = [];
  for (const op of ops) {
    if (op.op === "write") disk.set(op.name, v2Json(file));
    else disk.delete(op.name);
    log.push(`${op.op} ${op.name}`);
  }
  return log;
}
const inputOf = (disk: Map<string, unknown>): ApprovalFilesInput => ({
  ...(disk.has(APPROVAL_FILE) ? { v2: disk.get(APPROVAL_FILE) } : {}),
  ...(disk.has(LEGACY_APPROVAL_FILE) ? { v1: disk.get(LEGACY_APPROVAL_FILE) } : {}),
});
function load(disk: Map<string, unknown>) {
  const loaded = loadApprovalFiles(inputOf(disk), { now: NOW });
  if (loaded.kind !== "ok") throw new Error(`expected ok, got ${loaded.kind}`);
  return loaded;
}

describe("the v2 file has its own name", () => {
  test("names: v2 is approval-pending.v2.json; approval-pending.json stays the v1 name", () => {
    expect(APPROVAL_FILE).toBe("approval-pending.v2.json");
    expect(LEGACY_APPROVAL_FILE).toBe("approval-pending.json");
  });

  test("a CLI v1 array is migrated into the v2 file, which is written BEFORE the v1 file is deleted", () => {
    const disk = new Map<string, unknown>([[LEGACY_APPROVAL_FILE, [cliV1(id(0)), cliV1(id(1), { resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES })]]]);
    const first = load(disk);
    expect(first.migratedFrom).toBe(1);
    expect(first.file.entries.map((entry) => [entry.requestId, entry.phase])).toEqual([[id(0), "open"], [id(1), "discovered"]]);
    expect(applyOps(disk, first.file, first.ops)).toEqual([`write ${APPROVAL_FILE}`, `delete ${LEGACY_APPROVAL_FILE}`]);
    expect([...disk.keys()]).toEqual([APPROVAL_FILE]);
    // The next load reads the v2 file alone: same entries, nothing more to migrate or delete.
    const next = load(disk);
    expect(next.migratedFrom).toBe(0);
    expect(next.ops).toEqual([]);
    expect(next.file.entries).toEqual(first.file.entries);
  });

  test("Courier's v1 object is migrated and deleted the same way", () => {
    const disk = new Map<string, unknown>([[LEGACY_APPROVAL_FILE, cliV1(id(2))]]);
    const loaded = load(disk);
    expect(loaded.file.entries.map((entry) => entry.requestId)).toEqual([id(2)]);
    applyOps(disk, loaded.file, loaded.ops);
    expect([...disk.keys()]).toEqual([APPROVAL_FILE]);
  });

  test("a v1 file an older tc writes after the migration is merged into the v2 file, then deleted", () => {
    const disk = new Map<string, unknown>([[APPROVAL_FILE, v2Of(id(0))], [LEGACY_APPROVAL_FILE, [cliV1(id(3))]]]);
    const loaded = load(disk);
    expect(loaded.file.entries.map((entry) => entry.requestId)).toEqual([id(0), id(3)]);
    expect(applyOps(disk, loaded.file, loaded.ops)).toEqual([`write ${APPROVAL_FILE}`, `delete ${LEGACY_APPROVAL_FILE}`]);
    expect(load(disk).file.entries.map((entry) => entry.requestId)).toEqual([id(0), id(3)]);
  });

  test("a v1 copy of a request already in the v2 file (a migration cut short) is set aside, not dropped; the v2 copy wins", () => {
    const repeat = cliV1(id(0), { resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES });
    const loaded = load(new Map<string, unknown>([[APPROVAL_FILE, v2Of(id(0))], [LEGACY_APPROVAL_FILE, [repeat]]]));
    expect(loaded.file.entries.map((entry) => [entry.requestId, entry.phase])).toEqual([[id(0), "open"]]);
    expect(loaded.file.unrecognized).toHaveLength(1);
    expect(JSON.stringify(loaded.file.unrecognized[0]!.raw)).toContain(RELAY_KEY);
  });

  test("no load ever writes approval-pending.json", () => {
    const cases: ApprovalFilesInput[] = [{}, { v1: [cliV1(id(0))] }, { v1: cliV1(id(0)) }, { v2: v2Of(id(1)) }, { v2: v2Of(id(1)), v1: [cliV1(id(0))] }];
    for (const input of cases) {
      const loaded = loadApprovalFiles(input, { now: NOW });
      if (loaded.kind !== "ok") throw new Error(loaded.kind);
      expect(loaded.ops.filter((op) => op.op === "write").map((op) => op.name)).toEqual(input.v1 === undefined ? [] : [APPROVAL_FILE]);
    }
  });

  test("an unreadable v1 file is reported by name and never deleted by a load; a newer v2 file stops the load with both files untouched", () => {
    expect(loadApprovalFiles({ v1: null }, { now: NOW })).toEqual({ kind: "corrupt", name: LEGACY_APPROVAL_FILE });
    expect(loadApprovalFiles({ v2: v2Of(id(0)), v1: { not: "approvals" } }, { now: NOW })).toEqual({ kind: "corrupt", name: LEGACY_APPROVAL_FILE });
    expect(loadApprovalFiles({ v2: null, v1: [cliV1(id(0))] }, { now: NOW })).toEqual({ kind: "corrupt", name: APPROVAL_FILE });
    expect(loadApprovalFiles({ v2: { version: 3, entries: [] }, v1: [cliV1(id(0))] }, { now: NOW })).toEqual({ kind: "newer", version: 3 });
  });
});

describe("logout and the key sweep delete both names", () => {
  test("both files go, with every readable request named", () => {
    const disk = new Map<string, unknown>([[APPROVAL_FILE, v2Of(id(0), id(1))], [LEGACY_APPROVAL_FILE, [cliV1(id(2)), cliV1(id(0))]]]);
    const discarded = discardApprovalFiles(inputOf(disk), { now: NOW });
    expect([...discarded.requestIds].sort()).toEqual([id(0), id(1), id(2)].sort());
    applyOps(disk, { version: 2, entries: [], unrecognized: [] }, discarded.ops);
    expect([...disk.keys()]).toEqual([]);
  });

  test("files it cannot read, or from a newer client, are deleted too (they may hold keys)", () => {
    for (const input of [{ v2: null, v1: null }, { v2: { version: 3 } }, { v1: "garbage" }, {}] as ApprovalFilesInput[]) {
      const disk = new Map<string, unknown>(Object.entries({ [APPROVAL_FILE]: input.v2, [LEGACY_APPROVAL_FILE]: input.v1 }).filter(([, value]) => value !== undefined));
      const discarded = discardApprovalFiles(input, { now: NOW });
      expect(discarded.requestIds).toEqual([]);
      applyOps(disk, { version: 2, entries: [], unrecognized: [] }, discarded.ops);
      expect([...disk.keys()]).toEqual([]);
    }
  });
});
