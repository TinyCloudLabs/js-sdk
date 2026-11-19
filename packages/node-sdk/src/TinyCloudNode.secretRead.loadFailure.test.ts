import { describe, expect, mock, test } from "bun:test";

import { TinyCloudNode } from "./TinyCloudNode";

const TARGET_SPACE =
  "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:target-secrets";

const SECRET_RECORD = {
  status: "ok",
  entry: {
    value: {
      value: "secret value",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
  },
};

type SecretReadLoader = () => Promise<unknown>;

/** The module loader `readSecret` uses for its first-use file, read off the prototype. */
const realLoad = (TinyCloudNode.prototype as unknown as { loadSecretRead: SecretReadLoader })
  .loadSecretRead;

function makeNode(loadSecretRead: SecretReadLoader) {
  const node = Object.create(TinyCloudNode.prototype) as TinyCloudNode;
  const readNetworkEncrypted = mock(async () => SECRET_RECORD);
  Object.assign(node, {
    _spaceService: {},
    getBaseVault: () => ({ readNetworkEncrypted }),
    loadSecretRead,
  });
  return { node, readNetworkEncrypted };
}

describe("TinyCloudNode.readSecret when its first-use file fails to load", () => {
  test("a failed load after a successful read resolves to read_failed instead of rejecting", async () => {
    const load = mock(() => Promise.reject(new Error("Loading chunk secret-read failed.")));
    const { node, readNetworkEncrypted } = makeNode(load);

    await expect(node.readSecret({ space: TARGET_SPACE, name: "API_KEY" }))
      .resolves.toEqual({ status: "read_failed" });
    expect(readNetworkEncrypted).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("the next read loads the file again and returns the secret", async () => {
    let calls = 0;
    const load = mock(function (this: TinyCloudNode) {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("Loading chunk secret-read failed."))
        : realLoad.call(this);
    });
    const { node } = makeNode(load);

    await expect(node.readSecret({ space: TARGET_SPACE, name: "API_KEY" }))
      .resolves.toEqual({ status: "read_failed" });
    await expect(node.readSecret({ space: TARGET_SPACE, name: "API_KEY" }))
      .resolves.toEqual({ status: "ok", value: "secret value" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
