import { describe, expect, test } from "bun:test";
import type { GetResult } from "../src/contracts/client";
import { acceptsOfflineCliExpiry } from "../src/scenarios/core-07-expiry";

const offlineRefusal = (overrides: Partial<GetResult> = {}): GetResult => ({
  ok: false, found: false, opSeq: 1, startedMono: 0, durationMs: 1, events: [], exit: 1, signal: null, code: "AUTH_REQUIRED", ...overrides,
});

describe("CORE-07 CLI expiry policy", () => {
  test("requires supported refusal exits once TC-674 capability is present", () => {
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 3 }), true)).toBe(true);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 5 }), true)).toBe(true);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 1 }), true)).toBe(false);
  });

  test("without TC-674 accepts only coded non-zero refusals that have no local read", () => {
    for (const code of ["AUTH_REQUIRED", "GRANT_EXPIRED", "NETWORK_ERROR"]) {
      expect(acceptsOfflineCliExpiry(offlineRefusal({ code }), "requirement probe unavailable")).toBe(true);
    }
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 0 }), "requirement probe unavailable")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ code: "OTHER" }), "requirement probe unavailable")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ ok: true }), "requirement probe unavailable")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ read: { source: "replica" } }), "requirement probe unavailable")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ events: [{ clientId: "reader", seq: 1, opSeq: 1, attribution: "op", recvMono: 1,
      event: { type: "replication.read", source: "replica" } }] }), "requirement probe unavailable")).toBe(false);
  });
});
