import { expect, test } from "bun:test";
import { KVService, bootstrapSteps, type IServiceContext } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const HOST = "https://tinycloud.test";

/**
 * The Content-Type Node's fetch (undici) sends, per the Fetch spec: an explicit
 * header wins, a string body defaults to `text/plain;charset=UTF-8`, a Blob
 * uses its type. Bun's fetch omits the string default, so the runtime's own
 * Request can't stand in for the CLI's transport here.
 */
function wireContentType(init: RequestInit | undefined): string | null {
  const explicit = new Headers(init?.headers as HeadersInit | undefined).get("content-type");
  if (explicit) return explicit;
  if (typeof init?.body === "string") return "text/plain;charset=UTF-8";
  if (init?.body instanceof Blob && init.body.type) return init.body.type;
  return null;
}

/**
 * A KV store that behaves like tinycloud-node: it keeps each value with the
 * request's Content-Type and returns that type on read.
 */
function nodeLikeKv(): { kv: () => KVService; puts: string[] } {
  const store = new Map<string, { body: string; contentType: string }>();
  const puts: string[] = [];
  let action = "";
  let path = "";
  const kv = () => {
    const service = new KVService();
    const context: IServiceContext = {
      session: {
        delegationHeader: { Authorization: "Bearer test" },
        delegationCid: "cid:test",
        spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:account`,
        verificationMethod: "did:key:test",
        jwk: { kty: "OKP" },
      },
      isAuthenticated: true,
      invoke: (_session, _service, invokedPath, invokedAction) => {
        path = invokedPath;
        action = invokedAction;
        return {};
      },
      fetch: async (_url, init) => {
        const contentType = wireContentType(init) ?? "application/octet-stream";
        if (action.endsWith("/put")) {
          puts.push(contentType);
          store.set(path, { body: await new Response(init?.body as BodyInit).text(), contentType });
          return new Response(null, { status: 200 });
        }
        const stored = store.get(path);
        if (!stored) return new Response("Key not found", { status: 404 });
        return new Response(stored.body, {
          status: 200,
          headers: { "content-type": stored.contentType },
        });
      },
      hosts: [HOST],
      getService: () => undefined,
      emit: () => {},
      on: () => () => {},
      abortSignal: new AbortController().signal,
      retryPolicy: {
        maxAttempts: 1,
        backoff: "none",
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableErrors: [],
      },
    };
    service.initialize(context);
    return service;
  };
  return { kv, puts };
}

function makeNode(kv: () => KVService): TinyCloudNode {
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
  Reflect.set(node, "_chainId", 1);
  Reflect.set(node, "auth", { lastActivationSkippedSpaceIds: [] });
  Reflect.set(node, "hasRuntimePermissions", () => true);
  Reflect.set(node, "kvForSpace", kv);
  return node;
}

// TC-999: the marker a completed bootstrap writes must let the next sign-in
// skip. Through the real KVService and a node that echoes the stored
// Content-Type, the marker reads back as a JSON string and is rejected, so
// every repeat `tc auth login --method local` re-runs the whole ceremony.
test("a marker written by a completed bootstrap makes the next sign-in skip", async () => {
  const { kv } = nodeLikeKv();
  const steps = bootstrapSteps(ADDRESS, 1);

  const firstLogin = makeNode(kv);
  await Reflect.get(firstLogin, "writeBootstrapCompletionMarker").call(firstLogin, steps);

  const secondLogin = makeNode(kv);
  const decision = await Reflect.get(secondLogin, "resolveBootstrapDecision").call(
    secondLogin,
    steps,
  );

  expect(decision).toEqual({ action: "skip" });
});

// A text/plain marker is parsed before validation; anything that isn't a
// complete v1 marker means "not completed" (repair), never a throw.
for (const [label, stored] of [
  ["invalid JSON", "not-json{"],
  ["a JSON array", "[]"],
  ["JSON null", "null"],
  ["a JSON string", JSON.stringify("complete")],
  ["a string version", JSON.stringify({ v: "1", stepIds: [] })],
  ["non-array step IDs", JSON.stringify({ v: 1, stepIds: "all" })],
  ["an unknown version", JSON.stringify({ v: 2, stepIds: bootstrapSteps(ADDRESS, 1).map((step) => step.id) })],
  ["a missing canonical step", JSON.stringify({ v: 1, stepIds: bootstrapSteps(ADDRESS, 1).slice(1).map((step) => step.id) })],
] as const) {
  test(`a text/plain marker holding ${label} means repair`, async () => {
    const { kv } = nodeLikeKv();
    const planted = await kv().put("system/bootstrap/complete", stored);
    expect(planted.ok).toBe(true);

    const login = makeNode(kv);
    const decision = await Reflect.get(login, "resolveBootstrapDecision").call(
      login,
      bootstrapSteps(ADDRESS, 1),
    );

    expect(decision).toEqual({ action: "run", mode: "repair" });
  });
}
