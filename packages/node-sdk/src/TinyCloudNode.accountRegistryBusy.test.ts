import { afterEach, expect, mock, test } from "bun:test";
import { KVService, ServiceContext } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";

// TC-3243 (under TC-3211): the SDK retries a node's busy/timeout answers (4 attempts, honouring Retry-After). The account
// registry sync's own retry (3 tries) must not retry them again, or one write costs a busy node up to 12 requests. The
// node here is a fake that counts requests on the wire; the SDK's service context, KV service and retry are the real ones.

const originalWarn = console.warn;
afterEach(() => {
  console.warn = originalWarn;
});

type RegistryRetry = (task: () => Promise<void>, signal: AbortSignal) => Promise<void>;

function registryRetry(): RegistryRetry {
  const retry: unknown = Reflect.get(TinyCloudNode.prototype, "withAccountRegistryRetry");
  if (typeof retry !== "function") throw new Error("withAccountRegistryRetry is missing");
  const node = Object.create(TinyCloudNode.prototype);
  return (task, signal) => retry.call(node, task, signal);
}

/** A registry write against a node that answers every request with `answer()`, and the number of requests it got. */
function writeOverNode(answer: () => Response) {
  const wire = { requests: 0 };
  const context = new ServiceContext({
    hosts: ["https://node.test"],
    invoke: () => ({ Authorization: "signed" }),
    fetch: async () => {
      wire.requests += 1;
      return answer();
    },
    // No waiting between SDK attempts; the policy is otherwise the default (4 attempts).
    retryPolicy: { baseDelayMs: 1, maxDelayMs: 1 },
  });
  context.setSession({
    delegationHeader: { Authorization: "test" },
    delegationCid: "bafytest",
    spaceId: "tinycloud:pkh:eip155:1:0xabc:account",
    verificationMethod: "did:key:test",
    jwk: {},
  });
  const kv = new KVService({});
  kv.initialize(context);
  // As writeManifestRegistryRecords fails: the SDK's error rides as the cause.
  const task = async () => {
    const result = await kv.put("applications/com.example.registry", "{}");
    if (!result.ok) {
      throw Object.assign(new Error(`Failed to write manifest registry records: ${result.error.message}`), { cause: result.error });
    }
  };
  return { task, wire };
}

test.each([
  ["busy", "sql_busy: begin: database is busy"],
  ["timeout", "request_timeout: deadline passed"],
])("a registry write that finds the node %s costs it the SDK's attempts only", async (_name, body) => {
  const { task, wire } = writeOverNode(() => new Response(body, { status: 503, headers: { "retry-after": "0" } }));
  const warn = mock((..._args: unknown[]) => {});
  console.warn = warn;
  await registryRetry()(task, new AbortController().signal);
  expect(wire.requests).toBe(4);
  expect(warn.mock.calls.map((args) => String(args[0]))).toEqual([
    "TinyCloud account registry sync stopped: the node is busy; the SDK already retried it",
  ]);
});

test("a registry write that fails some other way is still retried three times", async () => {
  const { task, wire } = writeOverNode(() => new Response("boom", { status: 500 }));
  const warn = mock((..._args: unknown[]) => {});
  console.warn = warn;
  await registryRetry()(task, new AbortController().signal);
  // The SDK does not retry a bare 500, so each of the sync's three tries is one request.
  expect(wire.requests).toBe(3);
  expect(warn.mock.calls.map((args) => String(args[0]))).toEqual(["TinyCloud account registry sync failed after retries"]);
}, 10_000);
