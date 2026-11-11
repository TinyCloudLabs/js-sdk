import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { KVService } from "./KVService";

test("explicit network reads bypass lazy and in-progress replica setup", async () => {
  const requests: string[] = [];
  const context = new ServiceContext({
    invoke: (_session, _service, path) => ({ "x-fixture-key": path }),
    hosts: ["https://network-only.fixture"],
    session: {
      delegationHeader: { Authorization: "Bearer fixture" },
      delegationCid: "fixture",
      spaceId: "fixture",
      verificationMethod: "did:key:fixture",
      jwk: {},
    },
    fetch: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      const key = headers["x-fixture-key"]!;
      requests.push(key);
      return Response.json(key === "notes/" ? ["notes/one"] : "network value");
    },
  });
  const kv = new KVService({});
  kv.initialize(context);
  const binding = Promise.withResolvers<void>();
  let starts = 0;
  kv.setReadThroughReady(() => {
    starts++;
    return binding.promise;
  });

  expect((await kv.get("notes/one", { source: "network" })).ok).toBe(true);
  expect(starts).toBe(0);
  const local = kv.get("notes/two");
  await Promise.resolve();
  expect(starts).toBe(1);
  expect((await kv.list({ prefix: "notes/", source: "network" })).ok).toBe(true);
  expect(requests).toEqual(["notes/one", "notes/"]);
  binding.resolve();
  expect((await local).ok).toBe(true);
});
