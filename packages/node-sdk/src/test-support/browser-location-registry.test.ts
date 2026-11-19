import { expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY, verifyLocationRecordV2 } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { startBrowserLocationRegistry } from "./browser-location-registry";

test("browser fixture accounts have signed routes after owner setup", async () => {
  const registry = startBrowserLocationRegistry();
  const key = `0x${"13".repeat(32)}` as const;
  const owner = privateKeyToAccount(key);
  const nodeDid = "did:key:z6MktLHQwkV2x8WKZhmyB8qEShgvcMHfJbNjb2k21pVJQvfB";
  const url = new URL(`/v2/locations/${owner.address}`, registry.url);
  try {
    const absent = await fetch(url);
    expect(absent.status).toBe(404);
    expect(await absent.text()).toBe(REGISTRY_NOT_FOUND_BODY);
    await registry.register(key, "http://127.0.0.1:8920", nodeDid);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const { record } = await response.json();
    expect(await verifyLocationRecordV2(record)).toBe(true);
    expect(record.nodes).toEqual([{ did: nodeDid, url: "http://127.0.0.1:8920" }]);
    expect(record.spaces).toContainEqual({ space: `tinycloud:pkh:eip155:1:${owner.address}:default`.toLowerCase(), nodes: [{ did: nodeDid, mode: "read-write" }] });
    expect((await fetch(new URL("/v2/locations/0x0000000000000000000000000000000000000001", registry.url))).status).toBe(404);
  } finally {
    registry.stop(true);
  }
});
