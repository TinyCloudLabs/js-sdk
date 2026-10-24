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

  test("persists prompt suppression after approved permissions are granted", async () => {
    const order: string[] = [];
    const suppressPromptFor30Days = mock(() => {
      order.push("suppressPromptFor30Days");
    });

    await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: async () => ({
        approved: true,
        suppressPromptFor30Days: true,
      }),
      suppressPromptFor30Days,
      grantPermissions: async () => {
        order.push("grantPermissions");
      },
    });

    expect(suppressPromptFor30Days).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["grantPermissions", "suppressPromptFor30Days"]);
  });

  test("does not persist prompt suppression when granting fails", async () => {
    const err = new Error("grant failed");
    const suppressPromptFor30Days = mock(() => {});

    await expect(
      requestPermissionsCore(additional, {
        manifest: baseManifest,
        showModal: async () => ({
          approved: true,
          suppressPromptFor30Days: true,
        }),
        suppressPromptFor30Days,
        grantPermissions: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);

    expect(suppressPromptFor30Days).not.toHaveBeenCalled();
  });

  test("does not persist prompt suppression when the user declines", async () => {
    const suppressPromptFor30Days = mock(() => {});
    const grantPermissions = mock(async () => {});

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: async () => ({
        approved: false,
        suppressPromptFor30Days: true,
      }),
      suppressPromptFor30Days,
      grantPermissions,
    });

    expect(result).toEqual({ approved: false });
    expect(grantPermissions).not.toHaveBeenCalled();
    expect(suppressPromptFor30Days).not.toHaveBeenCalled();
  });

  test("skips the modal when the page/app prompt is suppressed", async () => {
    const showModal = mock(async () => ({ approved: false }));
    const grantPermissions = mock(async () => {});

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal,
      isPromptSuppressed: () => true,
      grantPermissions,
    });

    expect(result).toEqual({ approved: true });
    expect(showModal).not.toHaveBeenCalled();
    expect(grantPermissions).toHaveBeenCalledWith(additional);
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

// ---------------------------------------------------------------------------
// expiryMs threading and validation
// ---------------------------------------------------------------------------

describe("requestPermissionsCore: expiryMs", () => {
  test("forwards expiryMs to grantPermissions", async () => {
    const grantPermissions = mock(async () => {});

    await requestPermissionsCore(
      additional,
      {
        manifest: baseManifest,
        showModal: async () => ({ approved: true }),
        grantPermissions,
      },
      { expiryMs: 3_600_000 },
    );

    expect(grantPermissions).toHaveBeenCalledWith(additional, { expiryMs: 3_600_000 });
  });

  test("passes no options to grantPermissions when expiryMs is absent", async () => {
    const grantPermissions = mock(async () => {});

    await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: async () => ({ approved: true }),
      grantPermissions,
    });

    expect(grantPermissions.mock.calls[0]?.[1]).toBeUndefined();
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    "throws before the modal when expiryMs is %p",
    async (expiryMs) => {
      const showModal = mock(() => Promise.resolve({ approved: true }));
      const grantPermissions = mock(async () => {});
      await expect(
        requestPermissionsCore(
          additional,
          {
            manifest: baseManifest,
            showModal,
            grantPermissions,
          },
          { expiryMs },
        ),
      ).rejects.toThrow(/expiryMs/);
      expect(showModal).not.toHaveBeenCalled();
      expect(grantPermissions).not.toHaveBeenCalled();
    },
  );
});

describe("requestPermissionsCore: decrypt expiryMs passthrough", () => {
  const decryptEntry: PermissionEntry = {
    service: "tinycloud.encryption",
    path: "urn:tinycloud:encryption:did:pkh:eip155:1:0x1:default",
    actions: ["tinycloud.encryption/decrypt"],
  };

  test("forwards a decrypt grant's expiryMs at 59 minutes", async () => {
    const grantPermissions = mock(async () => {});
    await requestPermissionsCore(
      [decryptEntry],
      {
        manifest: baseManifest,
        showModal: async () => ({ approved: true }),
        grantPermissions,
      },
      { expiryMs: 3_540_000 },
    );
    expect(grantPermissions).toHaveBeenCalledWith([decryptEntry], { expiryMs: 3_540_000 });
  });

  test("forwards a decrypt grant's expiryMs over one hour and reaches the modal", async () => {
    const showModal = mock(() => Promise.resolve({ approved: true }));
    const grantPermissions = mock(async () => {});
    await requestPermissionsCore(
      [decryptEntry],
      { manifest: baseManifest, showModal, grantPermissions },
      { expiryMs: 2_592_000_000 },
    );
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(grantPermissions).toHaveBeenCalledWith([decryptEntry], { expiryMs: 2_592_000_000 });
  });

  test("forwards a non-decrypt grant's expiryMs over one hour", async () => {
    const grantPermissions = mock(async () => {});
    await requestPermissionsCore(
      additional,
      {
        manifest: baseManifest,
        showModal: async () => ({ approved: true }),
        grantPermissions,
      },
      { expiryMs: 3_600_001 },
    );
    expect(grantPermissions).toHaveBeenCalledWith(additional, { expiryMs: 3_600_001 });
  });
});
