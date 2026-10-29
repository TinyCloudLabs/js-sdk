import { describe, expect, test } from "bun:test";
import {
  expandDelegationPermissionEntries,
  expandPermissionEntries,
  expandRuntimePermissionEntries,
  type PermissionEntry,
} from "./manifest";

const OWNER = "did:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const KEY = `${NETWORK}/share/transcript-2192`;
const request: PermissionEntry = {
  service: "tinycloud.encryption", path: KEY, actions: ["tinycloud.encryption/key.create"],
};

describe("runtime-only exact Share key creation", () => {
  test("normalizes the consented exact capability without changing the caller's request", () => {
    const before = structuredClone(request);
    expect(expandRuntimePermissionEntries([request], OWNER)).toEqual([{
      ...request, space: "encryption", skipPrefix: true,
    }]);
    expect(request).toEqual(before);
    expect(expandRuntimePermissionEntries([{ ...request, actions: ["key.create"] }], OWNER)).toEqual(
      expandRuntimePermissionEntries([request], OWNER),
    );
  });

  test("canonicalizes authenticated owner context, never a noncanonical requested resource", () => {
    expect(expandRuntimePermissionEntries([request], OWNER.toLowerCase())[0]?.path).toBe(KEY);
    expect(() => expandRuntimePermissionEntries([{ ...request, path: KEY.toLowerCase() }], OWNER)).toThrow();
  });

  test.each([
    NETWORK, `${NETWORK}/share/`, `${NETWORK}/share/*`, `${KEY}/child`,
    `${NETWORK}/apps/transcript/key`, `${NETWORK}/share/../key`, `${NETWORK}/share/%61`,
    `${KEY}?other=1`,
    `urn:tinycloud:encryption:${OWNER}:other/share/transcript-2192`,
    "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default/share/transcript-2192",
  ])("rejects non-exact, non-default or foreign resource %s", (path) => {
    expect(() => expandRuntimePermissionEntries([{ ...request, path }], OWNER)).toThrow();
  });

  test.each([[], ["decrypt"], ["key.delete"], ["key.block"], ["network.create"], ["key.create", "decrypt"], ["*"], ["tinycloud.encryption/*"]].map((actions) => ({ actions })))(
    "rejects actions outside exact key.create: %j", ({ actions }) => {
      expect(() => expandRuntimePermissionEntries([{ ...request, actions }], OWNER)).toThrow();
    },
  );

  test("requires authenticated context and refuses conflicting space labels", () => {
    expect(() => expandRuntimePermissionEntries([request])).toThrow();
    expect(() => expandRuntimePermissionEntries([{ ...request, space: "account" }], OWNER)).toThrow();
    expect(() => expandRuntimePermissionEntries([{ ...request, space: `tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default` }], OWNER)).toThrow();
  });

  test("preserves caveats and rejects this authority in static and child-delegation expanders", () => {
    const caveated = { ...request, caveats: [{ limit: 1 }] };
    expect(expandRuntimePermissionEntries([caveated], OWNER)[0]?.caveats).toEqual([{ limit: 1 }]);
    expect(() => expandPermissionEntries([request])).toThrow("manifest.keys");
    expect(() => expandDelegationPermissionEntries([request])).toThrow();
  });

  test("leaves existing static permissions and explicit named decrypt delegation unchanged", () => {
    const existing: PermissionEntry[] = [
      { service: "tinycloud.encryption", path: NETWORK, actions: ["decrypt"] },
      { service: "tinycloud.encryption", path: `${NETWORK}/share/`, actions: ["decrypt"] },
      { service: "tinycloud.kv", space: "applications", path: "notes/", actions: ["get"] },
    ];
    expect(expandRuntimePermissionEntries(existing, OWNER)).toEqual(expandPermissionEntries(existing));
    expect(expandDelegationPermissionEntries([{ ...request, actions: ["decrypt"] }])[0]?.actions).toEqual(["tinycloud.encryption/decrypt"]);
  });
});
