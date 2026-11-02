// A session lifetime that cannot be written as a sign-in message date is refused with a dated message before the
// signer or the WASM sees it, never as a raw `RangeError: Invalid time value` or `the 'year' component could not be
// parsed`. A lifetime up to the last second of 9999 stays legal (the former ten-year ceiling is gone).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MAX_SIWE_EXPIRY_MS } from "@tinycloud/sdk-core";

import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;
const DATED =
  "expiry is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry";
const NOT_A_DATE =
  "expiry is not a valid date or is too far away to hold; choose one before 9999-12-31";

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function create(sessionExpirationMs: number) {
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const signMessage = mock(signer.signMessage.bind(signer));
  signer.signMessage = signMessage;
  const wasmBindings = new NodeWasmBindings();
  const prepareSession = mock(wasmBindings.prepareSession.bind(wasmBindings));
  wasmBindings.prepareSession = prepareSession;
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    sessionExpirationMs,
  });
  return { auth, signer, signMessage, prepareSession };
}

describe("prepareSessionForSigning", () => {
  test("accepts a lifetime that ends on the last second of 9999 and prepares a message that carries it", async () => {
    const s = create(MAX_SIWE_EXPIRY_MS - Date.now() - 2_000);
    const { prepared } = await s.auth.prepareSessionForSigning();
    expect(/^Expiration Time: (.+)$/m.exec(prepared.siwe)?.[1]).toMatch(/^9999-12-31T23:59:5\d\.\d{3}Z$/);
  });

  test("accepts eleven and a hundred years", async () => {
    for (const years of [11, 100]) {
      const s = create(years * YEAR_MS);
      const { prepared } = await s.auth.prepareSessionForSigning();
      expect(Date.parse(/^Expiration Time: (.+)$/m.exec(prepared.siwe)![1]!)).toBeGreaterThan(Date.now() + (years - 1) * YEAR_MS);
    }
  });

  test("refuses a lifetime that ends after 9999 with the dated message before the WASM is called", async () => {
    const s = create(MAX_SIWE_EXPIRY_MS - Date.now() + 5_000);
    await expect(s.auth.prepareSessionForSigning()).rejects.toThrow(DATED);
    expect(s.prepareSession).not.toHaveBeenCalled();
  });

  test("refuses a lifetime too large for any date, such as ms('99999999y'), without a RangeError", async () => {
    for (const ms of [3.15e18, Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = create(ms);
      const refusal = await s.auth.prepareSessionForSigning().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).not.toBeInstanceOf(RangeError);
      expect((refusal as Error).message).toBe(NOT_A_DATE);
      expect(s.prepareSession).not.toHaveBeenCalled();
    }
  });
});

describe("signIn", () => {
  test("refuses a lifetime past 9999 before the wallet is asked to sign", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    const s = create(MAX_SIWE_EXPIRY_MS - Date.now() + 5_000);
    const refusal = await s.auth.signIn().catch((error: unknown) => error);
    expect((refusal as Error).message).toContain(DATED);
    expect(s.signMessage).not.toHaveBeenCalled();
    expect(s.prepareSession).not.toHaveBeenCalled();
  });
});

describe("createBootstrapSession", () => {
  test("refuses a lifetime past 9999 before the wallet is asked to sign", async () => {
    const s = create(3.15e18);
    (s.auth as unknown as { _address: string; _chainId: number })._address = await s.signer.getAddress();
    (s.auth as unknown as { _address: string; _chainId: number })._chainId = 1;
    const refusal = await s.auth
      .createBootstrapSession({ capabilityRequest: { resources: [], manifests: [] }, spaceId: "tinycloud:pkh:eip155:1:0x0:default" } as never)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(RangeError);
    expect((refusal as Error).message).toBe(NOT_A_DATE);
    expect(s.signMessage).not.toHaveBeenCalled();
    expect(s.prepareSession).not.toHaveBeenCalled();
  });
});
