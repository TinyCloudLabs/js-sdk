import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLIError as CLIErrorInstance } from "../output/errors.js";

// The profile store and its lock are real; TC_HOME is read when the store
// loads, so set it before importing. The store signals lock contention only
// under NODE_ENV=test.
const home = await mkdtemp(join(tmpdir(), "tc-sdk-bootstrap-"));
process.env.TC_HOME = home;
process.env.NODE_ENV = "test";

// Restoring the session into a node is not under test.
let restoreFailure: Error | null = null;
mock.module("@tinycloud/node-sdk", () => ({
  TinyCloudNode: class {
    async restoreSession() {
      if (restoreFailure) throw restoreFailure;
    }
  },
}));
mock.module("./permissions.js", () => ({
  replayAdditionalDelegations: async () => {},
}));

// Imported after TC_HOME and the module mocks above are in place.
const { ProfileManager } = await import("../config/profiles.js");
const { PROFILES_DIR } = await import("../config/constants.js");
const { CLIError } = await import("../output/errors.js");
const { bootstrapDelegatedSession } = await import("./sdk.js");

const PROFILE = "delegate";
const SESSION_DID = "did:key:zDelegate";
const KEY = { kty: "OKP", crv: "Ed25519", x: "key-public", d: "key-private" };
const ctx = { profile: PROFILE, host: "https://node.tinycloud.test", verbose: false, noCache: false, quiet: false };
const delegation = {
  delegationHeader: { Authorization: "Bearer delegated" },
  cid: "bafy-bootstrap",
  spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
  delegateDID: `${SESSION_DID}#zDelegate`,
  ownerAddress: "0xowner",
  chainId: 1,
} as never;
const fresh = {
  name: PROFILE,
  host: ctx.host,
  chainId: 1,
  spaceName: "default",
  did: SESSION_DID,
  sessionDid: SESSION_DID,
  posture: "delegate-session" as const,
  operatorType: "agent" as const,
  authMethod: "openkey" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
};

let contentions = 0;

/** Resolves once a writer in this process finds the profile lock held. */
function contention(): Promise<void> {
  const signal = join(home, `contended-${++contentions}`);
  process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = signal;
  return (async () => {
    while (!await stat(signal).then(() => true, () => false)) { /* each stat yields to the writer */ }
  })();
}

/**
 * Another writer's critical section: holds the lock until `finish` is called,
 * then runs `write` before releasing it.
 */
async function holdLock(write: () => Promise<void>): Promise<{ finish: () => Promise<void> }> {
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const holding = ProfileManager.withLock(PROFILE, async () => {
    entered.resolve();
    await proceed.promise;
    await write();
  });
  await entered.promise;
  return {
    finish: async () => {
      proceed.resolve();
      await holding;
    },
  };
}

beforeEach(async () => {
  restoreFailure = null;
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await ProfileManager.setProfile(PROFILE, fresh);
  await ProfileManager.setKey(PROFILE, KEY);
});

afterAll(async () => {
  delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  await rm(home, { recursive: true, force: true });
});

