import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkServerHealth, setupCliProfile, tc } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const SECRET_NAME = `CLI_E2E_SECRET_${Date.now()}`;
const SECRET_VALUE = `secret value ${Date.now()} :: round trip`;

describe("tc secrets e2e", () => {
  let node: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    node = await setupCliProfile();
  });

  afterAll(async () => {
    try {
      await node.secrets.delete(SECRET_NAME);
    } catch {}
  });

  test("creates, reads, lists, and deletes a network-encrypted secret", async () => {
    const network = await tc("secrets", "network", "init");
    expect(network.exitCode).toBe(0);
    expect(network.json).toMatchObject({
      state: "active",
    });
    expect(network.json.networkId).toMatch(/^urn:tinycloud:encryption:/);

    const put = await tc("secrets", "put", SECRET_NAME, SECRET_VALUE);
    expect(put.exitCode).toBe(0);
    expect(put.json).toEqual({
      name: SECRET_NAME,
      written: true,
    });

    const get = await tc("secrets", "get", SECRET_NAME);
    expect(get.exitCode).toBe(0);
    expect(get.json).toEqual({
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });

    const raw = await tc("secrets", "get", SECRET_NAME, "--raw");
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).toBe(SECRET_VALUE);

    const list = await tc("secrets", "list");
    expect(list.exitCode).toBe(0);
    expect(list.json.secrets).toContain(SECRET_NAME);
    expect(list.json.count).toBeGreaterThanOrEqual(1);

    const del = await tc("secrets", "delete", SECRET_NAME);
    expect(del.exitCode).toBe(0);
    expect(del.json).toEqual({
      name: SECRET_NAME,
      deleted: true,
    });

    const missing = await tc("secrets", "get", SECRET_NAME);
    expect(missing.exitCode).toBe(4);
  });
});
