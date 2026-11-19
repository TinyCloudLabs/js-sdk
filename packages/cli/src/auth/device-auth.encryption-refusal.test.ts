import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";

// TC_HOME is read when the profile store loads, so import it afterwards.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-encryption-refusal-"));
process.env.TC_HOME = home;
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

const key = JSON.parse(new NodeWasmBindings().createSessionManager().jwk("default")!) as Record<string, string>;
const sessionDid = keyToDID(key);

/** What a device request holds when someone asks OpenKey for decrypt on the owner's default network. */
const defaultDecrypt: PermissionEntry = { service: "tinycloud.encryption", space: "default", path: "", actions: ["tinycloud.encryption/decrypt"] };
const capabilityRead: PermissionEntry = { service: "tinycloud.capabilities", space: "default", path: "", actions: ["tinycloud.capabilities/read"] };

describe("a device request for encryption", () => {
  test.each([
    ["decrypt on the owner's default network, alone", [defaultDecrypt]],
    ["decrypt on the owner's default network, next to other scopes", [capabilityRead, defaultDecrypt]],
  ])("is refused before OpenKey is contacted: %s", async (_name, permissions) => {
    const urls: string[] = [];
    const fetchFn = Object.assign(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({}, { status: 500 });
    }, { preconnect: () => undefined }) as typeof globalThis.fetch;
    await expect(acquireDeviceDelegation({
      sessionDid, jwk: key, nodeOrigin: "https://node.example.test", shareOrigin: "https://share.example.test", permissions,
      fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
    })).rejects.toMatchObject({
      code: "DEVICE_AUTH_UNSUPPORTED_SCOPE",
      exitCode: 2,
      message: expect.stringMatching(/^--device can't ask for encryption permissions, and this request asks for tinycloud\.encryption\/decrypt on space "default", path ""\.$/),
    });
    expect(urls).toEqual([]);
  });
});
