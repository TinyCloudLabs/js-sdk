import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSpaceId, signEthereumMessage } from "@tinycloud/node-sdk-wasm";
import { buildExactAppKeyProof, prepareExactAppKeyRequest } from "@tinycloud/node-sdk/encryption-keys";
import { profilePath } from "@tinycloud/operations/state";
import { writeJsonDurable } from "../config/storage.js";
import { loadAppKeyPermit, removeAppKeyPermit, verifiedSavedAppKey, type AppKeyPermit } from "./app-key.js";

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
  const file = join(profilePath(PROFILE), "app-key-permit.json");
  await writeJsonDurable(file, value);
  return file;
}

const realFetch = globalThis.fetch;
let fetches: string[];
beforeEach(() => {
  fetches = [];
  globalThis.fetch = ((input: unknown) => {
    fetches.push(String(input));
    return Promise.reject(new Error("no network in this test"));
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await removeAppKeyPermit(PROFILE);
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
