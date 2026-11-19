import { expect, test } from "bun:test";
import { APPROVAL_FILE, loadApprovalFiles, serializeApprovalFile } from "../src/links/index.js";
import { RELAY_KEY, T0, entryIn } from "./approval-machine-fixtures.js";

// TC-2377 ruling: a tc that predates `approval-pending.v2.json` signs out by deleting only `approval-pending.json`, so the v2 file
// and its keys outlive that logout. The next load of a signed-out profile discards every request made before the sign-out; a
// request made since (a sign-in in progress on that profile) is kept, and a signed-in profile keeps everything.

const NOW = T0 + 60_000;
const before = { ...entryIn("open", { requestId: "abcdefghijklmnopqrstuvwxb2" }), createdAt: new Date(T0).toISOString() };
const since = { ...entryIn("open", { requestId: "abcdefghijklmnopqrstuvwxc3" }), createdAt: new Date(T0 + 30_000).toISOString() };
const v2 = JSON.parse(serializeApprovalFile({ version: 2, entries: [before, since], unrecognized: [{ raw: { relayPrivateKey: RELAY_KEY }, quarantinedAt: new Date(T0).toISOString() }] }));

test("signed out: requests from before the sign-out are discarded with their keys; signed in: every request is kept", () => {
  const signedOut = loadApprovalFiles({ v2 }, { now: NOW, signedOutAt: T0 + 10_000 });
  if (signedOut.kind !== "ok") throw new Error(signedOut.kind);
  expect(signedOut.discarded).toEqual([before.requestId]);
  expect(signedOut.file.entries.map((entry) => entry.requestId)).toEqual([since.requestId]);
  expect(signedOut.file.unrecognized).toEqual([]);
  expect(signedOut.ops).toEqual([{ op: "write", name: APPROVAL_FILE }]);
  // What the adapter writes holds no key of a discarded request.
  const written = serializeApprovalFile(signedOut.file);
  expect(written).not.toContain(before.requestId);
  expect(written.split(RELAY_KEY)).toHaveLength(2);

  // Signed out with no recorded time (a tc that predates the v2 file signed out): the adapter passes now, so every request goes.
  const unrecorded = loadApprovalFiles({ v2 }, { now: NOW, signedOutAt: NOW });
  if (unrecorded.kind !== "ok") throw new Error(unrecorded.kind);
  expect(unrecorded.discarded).toEqual([before.requestId, since.requestId]);
  expect(unrecorded.file).toEqual({ version: 2, entries: [], unrecognized: [] });
  expect(unrecorded.ops).toEqual([{ op: "write", name: APPROVAL_FILE }]);
  expect(serializeApprovalFile(unrecorded.file)).not.toContain(RELAY_KEY);

  const signedIn = loadApprovalFiles({ v2 }, { now: NOW });
  if (signedIn.kind !== "ok") throw new Error(signedIn.kind);
  expect(signedIn.discarded).toEqual([]);
  expect(signedIn.file.entries.map((entry) => entry.requestId)).toEqual([before.requestId, since.requestId]);
  expect(signedIn.file.unrecognized).toHaveLength(1);
  expect(signedIn.ops).toEqual([]);
});

test("signed out: a request whose creation time is missing or unreadable counts as before the sign-out and is discarded", () => {
  const { createdAt: _createdAt, ...noCreatedAt } = JSON.parse(JSON.stringify(since)) as Record<string, unknown>;
  const unreadable = ["garbage", "NaN", "2026-13-45T99:00:00.000Z", "", 1_763_500_000_000, null];
  const raw = {
    version: 2,
    entries: [
      { ...noCreatedAt, requestId: "abcdefghijklmnopqrstuvwxd4" },
      ...unreadable.map((createdAt, index) => ({ ...noCreatedAt, requestId: `abcdefghijklmnopqrstuvwx${"efghij"[index]}5`, createdAt })),
      JSON.parse(JSON.stringify(since)),
    ],
    // Set aside after the sign-out: its creation time is still unknown.
    unrecognized: [{ raw: { relayPrivateKey: RELAY_KEY, createdAt: "garbage" }, quarantinedAt: new Date(T0 + 40_000).toISOString() }],
  };
  const signedOutAt = T0 + 10_000;
  const signedOut = loadApprovalFiles({ v2: raw }, { now: NOW, signedOutAt });
  if (signedOut.kind !== "ok") throw new Error(signedOut.kind);
  expect(signedOut.file.entries.map((entry) => entry.requestId)).toEqual([since.requestId]);
  expect(signedOut.file.unrecognized).toEqual([]);
  expect(signedOut.ops).toEqual([{ op: "write", name: APPROVAL_FILE }]);
  // Only the request made since keeps a key in what the adapter writes.
  expect(serializeApprovalFile(signedOut.file).split(RELAY_KEY)).toHaveLength(2);

  // Signed in, the same file loses nothing: the unreadable entries are set aside, not dropped.
  const signedIn = loadApprovalFiles({ v2: raw }, { now: NOW });
  if (signedIn.kind !== "ok") throw new Error(signedIn.kind);
  expect(signedIn.file.entries.map((entry) => entry.requestId)).toEqual([since.requestId]);
  expect(signedIn.file.unrecognized).toHaveLength(1 + unreadable.length + 1);
});
