import { describe, expect, test } from "bun:test";
import {
  driveApproval,
  parseApprovalFile,
  serializeApprovalFile,
  type ApprovalDriverIo,
  type ApprovalEntry,
  type CallResult,
  type Reply,
} from "../src/links/index.js";
import { CONTENT_KEY, E, RELAY_KEY, RESULT_EXPIRES, RESULT_REF, STAGED_KEY, T0, iso, preparedRecord, requestBody } from "./approval-machine-fixtures.js";

// TC-2377: the v1 -> v2 migration of `approval-pending.json` is lossless. Every field the CLI's v1 entry has (Courier's v1
// object is a subset) is found again in the v2 entry, and a migrated pending approval resumes from its phase to completion.

const NOW = T0 + 5_000;
const REQUEST_ID = "abcdefghijklmnopqrstuvwxyz";
const OWNER = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";

/** Every field of the CLI's v1 `PendingApproval` (cli/src/auth/approval-request.ts), each set to a recognisable value. */
const V1_FIELDS = [
  "version", "request", "requestId", "bodyCid", "approvalUrl", "requestExpiresAt", "record", "apiOrigin", "linkApiOrigin",
  "openkeyOrigin", "signingKey", "relayPrivateKey", "expectedOwner", "invitationMeta", "resultRef", "resultExpiresAt",
  "resultEnvelope", "ackId", "committed", "commandIntent", "command", "acknowledged",
] as const;
type V1 = Partial<Record<(typeof V1_FIELDS)[number], unknown>>;

function v1(phase: "open" | "discovered" | "fetched" | "committed"): V1 {
  return {
    version: 1, request: requestBody, requestId: REQUEST_ID, bodyCid: preparedRecord.bodyCid,
    approvalUrl: `https://openkey.example/a/${REQUEST_ID}#v=4&k=${CONTENT_KEY}`,
    requestExpiresAt: preparedRecord.record.header.expiresAt, record: preparedRecord.record,
    apiOrigin: "https://api.openkey.example", linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example",
    signingKey: STAGED_KEY, relayPrivateKey: RELAY_KEY, expectedOwner: OWNER,
    invitationMeta: { contentSha256: "a".repeat(64), requestedDurationMs: 86_400_000 },
    ackId: "ack-id-0123456789abcdef", commandIntent: `auth-grant:${"b".repeat(64)}`,
    ...(phase === "open" ? {} : { resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES }),
    ...(phase === "fetched" || phase === "committed" ? { resultEnvelope: { relay: "opaque-ciphertext" } } : {}),
    ...(phase === "committed" ? { committed: true, command: { request: { marker: "request" }, result: { expiry: iso(E + 3_600_000) } } } : {}),
  };
}

/** Where each v1 field lives in v2. `version` is the file's own version; `committed`/`acknowledged` are the phase. */
function inV2(entry: ApprovalEntry, field: (typeof V1_FIELDS)[number]): unknown {
  const cli = (entry.ext.cli ?? {}) as Record<string, unknown>;
  switch (field) {
    case "version": return 1;
    case "requestExpiresAt": return entry.record.header.expiresAt;
    case "signingKey": return entry.keys?.stagedSigningKey;
    case "relayPrivateKey": return entry.keys?.relayPrivateKey;
    case "committed": return entry.phase === "committed" ? true : undefined;
    case "acknowledged": return entry.phase === "acked" ? true : undefined;
    case "expectedOwner": case "commandIntent": case "command": case "invitationMeta": return cli[field];
    default: return (entry as unknown as Record<string, unknown>)[field];
  }
}

