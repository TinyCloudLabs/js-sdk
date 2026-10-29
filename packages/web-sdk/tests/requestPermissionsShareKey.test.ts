import { describe, expect, mock, test } from "bun:test";
import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";
import { requestPermissionsCore } from "../src/modules/requestPermissionsCore";

const ownerDid = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const path = `urn:tinycloud:encryption:${ownerDid}:default/share/consent-key`;
const manifest: Manifest = { app_id: "test.exact-key-consent", name: "Exact key consent" };
const request = (overrides: Partial<PermissionEntry> = {}): PermissionEntry[] => [{
  service: "tinycloud.encryption",
  path,
  actions: ["key.create"],
  ...overrides,
}];

// These test the normalization/consent boundary, not signed authority. The
// companion public-method suite uses the real Node/WASM activation fixture.
describe("Share-key runtime consent normalization", () => {
  test("normalizes the exact request before consent without mutating caller data", async () => {
    const additional = request();
    const before = structuredClone(additional);
    const grantPermissions = mock(async () => {});
    const showModal = mock(async (_options: unknown) => ({ approved: false }));
    const deps = { manifest, ownerDid, showModal, grantPermissions };

    expect(await requestPermissionsCore(additional, deps)).toEqual({ approved: false });
    expect(showModal.mock.calls[0]?.[0]).toEqual({
      appName: manifest.name,
      appIcon: undefined,
      additional: [{
        service: "tinycloud.encryption", space: "encryption", path,
        actions: ["tinycloud.encryption/key.create"], skipPrefix: true,
      }],
    });
    expect(additional).toEqual(before);
    expect(grantPermissions).not.toHaveBeenCalled();
    expect(manifest.permissions).toBeUndefined();
  });

  for (const [name, overrides] of [
    ["foreign owner", { path: path.replace(ownerDid, "did:pkh:eip155:1:0x0000000000000000000000000000000000000001") }],
    ["foreign network", { path: path.replace(":default/", ":other/") }],
    ["prefix", { path: path.replace("consent-key", "") }],
    ["nested key", { path: `${path}/nested` }],
    ["wildcard", { path: path.replace("consent-key", "*") }],
    ["mixed actions", { actions: ["key.create", "decrypt"] }],
  ] as Array<[string, Partial<PermissionEntry>]>) {
    for (const suppressed of [false, true]) {
      test(`refuses ${name} before effects (suppressed=${suppressed})`, async () => {
        const showModal = mock(async () => ({ approved: true }));
        const grantPermissions = mock(async () => {});
        const deps = {
          manifest, ownerDid, showModal, grantPermissions,
          isPromptSuppressed: () => suppressed,
        };
        await expect(requestPermissionsCore(request(overrides), deps)).rejects.toThrow();
        expect(showModal).not.toHaveBeenCalled();
        expect(grantPermissions).not.toHaveBeenCalled();
      });
    }
  }

  test("does not infer the owner from an otherwise valid request", async () => {
    const showModal = mock(async () => ({ approved: true }));
    const grantPermissions = mock(async () => {});
    await expect(requestPermissionsCore(request(), {
      manifest, showModal, grantPermissions,
    })).rejects.toThrow();
    expect(showModal).not.toHaveBeenCalled();
    expect(grantPermissions).not.toHaveBeenCalled();
  });
});
