import { describe, expect, mock, test } from "bun:test";

import { TinyCloudNode } from "./TinyCloudNode";

const TARGET_SPACE =
  "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:target-secrets";

function makeNode(read: unknown) {
  const node = Object.create(TinyCloudNode.prototype) as TinyCloudNode;
  const getBaseVault = mock((_space: string) => ({
    readNetworkEncrypted: mock(async () => read),
  }));
  Object.assign(node, {
    _spaceService: {},
    getBaseVault,
  });
  return { node, getBaseVault };
}

describe("TinyCloudNode.readSecret", () => {
  test("returns value and uses the explicit target space and canonical vault key", async () => {
    const { node, getBaseVault } = makeNode({
      status: "ok",
      entry: {
        value: {
          value: "secret value",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      },
    });

    await expect(node.readSecret({
      space: TARGET_SPACE,
      name: "API_KEY",
      scope: "Production App",
    })).resolves.toEqual({ status: "ok", value: "secret value" });

    expect(getBaseVault).toHaveBeenCalledWith(TARGET_SPACE);
    expect(getBaseVault.mock.results[0]?.value.readNetworkEncrypted)
      .toHaveBeenCalledWith("secrets/scoped/production-app/API_KEY");
  });

  test.each([
    ["not_found", { status: "not_found" }],
    ["node_unreachable", { status: "node_unreachable", message: "transport canary" }],
    ["read_failed", { status: "read_failed", message: "read canary" }],
    ["corrupt_envelope", { status: "corrupt_envelope" }],
    ["decrypt_failed", { status: "decrypt_failed", message: "decrypt canary" }],
  ] as const)("preserves the safe %s classification", async (status, read) => {
    const { node } = makeNode(read);

    const result = await node.readSecret({ space: TARGET_SPACE, name: "API_KEY" });

    expect(result).toEqual({ status });
    expect(JSON.stringify(result)).not.toContain("canary");
  });

  test("classifies a decrypted non-secret payload without exposing it", async () => {
    const { node } = makeNode({
      status: "ok",
      entry: { value: { value: "plaintext canary" } },
    });

    const result = await node.readSecret({ space: TARGET_SPACE, name: "API_KEY" });

    expect(result).toEqual({ status: "invalid_payload" });
    expect(JSON.stringify(result)).not.toContain("plaintext canary");
  });
});
