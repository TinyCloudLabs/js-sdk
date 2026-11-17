import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";

// TC-3204: OpenKey's device sign-in decrypts only exact shared files (space default, path share/<id>), at most
// DEVICE_MAX_SHARE_DECRYPTS per request. The CLI refuses everything wider before it contacts OpenKey.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-share-decrypt-"));
process.env.TC_HOME = home;
// TC_HOME is read when the profile store loads, so import the CLI modules afterwards.
const { DEVICE_MAX_SHARE_DECRYPTS, deviceRefusal, isDeviceShareDecrypt } = await import("../lib/raw-encryption.js");
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");

const DECRYPT = "tinycloud.encryption/decrypt";
const ids = ["3f9c1a7e5b2d48a09c6e1f7a2b4d8c03", "9b0e4d2c7a1f48e3b5c6d7e8f9a0b1c2", "c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2", "1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5a6b", "aaaabbbbccccddddeeeeffff00001111"];
const leaf = (path: string): PermissionEntry => ({ service: "tinycloud.encryption", space: "default", path, actions: [DECRYPT] });
const key = JSON.parse(new NodeWasmBindings().createSessionManager().jwk("default")!) as Record<string, string>;

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

const wider: Array<[string, string]> = [
  ["the whole default network (empty path)", ""],
  ["the share/ prefix", "share/"],
  ["a key below a shared file", `share/${ids[0]}/x`],
  ["another prefix", "notes/"],
  ["an apps/ key", "apps/xyz.tinycloud.listen/k"],
  ["an id in capitals", `share/${ids[0]!.toUpperCase()}`],
  ["the network URN", "urn:tinycloud:encryption:did:pkh:eip155:1:0x00000000000000000000000000000000000000aa:default"],
];

describe("device shared-file decrypt (TC-3204)", () => {
  test.each(wider)("refuses decrypt on %s", (_name, path) => {
    expect(isDeviceShareDecrypt(leaf(path))).toBe(false);
    expect(deviceRefusal([leaf(path)])).toEqual(leaf(path));
  });

  test(`accepts up to ${DEVICE_MAX_SHARE_DECRYPTS} shared files and refuses the next`, () => {
    const allowed = ids.slice(0, DEVICE_MAX_SHARE_DECRYPTS).map((id) => leaf(`share/${id}`));
    expect(deviceRefusal(allowed)).toBeUndefined();
    const extra = leaf(`share/${ids[DEVICE_MAX_SHARE_DECRYPTS]}`);
    expect(deviceRefusal([...allowed, extra])).toEqual(extra);
  });

  test("refuses the whole default network before contacting OpenKey", async () => {
    let contacted = 0;
    const fetchFn = (async () => { contacted += 1; return new Response(null, { status: 500 }); }) as unknown as typeof globalThis.fetch;
    await expect(acquireDeviceDelegation({
      sessionDid: keyToDID(key), jwk: key, nodeOrigin: "https://tee.node.tinycloud.xyz", shareOrigin: "https://share.tinycloud.xyz",
      permissions: [leaf("")], fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_UNSUPPORTED_SCOPE" });
    expect(contacted).toBe(0);
  });
});
