/**
 * Unit tests for the capability subset check and the parseRecapCapabilities
 * wrapper.
 *
 * These tests do not touch the real WASM binding; they use stub
 * ParseRecapFromSiwe functions to exercise the normalization layer.
 */

import { describe, expect, it } from "bun:test";

import {
  PermissionNotInManifestError,
  SessionExpiredError,
  isCapabilitySubset,
  normalizeSpace,
  parseRecapCapabilities,
  type WasmRecapEntry,
} from "./capabilities";
import type { PermissionEntry } from "./manifest";

// ---------------------------------------------------------------------------
// isCapabilitySubset — exact match
// ---------------------------------------------------------------------------

describe("isCapabilitySubset — exact match", () => {
  const granted: PermissionEntry[] = [
    {
      service: "tinycloud.kv",
      space: "tinycloud:pkh:eip155:1:0xabc:default",
      path: "com.listen.app/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
  ];

  it("accepts an exact subset of the granted caps", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0xabc:default",
        path: "com.listen.app/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(true);
    expect(missing).toEqual([]);
  });

  it("accepts the exact same entry", () => {
    const { subset } = isCapabilitySubset(granted, granted);
    expect(subset).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCapabilitySubset — prefix containment
// ---------------------------------------------------------------------------

describe("isCapabilitySubset — prefix containment", () => {
  const granted: PermissionEntry[] = [
    {
      service: "tinycloud.kv",
      space: "s1",
      path: "com.listen.app/",
      actions: ["tinycloud.kv/get"],
    },
  ];

  it("accepts a nested path under a trailing-slash prefix", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "com.listen.app/sub/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    expect(isCapabilitySubset(requested, granted).subset).toBe(true);
  });

  it("accepts an exact key under a trailing-slash prefix", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "com.listen.app/foo",
        actions: ["tinycloud.kv/get"],
      },
    ];
    expect(isCapabilitySubset(requested, granted).subset).toBe(true);
  });

  it("rejects a path outside the prefix", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "other.app/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(false);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("other.app/");
  });

  it("treats / as matching everything", () => {
    const grantedAll: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "anything/deep/nested",
        actions: ["tinycloud.kv/get"],
      },
    ];
    expect(isCapabilitySubset(requested, grantedAll).subset).toBe(true);
  });

  it("enforces exact match when granted path has no trailing slash", () => {
    const exact: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "exact.key",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "exact.key.plus.more",
        actions: ["tinycloud.kv/get"],
      },
    ];
    expect(isCapabilitySubset(requested, exact).subset).toBe(false);
    // And the positive case:
    expect(
      isCapabilitySubset(
        [
          {
            service: "tinycloud.kv",
            space: "s1",
            path: "exact.key",
            actions: ["tinycloud.kv/get"],
          },
        ],
        exact
      ).subset
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCapabilitySubset — action subset
// ---------------------------------------------------------------------------

describe("isCapabilitySubset — action subset", () => {
  const granted: PermissionEntry[] = [
    {
      service: "tinycloud.kv",
      space: "s1",
      path: "app/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
  ];

  it("accepts a proper subset of actions", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "app/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    expect(isCapabilitySubset(requested, granted).subset).toBe(true);
  });

  it("rejects when an action is missing", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "app/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/del"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(false);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.actions).toContain("tinycloud.kv/del");
  });

  it("accepts short-name actions that expand to a granted URN", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "app/",
        actions: ["get"], // expands to "tinycloud.kv/get"
      },
    ];
    expect(isCapabilitySubset(requested, granted).subset).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCapabilitySubset — space and service mismatches
// ---------------------------------------------------------------------------

describe("isCapabilitySubset — space and service mismatches", () => {
  const granted: PermissionEntry[] = [
    {
      service: "tinycloud.kv",
      space: "space-a",
      path: "app/",
      actions: ["tinycloud.kv/get"],
    },
  ];

  it("rejects a space mismatch", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "space-b",
        path: "app/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(false);
    expect(missing[0]?.space).toBe("space-b");
  });

  it("rejects a service mismatch", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.sql",
        space: "space-a",
        path: "app/",
        actions: ["tinycloud.sql/read"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(false);
    expect(missing[0]?.service).toBe("tinycloud.sql");
  });

  it("collects multiple missing entries in one pass", () => {
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "space-a",
        path: "app/",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.sql",
        space: "space-a",
        path: "app/",
        actions: ["tinycloud.sql/read"],
      },
      {
        service: "tinycloud.kv",
        space: "other-space",
        path: "app/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(false);
    expect(missing).toHaveLength(2);
    const missingServices = missing.map((m) => `${m.service}|${m.space}`);
    expect(missingServices).toContain("tinycloud.sql|space-a");
    expect(missingServices).toContain("tinycloud.kv|other-space");
  });
});

// ---------------------------------------------------------------------------
// parseRecapCapabilities
// ---------------------------------------------------------------------------

