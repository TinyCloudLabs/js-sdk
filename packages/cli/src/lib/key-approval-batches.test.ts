import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

import {
  batchKeyPaths,
  checkHeaderFits,
  estimateBatchBytes,
  FALLBACK_BATCH_BUDGET_BYTES,
  MAX_CHECK_BYTES,
  planKeyApprovals,
} from "./key-approval-batches.js";

// TC-4248: a secrets move's key approval is split so each signed delegation fits the node's header limit.

// A throwaway key (the well-known test key 1); never a real account.
const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const NETWORK_ID = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;
const resourceOf = (keyPath: string) => `${NETWORK_ID}/${keyPath}`;
const ORIGIN = "https://node.test";

/** Key paths like production's (17–67 chars after `secrets/`), global and scoped. */
function keyPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => i % 3 === 0
    ? `secrets/scoped/app-${i % 7}/service_api_key_${i}`
    : `secrets/openai_project_api_key_number_${i}`);
}

/** The largest key path the name and scope caps allow: a 64-byte scope and a 64-byte name. */
function cappedKeyPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `secrets/scoped/${"s".repeat(60)}${String(i).padStart(4, "0")}/${"n".repeat(60)}${String(i).padStart(4, "0")}`);
}

/** The real `Authorization` header a runtime grant of these exact-key resources activates with. */
async function signedHeaderBytes(resources: string[]): Promise<number> {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default") ?? manager.jwk(manager.createSessionKey("default"))!);
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: {},
    rawAbilities: Object.fromEntries(resources.map((resource) => [resource, ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]])),
    address: ADDRESS,
    chainId: 1,
    domain: "cli.tinycloud.xyz",
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 3_600_000).toISOString(),
    spaceId: wasm.makeSpaceId(ADDRESS, 1, "secrets"),
    jwk,
  });
  const signature = await new PrivateKeySigner(PRIVATE_KEY).signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return new TextEncoder().encode(session.delegationHeader.Authorization).length;
}

