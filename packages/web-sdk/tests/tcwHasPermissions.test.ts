import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { TinyCloudWeb } from "../src/modules/tcw";

const entries: PermissionEntry[] = [
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/API_KEY", actions: ["get"] },
];

function instanceWith(state: Record<string, unknown>): TinyCloudWeb {
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWeb;
  Object.assign(tcw, state);
  return tcw;
}

describe("TinyCloudWeb.hasPermissions", () => {
  test("returns false before a node exists", () => {
    const tcw = instanceWith({ _node: null });
    expect(tcw.hasPermissions(entries)).toBe(false);
  });

  test("returns the node's answer for the same entries", () => {
    const hasRuntimePermissions = mock((_: PermissionEntry[]) => true);
    const tcw = instanceWith({ _node: { hasRuntimePermissions } });

    expect(tcw.hasPermissions(entries)).toBe(true);
    expect(hasRuntimePermissions).toHaveBeenCalledTimes(1);
    expect(hasRuntimePermissions.mock.calls[0]?.[0]).toBe(entries);
  });

  test("returns false when the node does not cover the entries", () => {
    const tcw = instanceWith({ _node: { hasRuntimePermissions: () => false } });
    expect(tcw.hasPermissions(entries)).toBe(false);
  });

  test("never opens the modal or grants permissions", () => {
    const showModal = mock(async () => ({ approved: true }));
    const grantPermissions = mock(async () => undefined);
    const grantRuntimePermissions = mock(async () => []);
    const tcw = instanceWith({
      _node: {
        hasRuntimePermissions: () => false,
        grantRuntimePermissions,
      },
      _testHooks: { showModal, grantPermissions },
    });

    expect(tcw.hasPermissions(entries)).toBe(false);
    expect(showModal).not.toHaveBeenCalled();
    expect(grantPermissions).not.toHaveBeenCalled();
    expect(grantRuntimePermissions).not.toHaveBeenCalled();
  });
});
