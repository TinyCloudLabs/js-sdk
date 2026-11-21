import { expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  DISMISSED_FLAG_KEY_FOR_TEST,
  readRegistryPublishDismissed,
  writeRegistryPublishDismissed,
} from "./registry-publish-dismissed";

// Minimal KV + node fake. Only the surfaces the helpers actually read are present; anything else
// would be noise and would mask a real breakage behind an incidental shape change.
function makeNode(accountSpaceId: string | undefined = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000AA:account-registry") {
  const store = new Map<string, unknown>();
  const kv = {
    async get<T>(key: string) {
      const value = store.get(key);
      // Match sdk-services' Result<KVResponse<T>> contract.
      return { ok: true as const, data: { data: value as T | undefined, headers: {} } };
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
  };
  const node = {
    accountSpaceId,
    kvForSpace(spaceId: string) {
      if (spaceId !== accountSpaceId) throw new Error("kvForSpace called with wrong space id");
      return kv;
    },
  } as unknown as TinyCloudNode;
  return { node, store, kv };
}

test("dismissed flag defaults to false when nothing is stored", async () => {
  const { node } = makeNode();
  expect(await readRegistryPublishDismissed(node)).toBe(false);
});

test("write then read: dismissed is true after writeRegistryPublishDismissed", async () => {
  const { node, store } = makeNode();
  await writeRegistryPublishDismissed(node);
  const written = store.get(DISMISSED_FLAG_KEY_FOR_TEST) as { dismissed: boolean; at: string } | undefined;
  expect(written?.dismissed).toBe(true);
  expect(typeof written?.at).toBe("string");
  expect(await readRegistryPublishDismissed(node)).toBe(true);
});

test("without an account-registry space the dismissed flag defaults to false", async () => {
  // Explicitly no account-registry space; `kvForSpace` is still present so the helper
  // takes the "no spaceId" branch rather than the "no kvForSpace" branch.
  const node = { accountSpaceId: undefined, kvForSpace: () => { throw new Error("should not be called"); } } as unknown as TinyCloudNode;
  expect(await readRegistryPublishDismissed(node)).toBe(false);
  // A write with no space is a no-op; the next read still reports false.
  await writeRegistryPublishDismissed(node);
  expect(await readRegistryPublishDismissed(node)).toBe(false);
});

test("KV error surfacing never short-circuits the consent prompt (fail-open)", async () => {
  const node = {
    accountSpaceId: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000AA:account-registry",
    kvForSpace() {
      return {
        async get() {
          throw new Error("kv offline");
        },
        async put() {
          throw new Error("kv offline");
        },
      };
    },
  } as unknown as TinyCloudNode;
  // Read catches and reports "not dismissed" so the host still gets to prompt once.
  expect(await readRegistryPublishDismissed(node)).toBe(false);
});
