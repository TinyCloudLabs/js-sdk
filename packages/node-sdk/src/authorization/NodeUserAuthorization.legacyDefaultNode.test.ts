import { expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY, registryOwnerSubjectV1, signLocationRecord, type RegisteredRegistryVerdict } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";

// TC-3168: a v1-only owner whose verified record names only the default node keeps its 3.11 route and setup.
async function withV1Registry(multiaddrs: string[], run: (auth: NodeUserAuthorization, spaceId: string) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const signer = new PrivateKeySigner("2".padStart(64, "0"));
  const address = await signer.getAddress();
  const record = await signLocationRecord({
    version: 1, subject: registryOwnerSubjectV1(address), sequence: 0, multiaddrs, updated_at: "2026-11-04T00:00:00.000Z",
  }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    expect(url).toStartWith("https://registry.legacy-default.test/");
    return url.includes("/v2/") ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }) : Response.json({ record });
  }, { preconnect: previousFetch.preconnect }) as typeof fetch;
  try {
    const wasm = new NodeWasmBindings();
    const auth = new NodeUserAuthorization({
      signer, wasmBindings: wasm, signStrategy: { type: "auto-sign" }, domain: "notes.example",
      requireExistingAccount: true, newUserHost: "https://test-new-user.invalid", autoDiscoverLocalNode: false,
      tinycloudRegistryUrl: "https://registry.legacy-default.test",
    });
    await run(auth, wasm.makeSpaceId(address, 1, "secrets"));
  } finally { globalThis.fetch = previousFetch; }
}

test("a v1-only owner on the default node routes there as an existing account, with automatic setup", async () => {
  await withV1Registry(["/dns4/node.tinycloud.xyz/tcp/443/https"], async (auth, spaceId) => {
    for (const access of ["read", "write", "host"] as const) {
      expect(await auth.resolveResourceDestinations(spaceId, access)).toEqual([{ url: "https://node.tinycloud.xyz", nodeDid: undefined }]);
    }
    expect(auth.registryRecordPresent).toBe(true);
    expect(auth.allowsAutomaticSetup(spaceId)).toBe(true);
  });
});

test("a v1-only owner on any other node is refused, not sent to the new-user host", async () => {
  await withV1Registry(["/dns4/test-node.invalid/tcp/443/https"], async (auth, spaceId) => {
    await expect(auth.resolveResourceDestinations(spaceId, "read")).rejects.toMatchObject({
      code: "registry_unavailable", verdict: { reason: "unsupported-format" },
    });
  });
});

test("automatic setup without a v2 record needs the explicit legacy marker", async () => {
  await withV1Registry(["/dns4/node.tinycloud.xyz/tcp/443/https"], async (auth, spaceId) => {
    const recordless: RegisteredRegistryVerdict = {
      status: "registered", subject: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001", source: "offchain",
      sequence: 0, hosts: [{ urls: ["https://node.tinycloud.xyz"], source: "offchain" }],
    };
    // The verdict is private and only the registry lookup sets it; inject the unmarked shape no lookup produces.
    Reflect.set(auth, "registryVerdict", recordless);
    expect(auth.allowsAutomaticSetup(spaceId)).toBe(false);
    Reflect.set(auth, "registryVerdict", { ...recordless, legacy: "v1-default-node" });
    expect(auth.allowsAutomaticSetup(spaceId)).toBe(true);
  });
});
