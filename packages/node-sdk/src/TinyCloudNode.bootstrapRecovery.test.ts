import { expect, mock, test } from "bun:test";
import { bootstrapSteps } from "@tinycloud/sdk-core";
import {
  BOOTSTRAP_COMPLETION_MARKER_KEY,
  BOOTSTRAP_COMPLETION_MARKER_VERSION,
  TinyCloudNode,
} from "./TinyCloudNode";

const ADDRESS = "0x0000000000000000000000000000000000000001";

function makeNode(): TinyCloudNode {
  const node = Reflect.construct(TinyCloudNode, [{
    wasmBindings: {
      makeSpaceId(address: string, chainId: number, name: string) {
        return `tinycloud:pkh:eip155:${chainId}:${address}:${name}`;
      },
      createSessionManager() {
        return {
          createSessionKey: (id: string) => id,
          replaceSessionKey: (_jwk: object, keyId: string) => keyId,
          renameSessionKeyId: () => {},
          getDID: (keyId: string) => `did:key:${keyId}`,
          jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
        };
      },
    },
  }]);
  Reflect.set(node, "_address", ADDRESS);
  return node;
}

test("a truncated bootstrap step array cannot write a completion marker", async () => {
  const node = makeNode();
  const put = mock(async () => ({ ok: true, data: { data: undefined } }));
  Reflect.set(node, "kvForSpace", () => ({ put }));
  const write = Reflect.get(node, "writeBootstrapCompletionMarker");
  const steps = bootstrapSteps(ADDRESS, 1);

  await expect(write.call(node, steps.slice(0, -1))).rejects.toThrow(
    "canonical bootstrap step set",
  );
  expect(put).not.toHaveBeenCalled();

  await write.call(node, steps);
  expect(put).toHaveBeenCalledWith(
    BOOTSTRAP_COMPLETION_MARKER_KEY,
    expect.objectContaining({
      v: BOOTSTRAP_COMPLETION_MARKER_VERSION,
      stepIds: steps.map((step) => step.id),
    }),
  );
});

test("a marker-read error runs one repair decision instead of skipping", async () => {
  const node = makeNode();
  Reflect.set(node, "auth", { lastActivationSkippedSpaceIds: [] });
  Reflect.set(node, "hasRuntimePermissions", () => true);
  Reflect.set(node, "readBootstrapCompletionMarker", async () => ({
    ok: false,
    error: { code: "AUTH_UNAUTHORIZED", message: "denied", service: "kv" },
  }));
  const resolve = Reflect.get(node, "resolveBootstrapDecision");

  await expect(resolve.call(node, bootstrapSteps(ADDRESS, 1))).resolves.toEqual({
    action: "run",
    mode: "repair",
  });
});

test("only an accepted marker version permits an already-provisioned skip", async () => {
  const node = makeNode();
  Reflect.set(node, "auth", { lastActivationSkippedSpaceIds: [] });
  Reflect.set(node, "hasRuntimePermissions", () => true);
  Reflect.set(node, "readBootstrapCompletionMarker", async () => ({
    ok: true,
    data: { data: { v: BOOTSTRAP_COMPLETION_MARKER_VERSION } },
  }));
  const resolve = Reflect.get(node, "resolveBootstrapDecision");

  await expect(resolve.call(node, bootstrapSteps(ADDRESS, 1))).resolves.toEqual({
    action: "skip",
  });
});
