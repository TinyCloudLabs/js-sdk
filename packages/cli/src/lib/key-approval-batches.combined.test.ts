import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

import { batchKeyPaths, estimateBatchBytes, MOVE_APPROVAL_LEAD_BYTES, planKeyApprovals } from "./key-approval-batches.js";

// TC-4246: a secrets move's first approval carries list, read and write on every secret and decrypt on the network
// beside its keys. The planner counts those bytes in the first request, so the combined request still fits.

// A throwaway key (the well-known test key 1); never a real account.
const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const NETWORK_ID = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;
const resourceOf = (keyPath: string) => `${NETWORK_ID}/${keyPath}`;
const MEASURED_256K_BUDGET = 183_488;

function keyPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => i % 3 === 0
    ? `secrets/scoped/app-${i % 7}/service_api_key_${i}`
    : `secrets/openai_project_api_key_number_${i}`);
}

function cappedKeyPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `secrets/scoped/${"s".repeat(60)}${String(i).padStart(4, "0")}/${"n".repeat(60)}${String(i).padStart(4, "0")}`);
}

/** The real `Authorization` header of the combined request: the keys plus write on every secret and network decrypt. */
async function signedCombinedHeaderBytes(resources: string[]): Promise<number> {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default") ?? manager.jwk(manager.createSessionKey("default"))!);
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: {
      kv: { "vault/secrets/": ["tinycloud.kv/list", "tinycloud.kv/get", "tinycloud.kv/put"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
    rawAbilities: {
      [NETWORK_ID]: ["tinycloud.encryption/decrypt"],
      ...Object.fromEntries(resources.map((resource) => [resource, ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]])),
    },
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

describe("the combined first request", () => {
  for (const count of [1, 10, 50]) {
    test(`is estimated at no less than its real signed header for ${count} keys, production-length and at the caps`, async () => {
      for (const paths of [keyPaths(count), cappedKeyPaths(count)]) {
        const resources = paths.map(resourceOf);
        expect(estimateBatchBytes(resources) + MOVE_APPROVAL_LEAD_BYTES)
          .toBeGreaterThanOrEqual(await signedCombinedHeaderBytes(resources));
      }
    });
  }

  test("keeps every request within the budget, the first with the extra entries counted", () => {
    const batches = batchKeyPaths(keyPaths(140), resourceOf, 22_925, MOVE_APPROVAL_LEAD_BYTES);
    expect(batches.flat()).toEqual([...keyPaths(140)].sort());
    expect(estimateBatchBytes(batches[0]!.map(resourceOf)) + MOVE_APPROVAL_LEAD_BYTES).toBeLessThanOrEqual(22_925);
    for (const batch of batches.slice(1)) expect(estimateBatchBytes(batch.map(resourceOf))).toBeLessThanOrEqual(22_925);
  });

  test("at the 256k budget, a production-sized move of 260 secrets is one request and the split starts after", () => {
    expect(batchKeyPaths(keyPaths(260), resourceOf, MEASURED_256K_BUDGET, MOVE_APPROVAL_LEAD_BYTES)).toHaveLength(1);
    expect(batchKeyPaths(keyPaths(300), resourceOf, MEASURED_256K_BUDGET, MOVE_APPROVAL_LEAD_BYTES)).toHaveLength(2);
  });

  test("the header check sizes for the combined request", async () => {
    const sizes: number[] = [];
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      sizes.push(Math.max(...Object.values(init.headers as Record<string, string>).map((value) => value.length)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const plan = await planKeyApprovals(keyPaths(140), resourceOf, "https://node.test", fetchImpl, MOVE_APPROVAL_LEAD_BYTES);

    expect(plan.batches).toHaveLength(1);
    expect(sizes).toEqual([Math.ceil((estimateBatchBytes(keyPaths(140).map(resourceOf)) + MOVE_APPROVAL_LEAD_BYTES) * 1.05)]);
  });
});
