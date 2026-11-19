import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { scopedLoginPermissions, validateLoginPermissions, verifyScopedLogin } from "./scoped-login.js";
import { verifyOpenKeyApproval } from "../commands/auth.js";
import { onboardingPermissions } from "./onboarding-scope.js";

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const space = (name: string) => wasm.makeSpaceId(address, 1, name);
const requested = scopedLoginPermissions([
  { service: "tinycloud.kv", space: "account", path: "spaces/", actions: ["tinycloud.kv/list"] },
  { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/home_feed", actions: ["tinycloud.sql/read"] },
]);
async function fixture(entries = requested, primary = "applications"): Promise<Record<string, unknown> & { requestedSpaces: Array<{space: string; spaceId: string; spaceReady: boolean}>; spaceReady: boolean }> {
  const spaceAbilities: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const p of entries) ((spaceAbilities[space(p.space!)] ??= {})[p.service.slice("tinycloud.".length)] ??= {})[p.path] = p.actions;
  const prepared = wasm.prepareSession({ address, chainId: 1, domain: "fixture.test", spaceId: space(primary), jwk: key,
    abilities: spaceAbilities[space(primary)] ?? {}, spaceAbilities,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + 3600000).toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  return { ...wasm.completeSessionSetup({ ...prepared, signature }), address, chainId: 1, spaceId: space(primary),
    verificationMethod: did, siwe: prepared.siwe, signature, spaceReady: true,
    requestedSpaces: ["account", "applications"].map(name => ({ space: name, spaceId: space(name), spaceReady: true })) };
}
describe("TC-2490 one approval contract fixtures", () => {
  test("Home-only has discovery and named feed resources without generic app grants", () => {
    const home = onboardingPermissions("feed");
    expect(home.some(p => p.space === "account" && p.path === "spaces/")).toBe(true);
    expect(home.some(p => p.service === "tinycloud.sql" && p.path === "xyz.tinycloud.tinychat/home_feed" && p.actions.includes("tinycloud.sql/schema"))).toBe(true);
    expect(onboardingPermissions("apps,feed").find(p => p.path === "xyz.tinycloud.tinychat/home_feed")?.actions).toEqual(["tinycloud.sql/schema"]);
    expect(home.filter(p => p.space === "applications").every(p => p.path !== "")).toBe(true);
    expect(onboardingPermissions().some(p => p.space === "applications" && p.path === "")).toBe(true);
  });
  test("distinct-space signed round trip preserves resource spaces through portable serialization", async () => {
    validateLoginPermissions(requested);
    const data = await fixture();
    const result = verifyOpenKeyApproval(data, requested, "https://node.test", { key, sessionDid: did, exactApproval: true });
    expect(new Set(result.delegation.resources!.map(p => p.space))).toEqual(new Set([space("account"), space("applications")]));
    expect(result.delegation.spaceId).toBe(space("applications"));
  });
  test("missing, wrong-space and wrong-primary returned authority is rejected", async () => {
    for (const entries of [requested.slice(1), requested.map(p => p.space === "account" ? { ...p, space: "wrong" } : p)]) {
      const data = await fixture(entries);
      expect(() => verifyScopedLogin(data, key, did, requested, { exactApproval: true })).toThrow();
    }
    const data = await fixture(requested, "account");
    expect(() => verifyScopedLogin(data, key, did, requested, { exactApproval: true })).toThrow();
  });
  test("complete readiness is per requested space; aggregate true requires all entries true", async () => {
    const data = await fixture();
    const pending = { ...data, spaceReady: null, requestedSpaces: data.requestedSpaces.map(entry =>
      entry.space === "account" ? { ...entry, spaceReady: null, spacePending: true } : entry) };
    expect(() => verifyScopedLogin(pending, key, did, requested)).not.toThrow();
    expect(() => verifyScopedLogin({ ...pending, spaceReady: true }, key, did, requested)).toThrow();
    expect(() => verifyScopedLogin({ ...data, requestedSpaces: data.requestedSpaces.slice(1) }, key, did, requested)).toThrow();
    expect(() => verifyScopedLogin({ ...data, requestedSpaces: undefined }, key, did, requested)).toThrow();
  });

  test("case variants cannot duplicate one readiness entry and omit the other space", async () => {
    const data = await fixture();
    const account = data.requestedSpaces.find(p => p.space === "account")!;
    expect(() => verifyScopedLogin({ ...data, requestedSpaces: [account, { ...account, spaceId: account.spaceId.toLowerCase() }] }, key, did, requested)).toThrow();
  });
  test("wire request sorts spaces canonically before OpenKey chooses its first route", () => {
    const result = scopedLoginPermissions([
      { service: "tinycloud.kv", space: "bravo", path: "", actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.kv", space: space("alpha"), path: "spaces/", actions: ["tinycloud.kv/list"] },
    ]);
    expect([...new Set(result.map(p => p.space))]).toEqual([space("alpha"), "bravo"]);
  });

});
