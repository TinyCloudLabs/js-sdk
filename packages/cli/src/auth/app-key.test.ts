import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSpaceId, signEthereumMessage } from "@tinycloud/node-sdk-wasm";
import { buildExactAppKeyProof, prepareExactAppKeyRequest, type ExactAppKeyClient } from "@tinycloud/node-sdk/encryption-keys";
import { profilePath } from "@tinycloud/operations/state";
import { writeJsonDurable } from "../config/storage.js";
import { loadAppKeyPermit, removeAppKeyPermit, verifiedSavedAppKey, type AppKeyPermit } from "./app-key.js";
import * as encryptionKeys from "@tinycloud/node-sdk/encryption-keys";
import * as preparedOpenKey from "./prepared-openkey.js";
import { ProfileManager } from "../config/profiles.js";
import { clearProfileCredentials } from "../lib/logout-pending.js";
import { loginWithAppKey, openVerifiedAppKey } from "./app-key.js";

// Published disposable key; never holds funds or data.
const PRIVATE_KEY = "11".repeat(32);
const ADDRESS = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const OWNER = `did:pkh:eip155:1:${ADDRESS}`;
const KEY = "apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/seal-v1";
const SIBLING = "apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/other";
const HOST = "http://127.0.0.1:41000";
const PROFILE = "app-key-test";

function permit(lifetimeMs = 3_600_000): AppKeyPermit {
  const built = prepareExactAppKeyRequest(KEY, OWNER, lifetimeMs);
  const siwe = built.request.requestedSiwe;
  const signature = `0x${signEthereumMessage(siwe, PRIVATE_KEY).replace(/^0x/, "")}`;
  const proof = buildExactAppKeyProof(built, { signedMessage: siwe, signature, address: ADDRESS });
  expect(built.spaceId).toBe(makeSpaceId(ADDRESS, 1, "default"));
  const { optIn: _optIn, ...request } = built.request;
  return { version: 1, host: HOST, request, proof };
}

async function save(value: unknown): Promise<string> {
  await mkdir(profilePath(PROFILE), { recursive: true, mode: 0o700 });
  await ProfileManager.setProfile(PROFILE, {
    name: PROFILE, host: HOST, chainId: 1, spaceName: "default",
    did: OWNER, createdAt: new Date().toISOString(),
  });
  await ProfileManager.setKey(PROFILE, { kty: "OKP", fixture: true });
  const file = join(profilePath(PROFILE), "app-key-permit.json");
  await writeJsonDurable(file, value);
  return file;
}

const realFetch = globalThis.fetch;
let fetches: string[];
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  fetches = [];
  globalThis.fetch = ((input: unknown) => {
    fetches.push(String(input));
    return Promise.reject(new Error("no network in this test"));
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const spy of spies.splice(0)) spy.mockRestore();
  await removeAppKeyPermit(PROFILE);
  await ProfileManager.removeKey(PROFILE);
  await ProfileManager.clearSession(PROFILE);
  await ProfileManager.removeProfileConfig(PROFILE);
});

describe("saved app-key approval", () => {
  test("a profile with no approval has none and cannot use a key", async () => {
    expect(await loadAppKeyPermit(PROFILE)).toBeUndefined();
    await expect(verifiedSavedAppKey(PROFILE, HOST, KEY)).rejects.toMatchObject({ code: "KEYS_NOT_GRANTED" });
  });

  test("the saved approval verifies for its own key on its own node, with no network", async () => {
    const file = await save(permit());
    const approval = await verifiedSavedAppKey(PROFILE, HOST, KEY);
    expect(approval.ownerDid).toBe(OWNER);
    expect(approval.request.path).toBe(KEY);
    expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o600);
    expect(fetches).toEqual([]);
  });

  test("another key, a prefix of it or a folder is refused before any network", async () => {
    await save(permit());
    for (const other of [SIBLING, `${KEY}x`, KEY.slice(0, -1), "apps/xyz.tinycloud.share/", "qa/note"]) {
      await expect(verifiedSavedAppKey(PROFILE, HOST, other)).rejects.toMatchObject({ code: "KEY_OUTSIDE_GRANTED_PREFIX" });
    }
    expect(fetches).toEqual([]);
  });

  test("another node is refused before any network", async () => {
    await save(permit());
    await expect(verifiedSavedAppKey(PROFILE, "http://127.0.0.1:41001", KEY)).rejects.toMatchObject({ code: "APP_KEY_HOST_MISMATCH" });
    await expect(verifiedSavedAppKey(PROFILE, "https://node.tinycloud.xyz", KEY)).rejects.toMatchObject({ code: "APP_KEY_HOST_MISMATCH" });
    expect(fetches).toEqual([]);
  });

  test("an expired approval is reported as expired", async () => {
    await save(permit());
    setSystemTime(new Date(Date.now() + 2 * 3_600_000));
    try {
      await expect(verifiedSavedAppKey(PROFILE, HOST, KEY)).rejects.toMatchObject({ code: "APP_KEY_EXPIRED" });
    } finally {
      setSystemTime();
    }
  });

  test("an approval whose signed bytes or ids were changed does not verify", async () => {
    const good = permit();
    const otherSigner = signEthereumMessage(good.proof.siwe, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    for (const change of [
      { proof: { ...good.proof, delegationCid: `${good.proof.delegationCid.slice(0, -2)}aa` } },
      { proof: { ...good.proof, signature: `0x${otherSigner.replace(/^0x/, "")}` } },
      { request: { ...good.request, ownerDid: "did:pkh:eip155:1:0x0123456789abcdef0123456789abcdef01234567" } },
    ]) {
      await save({ ...good, ...change });
      await expect(verifiedSavedAppKey(PROFILE, HOST, KEY)).rejects.toMatchObject({ code: "APP_KEY_PERMIT_INVALID" });
    }
    expect(fetches).toEqual([]);
  });

  test("a damaged or loosely protected file is never used", async () => {
    const file = await save(permit());
    await chmod(file, 0o644);
    await expect(loadAppKeyPermit(PROFILE)).rejects.toMatchObject({ code: "APP_KEY_PERMIT_INVALID" });
    await removeAppKeyPermit(PROFILE);
    await writeFile(file, "{ not json", { mode: 0o600 });
    await expect(loadAppKeyPermit(PROFILE)).rejects.toMatchObject({ code: "APP_KEY_PERMIT_INVALID" });
    await removeAppKeyPermit(PROFILE);
    await save({ version: 2, host: HOST });
    await expect(loadAppKeyPermit(PROFILE)).rejects.toMatchObject({ code: "APP_KEY_PERMIT_INVALID" });
  });

  test("a symbolic link in place of the file is never followed", async () => {
    const target = await save(permit());
    await removeAppKeyPermit(PROFILE);
    await symlink(target.replace("app-key-permit.json", "elsewhere.json"), target);
    await expect(loadAppKeyPermit(PROFILE)).rejects.toMatchObject({ code: "APP_KEY_PERMIT_INVALID" });
  });

  test("removing the approval leaves the profile with none", async () => {
    await save(permit());
    await removeAppKeyPermit(PROFILE);
    expect(await loadAppKeyPermit(PROFILE)).toBeUndefined();
    await removeAppKeyPermit(PROFILE);
  });
});


