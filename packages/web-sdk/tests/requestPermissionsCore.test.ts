/**
 * Control-flow tests for the `requestPermissionsCore` helper.
 *
 * The core is where the escalation state machine lives — this test
 * file covers every branch without touching the real modal, the real
 * wallet, or the real WASM.
 */

import { describe, expect, mock, test } from "bun:test";

import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";

import {
  requestPermissionsCore,
  validateAdditionalPermissions,
} from "../src/modules/requestPermissionsCore";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseManifest: Manifest = {
  app_id: "com.test.app",
  name: "Test App",
  icon: "https://example.com/icon.png",
  permissions: [
    {
      service: "tinycloud.kv",
      space: "default",
      path: "items/",
      actions: ["tinycloud.kv/get"],
    },
  ],
};

const additional: PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: "default",
    path: "items/",
    actions: ["tinycloud.kv/put"],
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateAdditionalPermissions", () => {
  test("throws on empty array", () => {
    expect(() => validateAdditionalPermissions([])).toThrow(/non-empty/);
  });

  test("throws on non-array", () => {
    // We deliberately cast an invalid value to exercise the runtime guard.
    expect(() =>
      validateAdditionalPermissions(undefined as unknown as PermissionEntry[]),
    ).toThrow(/non-empty/);
  });

  test("accepts a populated array", () => {
    expect(() => validateAdditionalPermissions(additional)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Decline path
// ---------------------------------------------------------------------------

describe("requestPermissionsCore: decline", () => {
  test("returns { approved: false } and does not grant permissions", async () => {
    const showModal = mock(() => Promise.resolve({ approved: false }));
    const grantPermissions = mock(() => Promise.resolve());

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: showModal as any,
      grantPermissions,
    });

    expect(result).toEqual({ approved: false });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(grantPermissions).not.toHaveBeenCalled();
  });

  test("passes the manifest name + icon + additional to the modal", async () => {
    let seenOpts: any;
    const showModal = mock((opts: any) => {
      seenOpts = opts;
      return Promise.resolve({ approved: false });
    });

    await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: showModal as any,
      grantPermissions: async () => {},
    });

    expect(seenOpts.appName).toBe("Test App");
    expect(seenOpts.appIcon).toBe("https://example.com/icon.png");
    expect(seenOpts.additional).toEqual(additional);
  });
});

// ---------------------------------------------------------------------------
// Approve path
// ---------------------------------------------------------------------------

describe("requestPermissionsCore: approve", () => {
  test("stores approved runtime permissions", async () => {
    const order: string[] = [];
    let granted: PermissionEntry[] | undefined;

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: async () => {
        order.push("modal");
        return { approved: true };
      },
      grantPermissions: async (next) => {
        order.push("grantPermissions");
        granted = next;
      },
    });

    expect(result).toEqual({ approved: true });
    expect(order).toEqual(["modal", "grantPermissions"]);
    expect(granted).toEqual(additional);
  });

  test("returns runtime delegations from the grant step", async () => {
    const delegation = { cid: "runtime-cid" } as any;

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: async () => ({ approved: true }),
      grantPermissions: async () => [delegation],
    });

    expect(result).toEqual({
      approved: true,
      delegations: [delegation],
    });
  });

  test("does not mutate a manifest with no pre-existing permissions array", async () => {
    const manifestNoPerms: Manifest = {
      app_id: "com.test.app",
      name: "Test",
    };
    const grantPermissions = mock(async () => {});

    await requestPermissionsCore(additional, {
      manifest: manifestNoPerms,
      showModal: async () => ({ approved: true }),
      grantPermissions,
    });

    expect(manifestNoPerms.permissions).toBeUndefined();
    expect(grantPermissions).toHaveBeenCalledWith(additional);
  });

  test("propagates grant errors without swallowing", async () => {
    const err = new Error("grant failed");
    await expect(
      requestPermissionsCore(additional, {
        manifest: baseManifest,
        showModal: async () => ({ approved: true }),
        grantPermissions: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// Empty input guard (also checked by the core before anything else)
// ---------------------------------------------------------------------------

describe("requestPermissionsCore: validation", () => {
  test("throws before calling the modal when additional is empty", async () => {
    const showModal = mock(() => Promise.resolve({ approved: true }));
    await expect(
      requestPermissionsCore([], {
        manifest: baseManifest,
        showModal: showModal as any,
        grantPermissions: async () => {},
      }),
    ).rejects.toThrow(/non-empty/);
    expect(showModal).not.toHaveBeenCalled();
  });
});