/** Migrate, write as v2, read the v2 text back: what the next run of an adopting client sees. */
function migrated(raw: unknown): ApprovalEntry[] {
  const first = parseApprovalFile(raw, { now: NOW });
  if (first.kind !== "ok") throw new Error(`v1 not read: ${first.kind}`);
  expect(first.migratedFrom).toBe(1);
  expect(first.file.unrecognized).toEqual([]);
  expect(first.notes).toEqual([]);
  const again = parseApprovalFile(JSON.parse(serializeApprovalFile(first.file)), { now: NOW });
  if (again.kind !== "ok") throw new Error(`v2 not read back: ${again.kind}`);
  expect(again.migratedFrom).toBe(0);
  expect(again.file.entries).toEqual(first.file.entries);
  return [...again.file.entries];
}

const PHASES = ["open", "discovered", "fetched", "committed"] as const;

describe("v1 -> v2 migration is lossless", () => {
  test.each(PHASES)("a CLI v1 entry in phase %s keeps every v1 field, through a v2 write and read", (phase) => {
    const raw = v1(phase);
    const [entry] = migrated([raw]);
    expect(entry!.phase).toBe(phase);
    for (const field of V1_FIELDS) expect({ field, value: inV2(entry!, field) }).toEqual({ field, value: raw[field] });
  });

  test("Courier's v1 object (one entry, no CLI fields) keeps every field", () => {
    const { signingKey: _s, expectedOwner: _o, invitationMeta: _i, commandIntent: _c, ...raw } = v1("discovered");
    const [entry] = migrated(raw);
    for (const field of V1_FIELDS) expect({ field, value: inV2(entry!, field) }).toEqual({ field, value: (raw as V1)[field] });
    expect(entry!.ext).toEqual({});
  });

  test("a v1 array of several entries keeps them all, in order", () => {
    const raw = PHASES.map((phase, index) => ({ ...v1(phase), requestId: `abcdefghijklmnopqrstuvwxy${"234567"[index]}` }));
    expect(migrated(raw).map((entry) => [entry.requestId, entry.phase])).toEqual(raw.map((item, index) => [item.requestId, PHASES[index]]));
  });
});

describe("a migrated pending approval resumes from its phase to completion", () => {
  /** A scripted OpenKey and a fake clock; the store holds the migrated v2 entry. */
  function resume(entry: ApprovalEntry) {
    let t = NOW;
    let stored: ApprovalEntry | undefined = entry;
    const log: string[] = [];
    const answers: Record<"discover" | "fetch" | "ack", Reply> = {
      discover: { kind: "ready", resultRef: RESULT_REF, resultExpiresAt: RESULT_EXPIRES },
      fetch: { kind: "envelope", envelope: { relay: "opaque-ciphertext" } },
      ack: { kind: "acked" },
    };
    const call = (kind: "discover" | "fetch" | "ack") => async (): Promise<CallResult> => { log.push(kind); t += 50; return { reply: answers[kind] }; };
    const io: ApprovalDriverIo = {
      store: { read: async () => stored, write: async (next) => { stored = next; }, remove: async () => { stored = undefined; } },
      transport: { discover: call("discover"), fetch: call("fetch"), ack: call("ack") },
      verify: async () => { log.push("verify"); return "ok"; },
      commit: async () => { log.push("commit"); },
      now: () => t,
      sleep: async (ms) => { t += ms; },
    };
    return { run: () => driveApproval(io, entry.requestId), log, stored: () => stored };
  }

  const EXPECTED: Record<(typeof PHASES)[number], string[]> = {
    open: ["discover", "fetch", "verify", "commit", "ack"],
    discovered: ["fetch", "verify", "commit", "ack"],
    fetched: ["verify", "commit", "ack"],
    committed: ["ack"],
  };

  test.each(PHASES)("phase %s: the next run picks up where v1 left off and completes (exit 0)", async (phase) => {
    const [entry] = migrated([v1(phase)]);
    const h = resume(entry!);
    const result = await h.run();
    expect(result).toMatchObject({ outcome: { kind: "completed" }, exitCode: 0 });
    expect(h.log).toEqual(EXPECTED[phase]);
    expect(h.stored()).toBeUndefined();
  });
});
