import { beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "./setup";

/**
 * Live acceptance for bounded KV list paging (TC-731's SDK slice): a list with
 * `limit: 1` that follows `nextCursor` visits every key under the prefix
 * exactly once and ends with `truncated: false`.
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SPACE_NAME = "default";
const PREFIX = `kv-list-paging-test/${RUN_ID}/`;
const KEYS = ["a", "b", "c", "d/nested", "e"].map((key) => `${PREFIX}${key}`);
const TEST_TIMEOUT = 30000;

describe("KV list paging", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = new TinyCloudNode({
      host: SERVER_URL,
      privateKey: TEST_KEY,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "kv-list-paging-test",
        name: "KV list paging acceptance",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: SPACE_NAME,
        permissions: [{
          service: "tinycloud.kv",
          space: SPACE_NAME,
          path: PREFIX,
          actions: ["put", "list"],
        }],
      },
    });
    await alice.signIn();
    await alice.hostOwnedSpace(SPACE_NAME);
    for (const key of KEYS) {
      const put = await alice.space(SPACE_NAME).kv.put(key, key);
      if (!put.ok) throw new Error(`put ${key}: ${put.error.message}`);
    }
  }, TEST_TIMEOUT);

  test("limit 1 pages follow nextCursor to distinct keys", async () => {
    const kv = alice.space(SPACE_NAME).kv;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page <= KEYS.length; page++) {
      const listed = await kv.list({ prefix: PREFIX, limit: 1, cursor });
      if (!listed.ok) throw new Error(`${listed.error.code}: ${listed.error.message}`);
      expect(listed.data.keys.length).toBeLessThanOrEqual(1);
      seen.push(...listed.data.keys);
      if (!listed.data.truncated) {
        expect(listed.data.nextCursor).toBeUndefined();
        break;
      }
      expect(listed.data.nextCursor).toBeDefined();
      expect(listed.data.nextCursor).not.toBe(cursor);
      cursor = listed.data.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...KEYS].sort());
  }, TEST_TIMEOUT);
});
