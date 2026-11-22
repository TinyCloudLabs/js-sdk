import { afterEach, describe, expect, mock, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import { TinyCloudNode } from "./TinyCloudNode";

// TC-3801: a restored session (the CLI's) has no node features of its own, so `namedKeysSupported` reads the
// host's /info once, with no credentials. A node that cannot be asked is "unknown", never "unsupported".

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const info = (features: string[]) => new Response(JSON.stringify({ protocol: 1, version: "test", features, nodeId: "did:key:z6MkNode" }));
const nodeAt = () => new TinyCloudNode({ host: "https://tinycloud.test", wasmBindings: new NodeWasmBindings() });

describe("TinyCloudNode.namedKeysSupported without a sign-in", () => {
  test("is false on a node that lacks encryption-named-keys-v1, true on one that lists it, from one read each", async () => {
    for (const [features, expected] of [[["encryption"], false], [["encryption", "encryption-named-keys-v1"], true]] as const) {
      const fetchMock = mock(async () => info([...features]));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const node = nodeAt();
      expect(await node.namedKeysSupported()).toBe(expected);
      expect(await node.namedKeysSupported()).toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String((fetchMock.mock.calls as unknown as unknown[][])[0]![0])).toBe("https://tinycloud.test/info");
    }
  });

  test("is undefined when the node cannot be asked, and asks again next time", async () => {
    const fetchMock = mock(async () => { throw new Error("offline"); });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const node = nodeAt();
    expect(await node.namedKeysSupported()).toBeUndefined();
    globalThis.fetch = mock(async () => info(["encryption"])) as unknown as typeof fetch;
    expect(await node.namedKeysSupported()).toBe(false);
  });
});
