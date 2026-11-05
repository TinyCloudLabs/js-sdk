import { expect, test, spyOn, setSystemTime } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";

const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const space = (name: string) => wasm.makeSpaceId(address, 1, name);

test("one multi-space parent issues a child clipped to its actual shorter signed expiry", async () => {
  const issued = Math.floor(Date.now() / 1000) * 1000;
  const expiry = new Date(issued + 600_000);
  const entries: PermissionEntry[] = [
    { service: "tinycloud.kv", space: space("account"), path: "spaces/", actions: ["tinycloud.kv/list"] },
    { service: "tinycloud.sql", space: space("applications"), path: "feed", actions: ["tinycloud.sql/read"] },
  ];
  const prepared = wasm.prepareSession({ address, chainId: 1, domain: "fixture.test", spaceId: space("applications"), jwk: key,
    abilities: { sql: { feed: ["tinycloud.sql/read"] } }, spaceAbilities: {
      [space("applications")]: { sql: { feed: ["tinycloud.sql/read"] } },
      [space("account")]: { kv: { "spaces/": ["tinycloud.kv/list"] } },
    }, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: expiry.toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode({ host: "https://node.test", autoBootstrapAccount: false, wasmBindings: wasm });
  await node.restoreSession({ ...session, spaceId: space("applications"), jwk: key, verificationMethod: did,
    address, chainId: 1, siwe: prepared.siwe, signature });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ activated: [], skipped: [] }));
  try {
    setSystemTime(new Date(issued));
    // Numeric milliseconds match feed connect's existing parseExpiry(...)-Date.now() semantics.
    for (const [requested, expected] of [[30 * 86400_000, 600_000], [600_000, 600_000], [120_000, 120_000]]) {
      const child = await node.delegateTo(did.split("#")[0]!, [entries[1]!], { expiry: requested });
      expect(child.delegation.expiry.getTime()).toBe(issued + expected);
      expect(new Set(child.delegation.resources?.map(p => p.space))).toEqual(new Set([entries[1]!.space]));
    }
  } finally { setSystemTime(); fetch.mockRestore(); }
});

test("primary routing prefers requested applications, otherwise first canonical requested space", async () => {
  const { composeManifestRequest } = await import("@tinycloud/sdk-core");
  for (const names of [["zeta", "account"], ["account", "applications", "alpha"], ["bravo", space("alpha")], ["bravo", space("alpha").toLowerCase()]]) {
    const permissions = names.map(space => ({ service: "tinycloud.kv", space, path: "notes/", actions: ["tinycloud.kv/get"] }));
    const node = new TinyCloudNode({ host: "https://node.test", signer, wasmBindings: wasm, autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      capabilityRequest: composeManifestRequest([{ app_id: "fixture", name: "Fixture", space: names[0], prefix: "", defaults: false, includePublicSpace: false, permissions }], { includeAccountRegistryPermissions: false }),
    });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ activated: [], skipped: [], protocol: 1, version: "1.0.0", features: [] }));
    try {
      await node.signIn();
      expect(node.spaceId?.toLowerCase()).toBe(space(names.includes("applications") ? "applications" : names.includes("account") ? "account" : "alpha").toLowerCase());
    } finally { fetch.mockRestore(); }
  }
});
