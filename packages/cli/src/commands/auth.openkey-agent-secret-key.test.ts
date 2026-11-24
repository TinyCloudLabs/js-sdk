import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEntry } from "@tinycloud/node-sdk";

// An agent request to an OpenKey owner may carry one raw encryption entry: decrypt on one secret's own key (TC-3802,
// against OpenKey's exact-key contract, TC-3800). A prefix, the bare network, key creation and every other raw entry
// are still refused.
const home = await mkdtemp(join(tmpdir(), "tc-openkey-agent-key-"));
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
const originalPrivateKey = process.env.TC_PRIVATE_KEY;
process.env.HOME = home;
process.env.TC_HOME = home;
delete process.env.TC_PRIVATE_KEY;
const { assertOpenKeyAgentRequest } = await import("./auth.js");
const { isExactSecretKeyPermission } = await import("../lib/raw-encryption.js");
const { withExactKeyNode } = await import("../lib/exact-key-grant.js");

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalPrivateKey !== undefined) process.env.TC_PRIVATE_KEY = originalPrivateKey;
  await rm(home, { recursive: true, force: true });
});

const OWNER = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const SPACE = "tinycloud:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:secrets";
const DECRYPT = "tinycloud.encryption/decrypt";
const KEY_CREATE = "tinycloud.encryption/key.create";
const REFUSED = expect.objectContaining({ code: "RAW_RECAP_RESOURCE_UNSUPPORTED" });

const record: PermissionEntry = {
  service: "tinycloud.kv", space: SPACE, path: "vault/secrets/API_KEY", skipPrefix: true, actions: ["tinycloud.kv/get"],
};
function encryption(path: string, actions: string[] = [DECRYPT]): PermissionEntry {
  return { service: "tinycloud.encryption", path, actions } as PermissionEntry;
}

describe("OpenKey agent request: raw encryption", () => {
  test("decrypt on one secret's own key passes next to the record read, and alone", () => {
    expect(() => assertOpenKeyAgentRequest([record, encryption(`${NETWORK}/secrets/api_key`)])).not.toThrow();
    expect(() => assertOpenKeyAgentRequest([record, encryption(`${NETWORK}/secrets/scoped/food-tracker/token`)])).not.toThrow();
    expect(() => assertOpenKeyAgentRequest([encryption(`${NETWORK}/secrets/api_key`)])).not.toThrow();
  });

  test("key creation on a secret's key is refused for now, alone or with decrypt", () => {
    expect(() => assertOpenKeyAgentRequest([record, encryption(`${NETWORK}/secrets/api_key`, [DECRYPT, KEY_CREATE])])).toThrow(REFUSED);
    expect(() => assertOpenKeyAgentRequest([record, encryption(`${NETWORK}/secrets/api_key`, [KEY_CREATE])])).toThrow(REFUSED);
  });

  test.each([
    ["the bare network", NETWORK],
    ["every key under secrets/", `${NETWORK}/secrets/`],
    ["the secrets folder without its slash", `${NETWORK}/secrets`],
    ["a key prefix of one secret", `${NETWORK}/secrets/api_key/`],
    ["a folder outside secrets/", `${NETWORK}/share/`],
    ["a key outside secrets/", `${NETWORK}/apps/demo/key`],
    ["another network's secret key", `urn:tinycloud:encryption:${OWNER}:other/secrets/api_key`],
  ])("%s is refused", (_label, path) => {
    expect(() => assertOpenKeyAgentRequest([record, encryption(path)])).toThrow(REFUSED);
  });

  test("one wide entry next to a good one refuses the request, and no other action on a key passes", () => {
    expect(() => assertOpenKeyAgentRequest([record, encryption(`${NETWORK}/secrets/api_key`), encryption(NETWORK)])).toThrow(REFUSED);
    expect(() => assertOpenKeyAgentRequest([record, encryption(`${NETWORK}/secrets/api_key`, ["tinycloud.encryption/delete"])])).toThrow(REFUSED);
  });
});

describe("isExactSecretKeyPermission", () => {
  test("names one key and nothing wider", () => {
    expect(isExactSecretKeyPermission(encryption(`${NETWORK}/secrets/api_key`))).toBe(true);
    expect(isExactSecretKeyPermission(encryption(NETWORK))).toBe(false);
    expect(isExactSecretKeyPermission(encryption(`${NETWORK}/secrets/`))).toBe(false);
    expect(isExactSecretKeyPermission(encryption(`${NETWORK}/secrets/API_KEY`))).toBe(false);
    expect(isExactSecretKeyPermission({ ...record })).toBe(false);
    expect(isExactSecretKeyPermission({
      ...encryption(`${NETWORK}/secrets/api_key`), caveats: [{ any: "caveat" }],
    } as unknown as PermissionEntry)).toBe(false);
  });
});

describe("withExactKeyNode", () => {
  test("a profile with no wallet key to sign with is refused before any node is contacted", async () => {
    let used = false;
    await expect(withExactKeyNode({
      ctx: { host: "http://127.0.0.1:1", profile: "owner" },
      profile: { authMethod: "openkey" } as never,
      keyEntries: [encryption(`${NETWORK}/secrets/api_key`)],
      expiry: undefined,
    }, async () => { used = true; })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("This profile has no wallet key"),
    });
    expect(used).toBe(false);
  });
});
