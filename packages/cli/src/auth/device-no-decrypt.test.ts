import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";

// TC-3204: OpenKey's device sign-in grants no encryption ability. The CLI refuses every tinycloud.encryption entry,
// under its full or short service name in any case, before it contacts OpenKey.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-no-decrypt-"));
process.env.TC_HOME = home;
// TC_HOME is read when the profile store loads, so import the CLI modules afterwards.
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");
const { deviceRefusal } = await import("../lib/raw-encryption.js");

const DECRYPT = "tinycloud.encryption/decrypt";
const decrypt: PermissionEntry = { service: "tinycloud.encryption", space: "default", path: "", actions: [DECRYPT] };
const kv: PermissionEntry = { service: "tinycloud.kv", space: "default", path: "notes/", actions: ["tinycloud.kv/get"] };
const key = JSON.parse(new NodeWasmBindings().createSessionManager().jwk("default")!) as Record<string, string>;

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

const entries: Array<[string, PermissionEntry]> = [
  ["the whole default network (empty path)", decrypt],
  ["one shared file", { ...decrypt, path: "share/3f9c1a7e5b2d48a09c6e1f7a2b4d8c03" }],
  ["the share/ prefix", { ...decrypt, path: "share/" }],
  ["key.create", { ...decrypt, actions: ["tinycloud.encryption/key.create"] }],
];

// acquireDeviceDelegation refuses these spellings earlier (INVALID_LOGIN_SCOPE); deviceRefusal refuses them on its own too.
const spellings: Array<[string, PermissionEntry]> = [
  ["the short service name", { ...decrypt, service: "encryption" }],
  ["an upper-case service name", { ...decrypt, service: "TINYCLOUD.ENCRYPTION" }],
  ["a mixed-case short service name", { ...decrypt, service: "Encryption" }],
];

describe("--device refuses every encryption entry (TC-3204)", () => {
  test.each(entries)("refuses %s, alone or beside kv, without contacting OpenKey", async (_name, entry) => {
    let contacted = 0;
    const fetchFn = (async () => { contacted += 1; return new Response(null, { status: 500 }); }) as unknown as typeof globalThis.fetch;
    for (const permissions of [[entry], [kv, entry]]) {
      await expect(acquireDeviceDelegation({
        sessionDid: keyToDID(key), jwk: key, nodeOrigin: "https://tee.node.tinycloud.xyz", shareOrigin: "https://share.tinycloud.xyz",
        permissions, fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
      })).rejects.toMatchObject({
        code: "DEVICE_AUTH_UNSUPPORTED_SCOPE",
        exitCode: 2,
        message: expect.stringContaining("because device sign-in can't decrypt. Run the command without --device to approve in a browser"),
      });
    }
    expect(contacted).toBe(0);
  });
  test.each(spellings)("deviceRefusal refuses %s", (_name, entry) => {
    expect(deviceRefusal([kv, entry])).toEqual(entry);
  });
});
