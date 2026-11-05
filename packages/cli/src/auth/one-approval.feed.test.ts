import { expect, spyOn, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
const { TinyCloudNode } = await import(new URL("../../../node-sdk/src/TinyCloudNode.ts", import.meta.url).href) as { TinyCloudNode: typeof import("@tinycloud/node-sdk").TinyCloudNode };
import { feedResourceNames, initializeFeedDatabases } from "@tinycloud/sdk-services/feed";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import type { Result } from "@tinycloud/sdk-services";
const { sqliteHandle, unwrap } = await import(new URL("../../../sdk-services/src/feed/sqlite.test-helper.ts", import.meta.url).href) as {
  sqliteHandle(): { handle: FeedDatabase; close(): void };
  unwrap<T>(result: Result<T>): T;
};
import { connectFeedAgent } from "../feed/connection.js";
import { onboardingPermissions } from "./onboarding-scope.js";
import { permissionTuples, scopedLoginPermissions } from "./scoped-login.js";

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const space = wasm.makeSpaceId(address, 1, "applications");
const resources = unwrap(feedResourceNames("xyz.tinycloud.tinychat/feed", "fixture-agent"));
const childScope = [
  { service: "tinycloud.sql", space, path: resources.outputResource, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
  { service: "tinycloud.sql", space, path: resources.responseResource, actions: ["tinycloud.sql/read"] },
  { service: "tinycloud.hooks", space, path: `sql/${resources.responseResource}`, actions: ["tinycloud.hooks/subscribe"] },
];
async function parent(withHooks = true) {
  const permissions = scopedLoginPermissions(onboardingPermissions("feed")).filter(p => withHooks || p.service !== "tinycloud.hooks");
  const spaceAbilities: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const p of permissions) ((spaceAbilities[wasm.makeSpaceId(address, 1, p.space!)] ??= {})[p.service.slice(10)] ??= {})[p.path] = p.actions;
  const expiry = new Date(Math.floor(Date.now() / 1000) * 1000 + 600_000);
  const prepared = wasm.prepareSession({ address, chainId: 1, domain: "feed.test", spaceId: space, jwk: key, spaceAbilities,
    abilities: spaceAbilities[space], issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: expiry.toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  const node = new TinyCloudNode({ host: "https://node.test", wasmBindings: wasm, autoBootstrapAccount: false });
  await node.restoreSession({ ...wasm.completeSessionSetup({ ...prepared, signature }), jwk: key, verificationMethod: did,
    address, chainId: 1, spaceId: space, siwe: prepared.siwe, signature });
  return { node, expiry };
}

test("Home-only scope initializes feed tables and issues the exact child without generic app authority", async () => {
  const { node, expiry } = await parent();
  const registry = sqliteHandle(), output = sqliteHandle(), responses = sqliteHandle();
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ activated: [], skipped: [] }));
  try {
    for (const path of ["xyz.tinycloud.tinychat/home_feed", resources.outputResource, resources.responseResource]) {
      expect(node.hasRuntimePermissions([{ service: "tinycloud.sql", space, path, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }])).toBe(true);
    }
    expect(node.hasRuntimePermissions([{ service: "tinycloud.sql", space, path: "other-app/data", actions: ["tinycloud.sql/write"] }])).toBe(false);
    expect(node.hasRuntimePermissions([{ service: "tinycloud.hooks", space, path: "sql/other-app/data", actions: ["tinycloud.hooks/subscribe"] }])).toBe(false);
    const source = { sourceId: "fixture-agent", agentDid: did.split("#")[0]!, label: "Fixture", output: { spaceId: space, database: resources.outputResource }, responses: { spaceId: space, database: resources.responseResource } };
    const grant = await connectFeedAgent(registry.handle, source, async () => {
      unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
      return (await node.delegateTo(source.agentDid, childScope, { expiry: 30 * 86400_000, requireActivation: true })).delegation;
    });
    expect(grant.expiry).toEqual(expiry);
    expect(grant.resources).toHaveLength(3);
    expect(permissionTuples(grant.resources!.map(p => ({ ...p, service: `tinycloud.${p.service}` })), `did:pkh:eip155:1:${address}`))
      .toEqual(permissionTuples(childScope, `did:pkh:eip155:1:${address}`));
    expect(unwrap(await registry.handle.query("SELECT authorization_json FROM feed_agents")).rows).toHaveLength(1);
  } finally { fetch.mockRestore(); registry.close(); output.close(); responses.close(); }
});

test("feed child issuance fails if its required hooks capability was omitted", async () => {
  const { node } = await parent(false);
  await expect(node.delegateTo(did.split("#")[0]!, childScope, { expiry: "30d" })).rejects.toThrow();
});
