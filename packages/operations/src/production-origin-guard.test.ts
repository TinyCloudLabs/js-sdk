import { describe, expect, test } from "bun:test";
import { armProductionOriginGuard, isProductionLinksOrigin, nodeOptionsWithGuard } from "../test-support/production-origin-guard.mjs";

function target() {
  const calls: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, target: { fetch: fetchStub } };
}

describe("production links origin guard", () => {
  test("an origin variable that names production is refused at arm time", () => {
    for (const value of ["https://api.tinycloud.xyz", "https://API.tinycloud.xyz/", "https://api.tinycloud.xyz.:443"]) {
      expect(() => armProductionOriginGuard({ TC_LINKS_API_ORIGIN: value }, target().target)).toThrow(/production links API/);
    }
  });

  test("fetch refuses the production links API however it is spelled, and passes everything else through", async () => {
    const { calls, target: global } = target();
    armProductionOriginGuard({}, global);
    for (const url of ["https://api.tinycloud.xyz/v1/links", "https://API.tinycloud.xyz./v1/links/abc/delete", new URL("https://api.tinycloud.xyz/v1/links")]) {
      await expect(global.fetch(url, { method: "POST", body: "{}" })).rejects.toThrow(/production links API/);
    }
    await expect(global.fetch(new Request("https://api.tinycloud.xyz/v1/links", { method: "POST", body: "{}" }))).rejects.toThrow(/production links API/);
    expect(calls).toEqual([]);

    expect((await global.fetch("https://127.0.0.1:4443/v1/links", { method: "POST" })).status).toBe(204);
    expect(calls).toEqual(["https://127.0.0.1:4443/v1/links"]);
  });

  test("arming twice does not wrap fetch twice", () => {
    const { target: global } = target();
    armProductionOriginGuard({}, global);
    const once = global.fetch;
    armProductionOriginGuard({}, global);
    expect(global.fetch).toBe(once);
  });

  test("a test's own fixture origin is not touched, and an unset one stays unset", () => {
    const environment: Record<string, string | undefined> = { TC_LINKS_API_ORIGIN: "https://127.0.0.1:4443" };
    armProductionOriginGuard(environment, target().target);
    expect(environment).toEqual({ TC_LINKS_API_ORIGIN: "https://127.0.0.1:4443" });
  });

  test("a spawned Node process gets the guard through NODE_OPTIONS exactly once, keeping what was there", () => {
    const url = "file:///x/production-origin-guard-preload.mjs";
    expect(nodeOptionsWithGuard(undefined, url)).toBe(`--import=${url}`);
    const once = nodeOptionsWithGuard("--max-old-space-size=4096", url);
    expect(once).toBe(`--max-old-space-size=4096 --import=${url}`);
    expect(nodeOptionsWithGuard(once, url)).toBe(once);
  });

  test("only the production links origin is production", () => {
    expect(isProductionLinksOrigin("https://api.tinycloud.xyz/v1/links")).toBe(true);
    expect(isProductionLinksOrigin("http://api.tinycloud.xyz")).toBe(false);
    expect(isProductionLinksOrigin("https://api.tinycloud.xyz.evil.example")).toBe(false);
    expect(isProductionLinksOrigin("not a url")).toBe(false);
  });
});
