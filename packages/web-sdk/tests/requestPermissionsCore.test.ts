/**
 * Control-flow tests for the `requestPermissionsCore` helper.
 *
 * The core is where the escalation state machine lives — this test
 * file covers every branch without touching the real modal, the real
 * wallet, or the real WASM.
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  ClientSession,
  Manifest,
  PermissionEntry,
} from "@tinycloud/sdk-core";

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

function fakeSession(): ClientSession {
  return {
    address: "0x0000000000000000000000000000000000000001",
    walletAddress: "0x0000000000000000000000000000000000000001",
    chainId: 1,
    sessionKey: "default",
    siwe: "fake-siwe",
    signature: "0xfake",
  };
}

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
  test("returns { approved: false } and does not sign out / sign in", async () => {
    const showModal = mock(() => Promise.resolve({ approved: false }));
    const signOut = mock(() => Promise.resolve());
    const signIn = mock(() => Promise.resolve(fakeSession()));
    const writeManifest = mock(() => {});

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: showModal as any,
      signOut,
      signIn,
      writeManifest,
    });

    expect(result).toEqual({ approved: false });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
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
      signOut: async () => {},
      signIn: async () => fakeSession(),
      writeManifest: () => {},
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
  test("composes expanded manifest, signs out, signs in, returns session", async () => {
    const order: string[] = [];
    const newSession = fakeSession();
    let writtenManifest: Manifest | undefined;

    const result = await requestPermissionsCore(additional, {
      manifest: baseManifest,
      showModal: async () => {
        order.push("modal");
        return { approved: true };
      },
      signOut: async () => {
        order.push("signOut");
      },
      signIn: async () => {
        order.push("signIn");
        return newSession;
      },
      writeManifest: (next) => {
        order.push("writeManifest");
        writtenManifest = next;
      },
    });

    expect(result).toEqual({ approved: true, session: newSession });

    // Order: modal → writeManifest → signOut → signIn. writeManifest
    // must come before signOut so a Phase 5 signIn refactor that reads
    // `_manifest` at the start of signIn sees the composed manifest.
    expect(order).toEqual(["modal", "writeManifest", "signOut", "signIn"]);

    // Composed manifest contains the original + additional entries.
    expect(writtenManifest?.permissions).toEqual([
      ...(baseManifest.permissions ?? []),
      ...additional,
    ]);
    // Other manifest fields pass through unchanged.
    expect(writtenManifest?.app_id).toBe(baseManifest.app_id);
    expect(writtenManifest?.name).toBe(baseManifest.name);
  });

  test("handles a manifest with no pre-existing permissions array", async () => {
    const manifestNoPerms: Manifest = {
      app_id: "com.test.app",
      name: "Test",
    };
    let written: Manifest | undefined;

    await requestPermissionsCore(additional, {
      manifest: manifestNoPerms,
      showModal: async () => ({ approved: true }),
      signOut: async () => {},
      signIn: async () => fakeSession(),
      writeManifest: (next) => {
        written = next;
      },
    });

    expect(written?.permissions).toEqual(additional);
  });

  test("propagates signIn errors without swallowing", async () => {
    const err = new Error("signIn failed");
    await expect(
      requestPermissionsCore(additional, {
        manifest: baseManifest,
        showModal: async () => ({ approved: true }),
        signOut: async () => {},
        signIn: async () => {
          throw err;
        },
        writeManifest: () => {},
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
        signOut: async () => {},
        signIn: async () => fakeSession(),
        writeManifest: () => {},
      }),
    ).rejects.toThrow(/non-empty/);
    expect(showModal).not.toHaveBeenCalled();
  });
});
