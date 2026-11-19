import { describe, expect, test } from "bun:test";
import { ALLOW_VARIABLE, armProductionFetchGuard, productionOriginLabel } from "../test-support/production-origin-guard.mjs";

const HOSTS = [
  { host: "api.tinycloud.xyz", label: "links API" },
  { host: "registry.tinycloud.xyz", label: "location registry" },
  { host: "node.tinycloud.xyz", label: "TinyCloud node" },
  { host: "tee.node.tinycloud.xyz", label: "TinyCloud node (TEE)" },
  { host: "openkey.so", label: "OpenKey" },
  { host: "api.openkey.so", label: "OpenKey API" },
  { host: "mcp.tinycloud.xyz", label: "hosted MCP server" },
  { host: "share.tinycloud.xyz", label: "Share front end" },
  { host: "courier.tinycloud.xyz", label: "Courier link viewer" },
  { host: "bugs.tinycloud.xyz", label: "bug-report upload service" },
  { host: "secrets.tinycloud.xyz", label: "secret manager front end" },
] as const;

function guarded(environment: Record<string, string | undefined> = {}) {
  const calls: string[] = [];
  const target = {
    fetch: (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };
  armProductionFetchGuard(target, environment);
  return { calls, fetch: target.fetch };
}

describe("every production host is refused however it is spelled", () => {
  for (const { host, label } of HOSTS) {
    test(`${host} (${label})`, async () => {
      const { calls, fetch } = guarded();
      const spellings: Array<string | URL | Request> = [
        `https://${host}/v1/anything`,
        `https://${host.toUpperCase()}/v1/anything`,
        `https://${host}./v1/anything`,
        `https://${host}:443/v1/anything`,
        `https://${host}:8443/v1/anything`,
        `http://${host}/v1/anything`,
        `http://${host}:80/v1/anything`,
        `http://${host}:8080/v1/anything`,
        `https://${host}`,
        new URL(`https://${host}/x`),
        new Request(`https://${host}/x`, { method: "POST", body: "{}" }),
      ];
      for (const spelling of spellings) {
        await expect(fetch(spelling, { method: "POST" })).rejects.toThrow(new RegExp(`production ${label.replace(/[()]/g, "\\$&")} `));
      }
      expect(calls).toEqual([]);
    });

    test(`${host} is named as ${label}`, () => {
      expect(productionOriginLabel(`https://${host}/`)).toBe(label);
    });
  }

  test("the refusal says how to opt in and that CI never honours it", async () => {
    await expect(guarded().fetch("https://registry.tinycloud.xyz/v1/locations/x")).rejects.toThrow(
      new RegExp(`${ALLOW_VARIABLE}=<host>.*never honoured when CI is set`),
    );
  });
});

describe("everything else passes through", () => {
  test("lookalikes, other TinyCloud hosts and loopback fixtures are not production hosts for this guard", async () => {
    const { calls, fetch } = guarded();
    const urls = [
      "https://registry.tinycloud.xyz.evil.example/v1",
      "https://notregistry.tinycloud.xyz/v1",
      "https://api.openkey.so.evil.example/",
      "http://notopenkey.so/",
      "https://docs.tinycloud.xyz/",
      "https://127.0.0.1:4443/v1/locations/x",
      "http://localhost:9000/v2/locations/y",
    ];
    for (const url of urls) expect((await fetch(url)).status).toBe(204);
    expect(calls).toEqual(urls);
    expect(productionOriginLabel("not a url")).toBeUndefined();
  });
});

describe("the explicit per-test opt-in", () => {
  test("a test that names a host in the variable reaches that host only, and only while the variable is set", async () => {
    const environment: Record<string, string | undefined> = {};
    const { calls, fetch } = guarded(environment);

    environment[ALLOW_VARIABLE] = "registry.tinycloud.xyz";
    expect((await fetch("https://registry.tinycloud.xyz/v1/locations/x")).status).toBe(204);
    await expect(fetch("https://node.tinycloud.xyz/info")).rejects.toThrow(/production TinyCloud node /);
    await expect(fetch("https://api.tinycloud.xyz/v1/links", { method: "POST" })).rejects.toThrow(/production links API /);

    delete environment[ALLOW_VARIABLE];
    await expect(fetch("https://registry.tinycloud.xyz/v1/locations/x")).rejects.toThrow(/production location registry /);
    expect(calls).toEqual(["https://registry.tinycloud.xyz/v1/locations/x"]);
  });

  test("the list is comma-separated and forgiving about case, spaces and a trailing dot, but exact about the host", async () => {
    const { calls, fetch } = guarded({ [ALLOW_VARIABLE]: " OpenKey.so. , tee.node.tinycloud.xyz" });
    expect((await fetch("https://openkey.so/")).status).toBe(204);
    expect((await fetch("https://tee.node.tinycloud.xyz/info")).status).toBe(204);
    await expect(fetch("https://api.openkey.so/")).rejects.toThrow(/production OpenKey API /);
    await expect(fetch("https://node.tinycloud.xyz/info")).rejects.toThrow(/production TinyCloud node /);
    expect(calls).toEqual(["https://openkey.so/", "https://tee.node.tinycloud.xyz/info"]);
  });

  test("when CI is set the opt-in is ignored; CI=0, CI=false and an unset CI do not count as CI", async () => {
    for (const ci of ["true", "1", "yes"]) {
      const { calls, fetch } = guarded({ CI: ci, [ALLOW_VARIABLE]: "registry.tinycloud.xyz" });
      await expect(fetch("https://registry.tinycloud.xyz/v1/locations/x")).rejects.toThrow(/production location registry /);
      expect(calls).toEqual([]);
    }
    for (const ci of ["0", "false", "", undefined]) {
      const { calls, fetch } = guarded({ CI: ci, [ALLOW_VARIABLE]: "registry.tinycloud.xyz" });
      expect((await fetch("https://registry.tinycloud.xyz/v1/locations/x")).status).toBe(204);
      expect(calls).toHaveLength(1);
    }
  });
});