describe("parseRecapCapabilities", () => {
  it("normalizes short-form services to the long form", () => {
    const stub = (): WasmRecapEntry[] => [
      {
        service: "kv",
        space: "tinycloud:pkh:eip155:1:0xabc:default",
        path: "com.listen.app/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
      {
        service: "sql",
        space: "tinycloud:pkh:eip155:1:0xabc:default",
        path: "com.listen.app/",
        actions: ["tinycloud.sql/read"],
      },
    ];
    const entries = parseRecapCapabilities(stub, "stub-siwe");
    expect(entries).toHaveLength(2);
    const services = entries.map((e) => e.service).sort();
    expect(services).toEqual(["tinycloud.kv", "tinycloud.sql"]);
  });

  it("passes long-form services through unchanged", () => {
    const stub = (): WasmRecapEntry[] => [
      {
        service: "tinycloud.kv",
        space: "s1",
        path: "/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const entries = parseRecapCapabilities(stub, "stub-siwe");
    expect(entries[0]?.service).toBe("tinycloud.kv");
  });

  it("returns an empty array when the WASM binding returns an empty array", () => {
    const stub = (): WasmRecapEntry[] => [];
    expect(parseRecapCapabilities(stub, "")).toEqual([]);
  });

  it("sorts entries deterministically by (space, service, path)", () => {
    const stub = (): WasmRecapEntry[] => [
      {
        service: "sql",
        space: "space-b",
        path: "app/",
        actions: ["tinycloud.sql/read"],
      },
      {
        service: "kv",
        space: "space-a",
        path: "app/",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "kv",
        space: "space-a",
        path: "other/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const entries = parseRecapCapabilities(stub, "stub-siwe");
    expect(entries.map((e) => `${e.space}|${e.service}|${e.path}`)).toEqual([
      "space-a|tinycloud.kv|app/",
      "space-a|tinycloud.kv|other/",
      "space-b|tinycloud.sql|app/",
    ]);
  });

  it("hands off parsed entries to isCapabilitySubset cleanly", () => {
    const stub = (): WasmRecapEntry[] => [
      {
        service: "kv",
        space: "space-a",
        path: "com.listen.app/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];
    const granted = parseRecapCapabilities(stub, "stub-siwe");
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "space-a",
        path: "com.listen.app/data",
        actions: ["tinycloud.kv/get"],
      },
    ];
    expect(isCapabilitySubset(requested, granted).subset).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe("PermissionNotInManifestError", () => {
  it("exposes missing and granted on the instance", () => {
    const missing: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "s",
        path: "p",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const granted: PermissionEntry[] = [];
    const err = new PermissionNotInManifestError(missing, granted);
    expect(err.name).toBe("PermissionNotInManifestError");
    expect(err.missing).toEqual(missing);
    expect(err.granted).toEqual(granted);
    expect(err.message).toContain("Missing 1 entries");
  });
});

describe("SessionExpiredError", () => {
  it("exposes the expiredAt Date on the instance", () => {
    const when = new Date("2024-01-01T00:00:00.000Z");
    const err = new SessionExpiredError(when);
    expect(err.name).toBe("SessionExpiredError");
    expect(err.expiredAt).toEqual(when);
    expect(err.message).toBe("Session expired at 2024-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// normalizeSpace
// ---------------------------------------------------------------------------

describe("normalizeSpace", () => {
  it("passes short names through unchanged", () => {
    expect(normalizeSpace("default")).toBe("default");
    expect(normalizeSpace("work-space")).toBe("work-space");
    expect(normalizeSpace("")).toBe("");
  });

  it("extracts the name from a full pkh URI", () => {
    expect(
      normalizeSpace(
        "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:default"
      )
    ).toBe("default");
    expect(
      normalizeSpace(
        "tinycloud:pkh:eip155:1:0xabc0000000000000000000000000000000000000:work-space"
      )
    ).toBe("work-space");
  });

  it("returns the original string on a trailing-colon URI (degrades to strict mismatch)", () => {
    const malformed = "tinycloud:pkh:eip155:1:0xabc:";
    expect(normalizeSpace(malformed)).toBe(malformed);
  });

  it("passes non-tinycloud URIs through unchanged", () => {
    expect(normalizeSpace("did:key:z6Mk")).toBe("did:key:z6Mk");
    expect(normalizeSpace("foo")).toBe("foo");
  });
});

describe("isCapabilitySubset with mixed space forms", () => {
  const fullUri =
    "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:default";

  it("matches short-form requested against full-URI granted (recap parse direction)", () => {
    const granted: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: fullUri,
        path: "",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "default",
        path: "",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(true);
    expect(missing).toEqual([]);
  });

  it("matches full-URI requested against short-form granted (defensive symmetric)", () => {
    const granted: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "default",
        path: "",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: fullUri,
        path: "",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(true);
    expect(missing).toEqual([]);
  });

  it("still rejects mismatched space names regardless of form", () => {
    const granted: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: fullUri,
        path: "",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const requested: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "work-space",
        path: "",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const { subset, missing } = isCapabilitySubset(requested, granted);
    expect(subset).toBe(false);
    expect(missing).toHaveLength(1);
  });
});

describe("parseRecapCapabilities normalizes space", () => {
  it("converts a full pkh URI from the recap to the short name", () => {
    const parseWasm = (_siwe: string): WasmRecapEntry[] => [
      {
        service: "kv",
        space:
          "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:default",
        path: "",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];
    const out = parseRecapCapabilities(parseWasm, "fake-siwe");
    expect(out).toEqual([
      {
        service: "tinycloud.kv",
        space: "default",
        path: "",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ]);
  });

  it("passes short-name spaces through (forward compatibility)", () => {
    const parseWasm = (_siwe: string): WasmRecapEntry[] => [
      {
        service: "sql",
        space: "default",
        path: "",
        actions: ["tinycloud.sql/read"],
      },
    ];
    const out = parseRecapCapabilities(parseWasm, "fake-siwe");
    expect(out[0].space).toBe("default");
  });
});
