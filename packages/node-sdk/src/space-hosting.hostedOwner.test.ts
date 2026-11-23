import { describe, expect, test } from "bun:test";
import { assessHostedOwnerRecap, hostedOwnerPlanOperations, readHostedOwnerSpace, sameSpaceId } from "./space-hosting";

const address = "0x1111111111111111111111111111111111111111";
const apps = `tinycloud:pkh:eip155:1:${address}:applications`;
const op = (action: string, extra: object = {}) => ({
  spaceId: apps,
  service: action.split("/")[0]!.split(".")[1]!,
  path: "notes/",
  action,
  ...extra,
});

describe("assessHostedOwnerRecap", () => {
  test("uses one kv list of limit 1 when the request already holds it", () => {
    expect(assessHostedOwnerRecap([op("tinycloud.kv/get"), op("tinycloud.kv/list")], apps)).toEqual({
      service: "kv", path: "notes/", action: "tinycloud.kv/list", headers: { "x-tinycloud-limit": "1" },
    });
  });

  test("falls back to space info and never to get or metadata", () => {
    expect(assessHostedOwnerRecap([op("tinycloud.kv/get"), op("tinycloud.kv/metadata"), op("tinycloud.space/info", { path: "" })], apps))
      .toEqual({ service: "space", path: "", action: "tinycloud.space/info", body: "{}" });
    expect(assessHostedOwnerRecap([op("tinycloud.kv/get"), op("tinycloud.kv/metadata"), op("tinycloud.kv/put")], apps)).toBeUndefined();
  });

  test.each([
    ["a caveated operation", [op("tinycloud.kv/list", { caveats: [{ max: 1 }] })]],
    ["another space", [op("tinycloud.kv/list"), op("tinycloud.kv/get", { spaceId: apps.replace("applications", "default") })]],
    ["a network resource", [op("tinycloud.kv/list"), { resource: "urn:tinycloud:encryption:x", service: "encryption", path: "x", action: "tinycloud.encryption/decrypt" }]],
    ["space host", [op("tinycloud.kv/list"), op("tinycloud.space/host", { path: "" })]],
    ["any other space ability", [op("tinycloud.kv/list"), op("tinycloud.space/delete", { path: "" })]],
    ["a create ability", [op("tinycloud.kv/list"), op("tinycloud.encryption/key.create")]],
  ])("refuses %s", (_name, operations) => {
    expect(assessHostedOwnerRecap(operations, apps)).toBeUndefined();
  });

  test("compares the address case-insensitively and the rest exactly", () => {
    expect(sameSpaceId(apps, apps.replace(address, address.toUpperCase().replace("0X", "0x")))).toBe(true);
    expect(sameSpaceId(apps, apps.replace("applications", "Applications"))).toBe(false);
  });
});

describe("hostedOwnerPlanOperations", () => {
  test("lists every space and raw ability of the request", () => {
    const operations = hostedOwnerPlanOperations({
      abilities: { kv: { "notes/": ["tinycloud.kv/get"] } },
      spaceId: apps,
      spaceAbilities: { [apps]: { kv: { "notes/": ["get"] } } },
      rawAbilities: { "urn:tinycloud:encryption:n": ["tinycloud.encryption/network.create"] },
    });
    expect(operations.map((o) => o.action)).toEqual(["tinycloud.kv/get", "tinycloud.kv/get", "tinycloud.encryption/network.create"]);
    expect(assessHostedOwnerRecap(operations, apps)).toBeUndefined();
  });
});

describe("readHostedOwnerSpace", () => {
  const read = { service: "kv", path: "notes/", action: "tinycloud.kv/list", headers: { "x-tinycloud-limit": "1" } };
  const run = async (respond: () => Response | Promise<Response>) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const outcome = await readHostedOwnerSpace({
      spaceId: apps,
      host: "https://node.test",
      read,
      fetch: (async (url: string, init: RequestInit) => { requests.push({ url, init }); return respond(); }) as never,
      sign: () => ({ authorization: "invocation" }),
    });
    return { outcome, requests };
  };

  test("is positive only for a 2xx, with one request signed for the exact read", async () => {
    const { outcome, requests } = await run(() => new Response("[]", { status: 200 }));
    expect(outcome).toBe("positive");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://node.test/invoke");
    expect(requests[0]!.init.redirect).toBe("error");
    expect(requests[0]!.init.headers).toEqual({ authorization: "invocation", "x-tinycloud-limit": "1" });
  });

  test.each([401, 403, 404, 400])("%d is refused, whatever the body says", async (status) => {
    expect((await run(() => new Response("Space not found", { status }))).outcome).toBe("refused");
    expect((await run(() => new Response("No such key", { status }))).outcome).toBe("refused");
  });

  test("a 5xx, a network error and a redirect are unreachable, never refused or positive", async () => {
    expect((await run(() => new Response("", { status: 503 }))).outcome).toBe("unreachable");
    expect((await run(() => { throw new TypeError("network"); })).outcome).toBe("unreachable");
  });
});
