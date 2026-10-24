import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, setupCliProfile, tc } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

describe("tc kv", () => {
  let node: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    node = await setupCliProfile();
  });

  afterAll(async () => {
    try {
      await node.kv.delete("cli-test-greeting");
      await node.kv.delete("cli-test-number");
      await node.kv.delete("cli-test-delete-me");
      await node.kv.delete("cli-test-seg/a");
    } catch {}
  });

  describe("put", () => {
    test("puts a string value", async () => {
      const result = await tc("kv", "put", "cli-test-greeting", "hello world");
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ key: "cli-test-greeting", written: true });
    });

    test("puts a JSON value", async () => {
      const result = await tc("kv", "put", "cli-test-number", "42");
      expect(result.exitCode).toBe(0);
      expect(result.json.written).toBe(true);
    });
  });

  describe("get", () => {
    test("gets a stored value", async () => {
      const result = await tc("kv", "get", "cli-test-greeting");
      expect(result.exitCode).toBe(0);
      expect(result.json.key).toBe("cli-test-greeting");
      expect(result.json.data).toBe("hello world");
    });

    test("returns exit code 4 for missing key", async () => {
      const result = await tc("kv", "get", "cli-test-nonexistent-key");
      expect(result.exitCode).toBe(4); // NOT_FOUND
    });
  });

  describe("list", () => {
    test("lists keys", async () => {
      const result = await tc("kv", "list");
      expect(result.exitCode).toBe(0);
      expect(result.json).toHaveProperty("keys");
      expect(result.json).toHaveProperty("count");
      expect(result.json.count).toBeGreaterThanOrEqual(1);
    });

    test("lists keys with prefix filter", async () => {
      const result = await tc("kv", "list", "--prefix", "cli-test-greeting");
      expect(result.exitCode).toBe(0);
      expect(result.json.keys.length).toBeGreaterThanOrEqual(1);
    });

    test("prefix matches whole path segments", async () => {
      const put = await tc("kv", "put", "cli-test-seg/a", "segment");
      expect(put.exitCode).toBe(0);

      const whole = await tc("kv", "list", "--prefix", "cli-test-seg");
      expect(whole.exitCode).toBe(0);
      expect(whole.json.keys).toContain("cli-test-seg/a");

      const partial = await tc("kv", "list", "--prefix", "cli-test-se");
      expect(partial.exitCode).toBe(0);
      expect(partial.json.keys).toEqual([]);
    });
  });

  describe("head", () => {
    test("returns metadata for existing key", async () => {
      const result = await tc("kv", "head", "cli-test-greeting");
      expect(result.exitCode).toBe(0);
      expect(result.json.key).toBe("cli-test-greeting");
      expect(result.json.exists).toBe(true);
    });

    test("returns exists: false for missing key", async () => {
      const result = await tc("kv", "head", "cli-test-nonexistent-key");
      expect(result.exitCode).toBe(0);
      expect(result.json.exists).toBe(false);
    });
  });

  describe("delete", () => {
    test("deletes a key", async () => {
      await tc("kv", "put", "cli-test-delete-me", "temporary");
      const result = await tc("kv", "delete", "cli-test-delete-me");
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ key: "cli-test-delete-me", deleted: true });

      const getResult = await tc("kv", "get", "cli-test-delete-me");
      expect(getResult.exitCode).toBe(4);
    });
  });
});