describe("app-key approval lifecycle", () => {
  async function pendingLogin(delay: "approval" | "delegate", signedOut = false) {
    await save(permit());
    await removeAppKeyPermit(PROFILE);
    if (signedOut) await clearProfileCredentials(PROFILE, true);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    globalThis.fetch = (async () => Response.json({ features: ["encryption-named-keys-v1"] })) as typeof fetch;
    spies.push(spyOn(preparedOpenKey, "startPreparedOpenKeyHandoff").mockImplementation(async ({ prepared }) => ({
      result: (async () => {
        if (delay === "approval") { reached.resolve(); await release.promise; }
        return {
          signedMessage: prepared.siwe,
          signature: `0x${signEthereumMessage(prepared.siwe, PRIVATE_KEY).replace(/^0x/, "")}`,
          address: ADDRESS,
        };
      })(),
      complete: async () => {},
    })));
    spies.push(spyOn(encryptionKeys, "openExactAppKeyClient").mockImplementation(async () => {
      if (delay === "delegate") { reached.resolve(); await release.promise; }
      return {} as ExactAppKeyClient;
    }));
    const login = loginWithAppKey({
      profileName: PROFILE, host: HOST, openKeyHost: "https://openkey.test",
      ownerDid: OWNER, fullKey: KEY, lifetimeMs: undefined, registryUrl: undefined,
      paste: true, noPopup: true, ensureProfile: async () => {
        if (await ProfileManager.getStoredKey(PROFILE) === null) {
          await ProfileManager.setKey(PROFILE, { kty: "OKP", fixture: true });
        }
      },
    });
    const settled = login.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    await reached.promise;
    return { settled, release };
  }

  for (const delay of ["approval", "delegate"] as const) {
    test(`a delayed ${delay} cannot restore a permit after logout and key shred`, async () => {
      const pending = await pendingLogin(delay);
      await clearProfileCredentials(PROFILE, true);
      pending.release.resolve();
      expect((await pending.settled).ok).toBe(false);
      expect(await loadAppKeyPermit(PROFILE)).toBeUndefined();
      await expect(verifiedSavedAppKey(PROFILE, HOST, KEY)).rejects.toBeDefined();
      expect(await ProfileManager.getStoredKey(PROFILE)).toBeNull();
    });
  }

  test("a concurrent ordinary login invalidates the dedicated-profile approval", async () => {
    const pending = await pendingLogin("delegate");
    await ProfileManager.updateProfile(PROFILE, (profile) => ({ ...profile, authMethod: "local-key", ownerDid: OWNER }));
    pending.release.resolve();
    expect((await pending.settled).ok).toBe(false);
    expect(await loadAppKeyPermit(PROFILE)).toBeUndefined();
  });

  test("logout fences both a saved permit and an already verified reopen", async () => {
    await save(permit());
    const verified = await verifiedSavedAppKey(PROFILE, HOST, KEY);
    await clearProfileCredentials(PROFILE, true);
    await expect(verifiedSavedAppKey(PROFILE, HOST, KEY)).rejects.toBeDefined();
    await expect(openVerifiedAppKey(verified, undefined)).rejects.toBeDefined();
    expect(fetches).toEqual([]);
  });

  test("a fresh explicit approval can durably replace the signed-out fence", async () => {
    const pending = await pendingLogin("delegate", true);
    expect((await ProfileManager.getProfile(PROFILE)).authSignedOut).toBe(true);
    pending.release.resolve();
    expect((await pending.settled).ok).toBe(true);
    expect((await ProfileManager.getProfile(PROFILE)).authSignedOut).toBe(false);
    expect((await verifiedSavedAppKey(PROFILE, HOST, KEY)).ownerDid).toBe(OWNER);
  });

  test("profile deletion and recreation cannot adopt an old approval", async () => {
    const pending = await pendingLogin("delegate");
    await ProfileManager.deleteProfile(PROFILE);
    await save(permit());
    await removeAppKeyPermit(PROFILE);
    pending.release.resolve();
    expect((await pending.settled).ok).toBe(false);
    expect(await loadAppKeyPermit(PROFILE)).toBeUndefined();
  });
});
