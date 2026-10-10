import { describe, expect, test } from "bun:test";
import type { GetResult } from "../src/contracts/client";
import { acceptsOfflineCliExpiry, acceptedRefusalCodes, hasCliErrorEnvelopeCode } from "../src/scenarios/core-07-expiry";

const offlineRefusal = (overrides: Partial<GetResult> = {}): GetResult => ({
  ok: false, found: false, opSeq: 1, startedMono: 0, durationMs: 1, events: [], exit: 1, signal: null,
  code: "EXIT_1", stderr: "{\"error\":{\"code\":\"NETWORK_ERROR\"}}", ...overrides,
});

describe("CORE-07 CLI expiry policy", () => {
  test("requires supported refusal exits once TC-674 capability is present", () => {
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 3, code: "EXIT_3" }), true)).toBe(true);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 5, code: "EXIT_5" }), true)).toBe(true);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 1, code: "EXIT_1" }), true)).toBe(false);
  });

  test("without TC-674 accepts only coded non-zero refusals that have no local read", () => {
    for (const code of acceptedRefusalCodes) {
      const stderr = `[replication] expired\n${JSON.stringify({ error: { code } })}`;
      expect(acceptsOfflineCliExpiry(offlineRefusal({ stderr }), "TC-674 not landed")).toBe(true);
    }
    expect(hasCliErrorEnvelopeCode("NETWORK_ERROR was mentioned in a warning")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ code: "NETWORK_ERROR", stderr: "" }), "TC-674 not landed")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ exit: 0 }), "TC-674 not landed")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ stderr: "{\"error\":{\"code\":\"OTHER\"}}" }), "TC-674 not landed")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ ok: true }), "TC-674 not landed")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ read: { source: "replica" } }), "TC-674 not landed")).toBe(false);
    expect(acceptsOfflineCliExpiry(offlineRefusal({ events: [{ clientId: "reader", seq: 1, opSeq: 1, attribution: "op", recvMono: 1,
      event: { type: "replication.read", source: "replica" } }] }), "TC-674 not landed")).toBe(false);
  });
});
