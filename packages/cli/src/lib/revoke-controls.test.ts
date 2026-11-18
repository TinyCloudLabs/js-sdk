import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "tc-revoke-controls-"));
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
process.env.HOME = home;
process.env.TC_HOME = home;
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalTcHome === undefined) delete process.env.TC_HOME; else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

// CLI config paths capture TC_HOME on import, so modules load only after the test home is set.
const { additionalDelegationsPath, profileStoreMetadataPath, readAdditionalDelegations, writeJsonAtomic } = await import("@tinycloud/operations/state");
const { ProfileManager } = await import("../config/profiles.js");
const { appendRevokeControl, findRevokeControl, loadRevokeControls, parseRevokeControl, removeRevokeControl } = await import("./revoke-controls.js");
const { revokeAsDelegate } = await import("../commands/delegation.js");

const AGENT = "did:key:z6MkAgent";
const TARGET = "bafy-granted";
const valid = (overrides: Record<string, unknown> = {}) => ({
  cid: "bafy-control", targetCid: TARGET, delegateDID: AGENT, spaceId: "tinycloud:pkh:eip155:1:0xabc:applications", authorization: "header.payload.signature",
  expiry: new Date(Date.now() + 3_600_000).toISOString(), ...overrides,
});
const ctx = (profile: string) => ({ profile, host: "https://node.example" });

async function holderProfile(name: string) {
  await ProfileManager.ensureProfileDir(name);
  await writeJsonAtomic(additionalDelegationsPath(name), [{ delegation: { cid: TARGET }, permissions: [] }]);
  await writeJsonAtomic(profileStoreMetadataPath(name, "additional-delegations"), { formatVersion: 1 });
  await appendRevokeControl(name, parseRevokeControl(valid(), TARGET)!);
}
const heldGrants = async (name: string) => (await readAdditionalDelegations<{ delegation: { cid: string } }>(name)).map((entry) => entry.delegation.cid);

function nodeAnswering(revoke: unknown, revokeIssued: unknown = { ok: true, data: { cid: TARGET } }) {
  const calls = { revoke: [] as unknown[][], revokeIssued: [] as string[], installed: [] as Array<{ cid: string; expiry: Date }>, order: [] as string[] };
  const node = { installRevokeControl: (control: { cid: string; expiry: Date }) => { calls.installed.push(control); calls.order.push("install"); }, delegationManager: {
    revoke: async (...args: unknown[]) => { calls.revoke.push(args); calls.order.push("revoke"); return revoke; },
    revokeIssued: async (cid: string) => { calls.revokeIssued.push(cid); return revokeIssued; },
  } };
  return { node: node as never, calls };
}

test("a revoke grant is accepted only for the delegation it names and the recipient it was issued to", () => {
  expect(parseRevokeControl(valid(), TARGET, AGENT)).toMatchObject({ cid: "bafy-control", targetCid: TARGET });
  expect(parseRevokeControl(valid({ targetCid: "bafy-other" }), TARGET)).toBeUndefined();
  expect(parseRevokeControl(valid(), TARGET, "did:key:z6MkSomeoneElse")).toBeUndefined();
  expect(parseRevokeControl(valid({ authorization: "" }), TARGET)).toBeUndefined();
  expect(parseRevokeControl(valid({ spaceId: undefined }), TARGET)).toBeUndefined();
  expect(parseRevokeControl(valid({ expiry: "not a date" }), TARGET)).toBeUndefined();
  expect(parseRevokeControl("nope", TARGET)).toBeUndefined();
});

test("a stored revoke grant is found until it ends, and replaced for the same delegation", async () => {
  const profile = "controls-store";
  await ProfileManager.ensureProfileDir(profile);
  await appendRevokeControl(profile, parseRevokeControl(valid({ cid: "first" }), TARGET)!);
  await appendRevokeControl(profile, parseRevokeControl(valid({ cid: "second" }), TARGET)!);
  expect((await loadRevokeControls(profile)).map((control) => control.cid)).toEqual(["second"]);
  expect((await findRevokeControl(profile, TARGET))?.cid).toBe("second");
  expect(await findRevokeControl(profile, "bafy-unrelated")).toBeUndefined();
  await appendRevokeControl(profile, parseRevokeControl(valid({ cid: "ended", expiry: new Date(Date.now() - 1000).toISOString() }), TARGET)!);
  expect(await findRevokeControl(profile, TARGET)).toBeUndefined();
  await removeRevokeControl(profile, TARGET);
  expect(await loadRevokeControls(profile)).toEqual([]);
});

test("with a stored revoke grant the holder gives the delegation back with it, and its local rows go only after the node's 200", async () => {
  const profile = "holder-ok";
  await holderProfile(profile);
  const { node, calls } = nodeAnswering({ ok: true, data: { cid: TARGET } });
  expect(await revokeAsDelegate(node, ctx(profile), TARGET)).toMatchObject({ cid: TARGET, revoked: true, authority: "revoke-grant" });
  expect(calls.revoke).toEqual([[TARGET, { authorityCid: "bafy-control" }]]);
  expect(calls.order).toEqual(["install", "revoke"]);
  expect(calls.installed[0]).toMatchObject({ cid: "bafy-control", expiry: expect.any(Date) });
  expect(calls.revokeIssued).toEqual([]);
  expect(await heldGrants(profile)).toEqual([]);
  expect(await loadRevokeControls(profile)).toEqual([]);
});

for (const [label, answer, code] of [
  ["a refusal", { ok: false, error: { code: "PERMISSION_DENIED", message: "Unauthorized Revoker", meta: { status: 403 } } }, "REVOKE_UNAUTHORIZED"],
  ["a network failure", { ok: false, error: { code: "NETWORK_ERROR", message: "connection reset" } }, "NETWORK_ERROR"],
] as const) {
  test(`${label} from the node keeps the stored grant and the revoke grant, so the holder can retry`, async () => {
    const profile = `holder-${code.toLowerCase()}`;
    await holderProfile(profile);
    const { node } = nodeAnswering(answer);
    await expect(revokeAsDelegate(node, ctx(profile), TARGET)).rejects.toMatchObject({ code });
    expect(await heldGrants(profile)).toEqual([TARGET]);
    expect((await loadRevokeControls(profile)).map((control) => control.targetCid)).toEqual([TARGET]);
  });
}

test("a delegation the node no longer has clears the stale local rows, so the holder is not left with a record that cannot be revoked", async () => {
  const profile = "holder-gone";
  await holderProfile(profile);
  const { node } = nodeAnswering({ ok: false, error: { code: "NOT_FOUND", message: "gone" } });
  expect(await revokeAsDelegate(node, ctx(profile), TARGET)).toMatchObject({ cid: TARGET, revoked: true, authority: "revoke-grant", alreadyGone: true });
  expect(await heldGrants(profile)).toEqual([]);
  expect(await loadRevokeControls(profile)).toEqual([]);
});

test("without a stored revoke grant the holder falls back to revoking what its own key issued", async () => {
  const profile = "holder-none";
  await ProfileManager.ensureProfileDir(profile);
  const { node, calls } = nodeAnswering({ ok: true, data: {} });
  expect(await revokeAsDelegate(node, ctx(profile), TARGET)).toEqual({ cid: TARGET, revoked: true });
  expect(calls.revokeIssued).toEqual([TARGET]);
  expect(calls.revoke).toEqual([]);
});
