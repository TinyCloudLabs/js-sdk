import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "tc-give-back-not-found-"));
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
const { appendRevokeControl, loadRevokeControls, parseRevokeControl, delegateWithGiveBack, shellWord, WALLET_DID_WARNING } = await import("./revoke-controls.js");
const { revokeAsDelegate } = await import("../commands/delegation.js");

const AGENT = "did:key:z6MkAgent";
const TARGET = "bafy-granted";
const ctx = (profile: string) => ({ profile, host: "https://node.example" });

async function holderProfile(name: string) {
  await ProfileManager.ensureProfileDir(name);
  await writeJsonAtomic(additionalDelegationsPath(name), [{ delegation: { cid: TARGET }, permissions: [] }]);
  await writeJsonAtomic(profileStoreMetadataPath(name, "additional-delegations"), { formatVersion: 1 });
  await appendRevokeControl(name, parseRevokeControl({
    cid: "bafy-control", targetCid: TARGET, delegateDID: AGENT, spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
    authorization: "header.payload.signature", expiry: new Date(Date.now() + 3_600_000).toISOString(),
  }, TARGET)!);
}
const heldGrants = async (name: string) => (await readAdditionalDelegations<{ delegation: { cid: string } }>(name)).map((entry) => entry.delegation.cid);

function nodeWithStatus(status: unknown) {
  return {
    installRevokeControl: () => undefined,
    delegationManager: {
      revoke: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Not Found", meta: { status: 404 } } }),
      status: async () => status,
    },
  } as never;
}

for (const [label, status] of [
  ["says the delegation is still active", { ok: true, data: { cid: TARGET, status: "active" } }],
  ["has no record of it either", { ok: true, data: { cid: TARGET, status: "not_found" } }],
  ["cannot be asked", { ok: false, error: { code: "NETWORK_ERROR", message: "connection reset" } }],
] as const) {
  test(`a give-back answered "not found" keeps the stored grant and the revoke grant when the node ${label}`, async () => {
    const profile = `holder-404-${label.length}`;
    await holderProfile(profile);
    await expect(revokeAsDelegate(nodeWithStatus(status), ctx(profile), TARGET)).rejects.toMatchObject({
      code: "GIVE_BACK_NOT_CONFIRMED",
      message: `The node answered "not found" when giving back ${TARGET}, so this access may still be active. Nothing was removed from this profile. Try again, and check that --host is the node that issued it.`,
    });
    expect(await heldGrants(profile)).toEqual([TARGET]);
    expect((await loadRevokeControls(profile)).map((control) => control.targetCid)).toEqual([TARGET]);
  });
}

test("a give-back answered \"not found\" for a delegation the node reports as expired clears the local rows", async () => {
  const profile = "holder-expired";
  await holderProfile(profile);
  expect(await revokeAsDelegate(nodeWithStatus({ ok: true, data: { cid: TARGET, status: "expired" } }), ctx(profile), TARGET))
    .toMatchObject({ cid: TARGET, revoked: true, authority: "revoke-grant", alreadyGone: true });
  expect(await heldGrants(profile)).toEqual([]);
  expect(await loadRevokeControls(profile)).toEqual([]);
});

test("a feed connection to an agent with a wallet DID is made without the give-back grant and prints the one warning", async () => {
  const calls: Array<{ to: string; holderMayRevoke?: boolean }> = [];
  const node = { delegateTo: async (to: string, _permissions: unknown, options?: { holderMayRevoke?: boolean }) => {
    calls.push({ to, holderMayRevoke: options?.holderMayRevoke });
    return { delegation: { cid: "bafy-live", delegateDID: to } };
  } } as never;
  const warnings: string[] = [];
  const wallet = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
  const granted = await delegateWithGiveBack(
    node, wallet, [], { expiry: 24 * 60 * 60 * 1000, requireActivation: true },
    (name) => `tinycloud feed disconnect --agent ${shellWord(name)}`, async () => undefined, (line) => warnings.push(line),
  );
  expect(granted).toEqual({ delegation: { cid: "bafy-live", delegateDID: wallet } });
  expect(calls).toEqual([{ to: wallet, holderMayRevoke: undefined }]);
  expect(warnings).toEqual([
    "This agent has a wallet DID, so it can't be given a grant to hand back its own access. The connection works, and you can revoke it yourself:\n  tinycloud feed disconnect --agent bafy-live",
  ]);
  expect(warnings[0]).toBe(WALLET_DID_WARNING("tinycloud feed disconnect --agent bafy-live"));
});
