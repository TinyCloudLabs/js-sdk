import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import { checkServerHealth, setupCliProfile, tc } from "../setup";

describe("tc secrets", () => {
  let node: TinyCloudNode;
  const secretName = `CLI_SECRET_${Date.now()}`;

  beforeAll(async () => {
    await checkServerHealth();
    node = await setupCliProfile();
  });

  afterAll(async () => {
    try {
      await node.secrets.delete(secretName);
    } catch {}
  });

  test("stores, reads, lists, and deletes a network-encrypted secret", async () => {
    const init = await tc("secrets", "network", "init");
    expect(init.exitCode).toBe(0);
    expect(init.json.networkId).toContain("urn:tinycloud:encryption:");
    expect(init.json.state).toBe("active");

    const show = await tc("secrets", "network", "show");
    expect(show.exitCode).toBe(0);
    expect(show.json.exists).toBe(true);
    expect(show.json.networkId).toBe(init.json.networkId);

    const grant = await tc("secrets", "network", "grant", node.did);
    expect(grant.exitCode).toBe(0);
    expect(grant.json.networkId).toBe(init.json.networkId);
    expect(grant.json.recipientDid).toBe(node.did);
    expect(grant.json.actions).toEqual(["tinycloud.encryption/decrypt"]);
    expect(grant.json.cid).toBeTypeOf("string");

    const put = await tc("secrets", "put", secretName, "super-secret");
    expect(put.exitCode).toBe(0);
    expect(put.json).toMatchObject({ name: secretName, written: true });

    const get = await tc("secrets", "get", secretName);
    expect(get.exitCode).toBe(0);
    expect(get.json).toMatchObject({ name: secretName, value: "super-secret" });

    const list = await tc("secrets", "list");
    expect(list.exitCode).toBe(0);
    expect(list.json.secrets).toContain(secretName);

    const del = await tc("secrets", "delete", secretName);
    expect(del.exitCode).toBe(0);
    expect(del.json).toMatchObject({ name: secretName, deleted: true });

    const missing = await tc("secrets", "get", secretName);
    expect(missing.exitCode).toBe(4);
  });
});
