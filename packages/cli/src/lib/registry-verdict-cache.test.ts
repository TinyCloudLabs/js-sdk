import { expect, test } from "bun:test";
import { lookupOwnerRegistryVerdict, REGISTRY_NOT_FOUND_BODY, type RegistryVerdict } from "@tinycloud/sdk-core";
import { createCliRegistryVerdictCache } from "./registry-verdict-cache.js";
import { wrapError } from "../output/errors.js";

const subject = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const registryUrl = "https://registry.fixture.test";
const scope = { registryUrl, subject };
const absent: RegistryVerdict = { status: "unregistered", subject, source: "offchain", hosts: [] };
const outageMessage = "Couldn't reach your storage settings, and none are saved on this computer yet, so this didn't run. Try again in a few minutes.";

function registryFetch(handler: (url: URL) => Promise<Response> | Response): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0]) => handler(new URL(input instanceof Request ? input.url : String(input))), {
    preconnect: globalThis.fetch.preconnect,
  });
}

for (const blip of ["network", "timeout", "503"] as const) {
  test(`fresh-owner ${blip} recovers inside one shared lookup and later operations reuse the good verdict`, async () => {
    const delays: number[] = [];
    const cache = createCliRegistryVerdictCache(async (ms) => { delays.push(ms); });
    let v2 = 0, v1 = 0;
    // The timeout lands in the v1 probe, after this lookup has begun with a v2 404.
    const fetch = registryFetch((url) => {
      if (url.pathname.startsWith("/v2/")) v2++;
      else {
        v1++;
        if (v1 === 1) {
          if (blip === "network") throw new TypeError("fixture connection reset");
          if (blip === "timeout") return new Promise<Response>(() => {});
          return new Response("fixture outage", { status: 503 });
        }
      }
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    });
    const lookup = () => lookupOwnerRegistryVerdict(subject, { registryUrl, verdictCache: cache, fetch, timeoutMs: 10 });
    expect(await Promise.all([lookup(), lookup()])).toEqual([absent, absent]);
    for (let record = 0; record < 140; record++) expect(await lookup()).toEqual(absent);
    expect({ v2, v1, delays }).toEqual({ v2: 2, v1: 2, delays: [250] });
  });
}

for (const outage of ["network", "timeout", "500"] as const) {
  test(`sustained ${outage} fails closed after three attempts with the exact last error`, async () => {
    const delays: number[] = [];
    const cache = createCliRegistryVerdictCache(async (ms) => { delays.push(ms); });
    let lookups = 0;
    let lastError: unknown;
    const fetch = registryFetch(() => {
      if (outage === "network") throw new TypeError("fixture connection reset");
      if (outage === "timeout") return new Promise<Response>(() => {});
      return new Response("fixture outage", { status: 500 });
    });
    const lookup = async () => {
      lookups++;
      try { return await lookupOwnerRegistryVerdict(subject, { registryUrl, fetch, timeoutMs: 10 }); }
      catch (error) { lastError = error; throw error; }
    };
    let failure: unknown;
    try { await cache.get(scope, lookup); } catch (error) { failure = error; }
    expect(failure).toBe(lastError);
    expect(wrapError(failure)).toMatchObject({ code: "REGISTRY_UNAVAILABLE", message: outageMessage });
    expect({ lookups, delays }).toEqual({ lookups: 3, delays: [250, 750] });
    // A failed lookup must not poison this process after the registry recovers.
    expect(await cache.get(scope, async () => absent)).toEqual(absent);
  });
}

test("404 stays unregistered with one lookup, both format probes, and no retry", async () => {
  const delays: number[] = [];
  const cache = createCliRegistryVerdictCache(async (ms) => { delays.push(ms); });
  const paths: string[] = [];
  const fetch = registryFetch((url) => {
    paths.push(url.pathname);
    return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
  });
  for (let operation = 0; operation < 3; operation++) {
    expect(await lookupOwnerRegistryVerdict(subject, { registryUrl, verdictCache: cache, fetch })).toEqual(absent);
  }
  expect(paths).toEqual([
    `/v2/locations/${encodeURIComponent(subject.split(":").at(-1)!)}`,
    `/v1/locations/${encodeURIComponent(subject)}`,
  ]);
  expect(delays).toEqual([]);
  cache.invalidate(registryUrl, subject);
  await lookupOwnerRegistryVerdict(subject, { registryUrl, verdictCache: cache, fetch });
  expect(paths.slice(2)).toEqual(paths.slice(0, 2));
});

test("returned offline verdicts are retried and never retained after exhaustion", async () => {
  const cache = createCliRegistryVerdictCache(async () => {});
  const offline: RegistryVerdict = { ...absent, offline: true };
  let attempts = 0;
  const lookup = async () => ++attempts === 1 ? offline : absent;
  expect(await cache.get(scope, lookup)).toEqual(absent);
  expect(await cache.get(scope, lookup)).toEqual(absent);
  expect(attempts).toBe(2);
  cache.invalidate(registryUrl, subject);
  let failures = 0;
  expect(await cache.get(scope, async () => { failures++; return offline; })).toEqual(offline);
  expect(failures).toBe(3);
  expect(await cache.get(scope, async () => absent)).toEqual(absent);
});

for (const status of [401, 429]) {
  test(`HTTP ${status} remains immediate and is not cached`, async () => {
    const delays: number[] = [];
    const cache = createCliRegistryVerdictCache(async (ms) => { delays.push(ms); });
    let requests = 0;
    const fetch = registryFetch(() => { requests++; return new Response("fixture refusal", { status }); });
    expect(await lookupOwnerRegistryVerdict(subject, { registryUrl, verdictCache: cache, fetch })).toMatchObject({
      status: "unavailable", reason: "http-status",
    });
    expect(requests).toBe(1);
    expect(delays).toEqual([]);
    expect(await cache.get(scope, async () => absent)).toEqual(absent);
  });
}
