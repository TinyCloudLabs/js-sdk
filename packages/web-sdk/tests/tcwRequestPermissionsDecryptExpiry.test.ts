import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

// Loaded from the built bundle, like tcwHasPermissions.test.ts: other test
// files mock "../src/modules/tcw" process-wide under bun test.
const { TinyCloudWeb } = require("../dist/index.cjs") as {
  TinyCloudWeb: typeof TinyCloudWebType;
};

const manifest = {
  app_id: "com.test.app",
  name: "Test App",
  icon: "https://example.com/icon.png",
  permissions: [],
};

const decryptEntry: PermissionEntry = {
  service: "tinycloud.encryption",
  space: "secrets",
  path: "encryption-network",
  actions: ["decrypt"],
  skipPrefix: true,
};

function instanceWith(state: Record<string, unknown>): TinyCloudWebType {
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  // `session` is an arrow property set in the constructor, which Object.create skips.
  Object.assign(tcw, { session: () => undefined, ...state });
  return tcw;
}

describe("TinyCloudWeb.requestPermissions: decrypt expiry", () => {
  test("passes expiryMs to the node grant as expiry", async () => {
    const grantRuntimePermissions = mock(async () => []);
    const tcw = instanceWith({
      _manifest: manifest,
      _node: {
        hasRuntimePermissions: () => false,
        grantRuntimePermissions,
      },
      _testHooks: { showModal: async () => ({ approved: true }) },
    });

    await tcw.requestPermissions([decryptEntry], { expiryMs: 3_540_000 });

    expect(grantRuntimePermissions).toHaveBeenCalledTimes(1);
    expect(grantRuntimePermissions).toHaveBeenCalledWith([decryptEntry], {
      expiry: 3_540_000,
    });
  });

  test("passes no expiry to the node grant when expiryMs is absent", async () => {
    const grantRuntimePermissions = mock(async () => []);
    const tcw = instanceWith({
      _manifest: manifest,
      _node: {
        hasRuntimePermissions: () => false,
        grantRuntimePermissions,
      },
      _testHooks: { showModal: async () => ({ approved: true }) },
    });

    await tcw.requestPermissions([decryptEntry]);

    expect(grantRuntimePermissions).toHaveBeenCalledTimes(1);
    expect(grantRuntimePermissions).toHaveBeenCalledWith([decryptEntry], undefined);
  });
});