describe("bootstrapDelegatedSession under the profile lock", () => {
  test("reads the key under the lock: a key rotation holding it is not overwritten with the old key", async () => {
    const rotated = { ...KEY, x: "rotated-public", d: "rotated-private" };
    const rotation = await holdLock(() => ProfileManager.setKey(PROFILE, rotated));
    const contended = contention();
    const bootstrapping = bootstrapDelegatedSession(ctx, delegation);
    await contended;
    await rotation.finish();
    await bootstrapping;

    expect(await ProfileManager.getSession(PROFILE)).toMatchObject({ delegationCid: "bafy-bootstrap", jwk: rotated });
  });

  test("never replaces a session that appeared after the caller checked for one", async () => {
    const appeared = { delegationCid: "bafy-other-login", spaceId: "space-other" };
    await ProfileManager.setSession(PROFILE, appeared);

    await expect(bootstrapDelegatedSession(ctx, delegation)).rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_IMPORT" });
    expect(await ProfileManager.getSession(PROFILE)).toEqual(appeared);
    expect(await ProfileManager.getProfile(PROFILE)).toEqual(fresh);
  });

  test("abandon restores the pre-bootstrap state when nothing changed since", async () => {
    const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
    expect(await ProfileManager.getProfile(PROFILE)).toMatchObject({ spaceId: "tinycloud:pkh:eip155:1:0xowner:default" });
    const cause = new Error("import rejected");

    await expect(bootstrap.abandon(cause)).rejects.toBe(cause);
    expect(await ProfileManager.getSession(PROFILE)).toBeNull();
    expect(await ProfileManager.getProfile(PROFILE)).toEqual(fresh);
  });

  test("abandon keeps a newer session and profile committed while the import was pending, and says so", async () => {
    const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
    const newerSession = { delegationCid: "bafy-newer-login", spaceId: "tinycloud:pkh:eip155:1:0xowner:default" };
    const newerProfile = { ...await ProfileManager.getProfile(PROFILE), defaultSpace: "photos" };
    const login = await holdLock(async () => {
      await ProfileManager.setSession(PROFILE, newerSession);
      await ProfileManager.setProfile(PROFILE, newerProfile);
    });
    const contended = contention();
    const abandoning = bootstrap.abandon(new CLIError("DELEGATION_REJECTED", "The delegation exceeds the stored authority request.", 1));
    await contended;
    await login.finish();

    const error = await abandoning.catch((cause: unknown) => cause as CLIErrorInstance);
    expect(error).toMatchObject({ code: "DELEGATION_REJECTED", exitCode: 1 });
    expect(error.message).toContain("The delegation exceeds the stored authority request.");
    expect(error.message).toContain("its newer state was kept");
    expect(await ProfileManager.getSession(PROFILE)).toEqual(newerSession);
    expect(await ProfileManager.getProfile(PROFILE)).toEqual(newerProfile);
  });

  test("abandon rolls back when only an unrelated profile field changed meanwhile, and keeps that change", async () => {
    const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
    // `tc profile set-default-space` while the import was pending.
    await ProfileManager.updateProfile(PROFILE, (profile) => ({ ...profile, defaultSpace: "photos" }));
    const cause = new Error("import rejected");

    await expect(bootstrap.abandon(cause)).rejects.toBe(cause);
    expect(await ProfileManager.getSession(PROFILE)).toBeNull();
    expect(await ProfileManager.getProfile(PROFILE)).toEqual({ ...fresh, defaultSpace: "photos" });
  });

  test("a rollback note never quotes the contents of a malformed session file", async () => {
    const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
    await writeFile(join(PROFILES_DIR, PROFILE, "session.json"), '{"jwk": {"d": privateScalarMaterial}}');

    const error = await bootstrap.abandon(new CLIError("DELEGATION_REJECTED", "The delegation exceeds the stored authority request.", 1))
      .catch((cause: unknown) => cause as CLIErrorInstance);
    expect(error).toMatchObject({ code: "DELEGATION_REJECTED", exitCode: 1 });
    expect(error.message).toContain("could not run (a profile file is not valid JSON)");
    expect(error.message).not.toContain("privateScalarMaterial");
  });

  test("a rollback that cannot run still reports the import's error, with a note", async () => {
    const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
    const provisional = await ProfileManager.getSession(PROFILE);
    await writeFile(join(PROFILES_DIR, PROFILE, "profile.json"), "{ not json");

    const error = await bootstrap.abandon(new CLIError("DELEGATION_REJECTED", "The delegation exceeds the stored authority request.", 1))
      .catch((cause: unknown) => cause as CLIErrorInstance);
    expect(error).toMatchObject({ code: "DELEGATION_REJECTED", exitCode: 1 });
    expect(error.message).toContain("The delegation exceeds the stored authority request.");
    expect(error.message).toContain("could not run");
    expect(await ProfileManager.getSession(PROFILE)).toEqual(provisional);
  });

  test("a session that cannot be restored is rolled back by the bootstrap itself", async () => {
    restoreFailure = new Error("invalid delegation");

    await expect(bootstrapDelegatedSession(ctx, delegation)).rejects.toBe(restoreFailure);
    expect(await ProfileManager.getSession(PROFILE)).toBeNull();
    expect(await ProfileManager.getProfile(PROFILE)).toEqual(fresh);
  });
});