/** An ingress that accepts header values up to `limit` bytes and answers like nginx above it. */
function ingress(limit: number) {
  const checks: { url: string; headers: Record<string, string>; bytes: number }[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const bytes = Math.max(...Object.values(headers).map((value) => value.length));
    checks.push({ url: String(url), headers, bytes });
    return bytes <= limit
      ? new Response('{"version":"1.26.24"}', { status: 200 })
      : new Response("<html><head><title>400 Request Header Or Cookie Too Large</title></head></html>", { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, checks };
}

describe("estimateBatchBytes", () => {
  for (const count of [1, 10, 25, 35, 50]) {
    test(`is at least the real signed header for ${count} keys, production-length and at the caps`, async () => {
      for (const paths of [keyPaths(count), cappedKeyPaths(count)]) {
        const resources = paths.map(resourceOf);
        expect(estimateBatchBytes(resources)).toBeGreaterThanOrEqual(await signedHeaderBytes(resources));
      }
    });
  }
});

describe("batchKeyPaths", () => {
  test("packs sorted key paths, the same groups for the same keys in any order, each within the budget", () => {
    const paths = keyPaths(140);
    const batches = batchKeyPaths(paths, resourceOf, FALLBACK_BATCH_BUDGET_BYTES);

    expect(batchKeyPaths([...paths].reverse(), resourceOf, FALLBACK_BATCH_BUDGET_BYTES)).toEqual(batches);
    expect(batches.flat()).toEqual([...paths].sort());
    for (const batch of batches) expect(estimateBatchBytes(batch.map(resourceOf))).toBeLessThanOrEqual(FALLBACK_BATCH_BUDGET_BYTES);
    expect(batches.length).toBeGreaterThan(1);
  });
});

describe("planKeyApprovals", () => {
  test("a 256k ingress takes 140 keys in one approval after one check", async () => {
    const { fetchImpl, checks } = ingress(256 * 1024 - 17);

    const plan = await planKeyApprovals(keyPaths(140), resourceOf, ORIGIN, fetchImpl);

    expect({ requests: plan.batches.length, budgetBytes: plan.budgetBytes, budgetSource: plan.budgetSource })
      .toEqual({ requests: 1, budgetBytes: 183_488, budgetSource: "measured" });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.bytes).toBe(Math.ceil(estimateBatchBytes(keyPaths(140).map(resourceOf)) * 1.05));
  });

  test("a 32k ingress is checked three times and cut to the 32k fallback budget", async () => {
    const { fetchImpl, checks } = ingress(32_751);

    const plan = await planKeyApprovals(keyPaths(140), resourceOf, ORIGIN, fetchImpl);

    expect({ budgetBytes: plan.budgetBytes, budgetSource: plan.budgetSource }).toEqual({ budgetBytes: 22_925, budgetSource: "fallback" });
    expect(checks.map((check) => check.bytes > 32_751)).toEqual([true, true, true]);
    expect(plan.batches).toEqual(batchKeyPaths(keyPaths(140), resourceOf, 22_925));
    expect(plan.batches.length).toBeGreaterThan(1);
  });

  test("a 64k ingress is cut to the budget the second halving measured", async () => {
    const { fetchImpl, checks } = ingress(64 * 1024 - 17);

    const plan = await planKeyApprovals(keyPaths(140), resourceOf, ORIGIN, fetchImpl);

    expect({ budgetBytes: plan.budgetBytes, budgetSource: plan.budgetSource }).toEqual({ budgetBytes: 45_871, budgetSource: "measured" });
    expect(checks).toHaveLength(3);
    expect(plan.batches).toEqual(batchKeyPaths(keyPaths(140), resourceOf, 45_871));
  });

  test("a check that errors, redirects or fails on the server falls back to the 32k budget", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => { throw new TypeError("fetch failed"); },
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
      async () => new Response("bad gateway", { status: 502 }),
      async () => new Response("Bad Request", { status: 400 }),
    ];
    for (const answer of answers) {
      const plan = await planKeyApprovals(keyPaths(140), resourceOf, ORIGIN, answer as unknown as typeof fetch);
      expect({ budgetBytes: plan.budgetBytes, budgetSource: plan.budgetSource }).toEqual({ budgetBytes: 22_925, budgetSource: "fallback" });
      expect(plan.batches).toEqual(batchKeyPaths(keyPaths(140), resourceOf, 22_925));
    }
  });

  test("a move the 32k budget holds in one approval sends no check, and no origin means the fallback", async () => {
    const { fetchImpl, checks } = ingress(256 * 1024);

    expect(await planKeyApprovals(keyPaths(5), resourceOf, ORIGIN, fetchImpl)).toEqual({
      batches: [[...keyPaths(5)].sort()], budgetBytes: 22_925, budgetSource: "fallback",
    });
    expect((await planKeyApprovals(keyPaths(140), resourceOf, undefined, fetchImpl)).budgetSource).toBe("fallback");
    expect(checks).toHaveLength(0);
  });

  test("no check ever sends more than 256 KiB, for any ingress, at the length caps", async () => {
    for (const limit of [16_000, 32_751, 64 * 1024 - 17, 256 * 1024 - 17]) {
      for (const count of [140, 400]) {
        const { fetchImpl, checks } = ingress(limit);
        await planKeyApprovals(cappedKeyPaths(count), resourceOf, ORIGIN, fetchImpl);
        expect(checks.length).toBeGreaterThan(0);
        for (const check of checks) expect(check.bytes).toBeLessThanOrEqual(MAX_CHECK_BYTES);
      }
    }
  });
});

describe("checkHeaderFits", () => {
  test("sends GET /version on the origin with only a padding header", async () => {
    const { fetchImpl, checks } = ingress(100_000);

    expect(await checkHeaderFits("https://node.test/some/path", 5_000, fetchImpl)).toBe("fits");

    expect(checks).toEqual([{ url: "https://node.test/version", headers: { "X-TinyCloud-Header-Check": "a".repeat(5_000) }, bytes: 5_000 }]);
  });
});
