// The two technical expiry limits at the SDK boundary (no 10-year policy):
//  - a wallet-signed message (owner delegation, sub-delegation, runtime grant, wallet-path delegation) can carry any
//    expiry up to 9999-12-31T23:59:59Z;
//  - a token signed by the session key (delegateTo, agent and share delegations) can carry any expiry up to
//    2255-06-05T23:47:34Z, because the WASM builder fails beyond it.
// A value past either limit is refused with a dated message BEFORE the signer or the WASM is called.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  MAX_SIWE_EXPIRY_MS,
  MAX_UCAN_EXPIRY_MS,
  type IWasmBindings,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;
const SIWE_DATED =
  "expiry is later than 9999-12-31, the latest date a TinyCloud signed message can carry; choose an earlier expiry";
const UCAN_DATED =
  "expiry is later than 2255-06-05, the latest date an agent or share delegation can carry (UCAN limit); a delegation signed by the wallet (delegateTo with forceWalletSign: true) can go to 9999-12-31; choose an earlier expiry";
const NOT_A_DATE =
  "expiry is not a valid date or is too far away to hold; choose one before 9999-12-31";
const WASM_UCAN_RANGE = "Out of valid microsecond-precision range of NumericDate";

const PRIVATE_KEY = "1".padStart(64, "0");
const HOST = "https://node.example";

let originalFetch: typeof globalThis.fetch;
let registry: UnregisteredLocationRegistry;
beforeAll(() => {
  registry = startUnregisteredLocationRegistry();
});
afterAll(() => {
  registry?.stop(true);
});

function registryMetadata(input: string | URL | Request, init?: RequestInit): Promise<Response> | undefined {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`${registry.url.origin}/`)) return originalFetch(input, init);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    registryMetadata(input, init) ?? new Response(JSON.stringify({ activated: [], skipped: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The real WASM with spies on the two calls a refused expiry must never reach. */
function spiedWasm() {
  const wasm = new NodeWasmBindings();
  const prepareSession = mock(wasm.prepareSession.bind(wasm));
  const createDelegation = mock(wasm.createDelegation.bind(wasm));
  wasm.prepareSession = prepareSession;
  wasm.createDelegation = createDelegation;
  return { wasm, prepareSession, createDelegation };
}

async function ownerNode() {
  const spied = spiedWasm();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const signMessage = mock(signer.signMessage.bind(signer));
  signer.signMessage = signMessage;
  const address = await signer.getAddress();
  const node = new TinyCloudNode({
    host: HOST,
    tinycloudRegistryUrl: registry.url.origin,
    domain: "limits.test",
    signer,
    wasmBindings: spied.wasm,
    autoBootstrapAccount: false,
  });
  const spaceId = spied.wasm.makeSpaceId(address, 1, "applications");
  const restored = { address, chainId: 1, spaceId };
  Object.assign(node, { _restoredTcSession: restored });
  const manager = spied.wasm.createSessionManager();
  const audience = manager.getDID("default").split("#", 1)[0]!;
  return { ...spied, node, signMessage, spaceId, audience };
}

function ownerParams(s: Awaited<ReturnType<typeof ownerNode>>, expiresAt: Date) {
  return {
    delegateDid: s.audience,
    spaceId: s.spaceId,
    path: "shares/doc.md",
    actions: ["tinycloud.kv/get"],
    expiresAt,
  };
}

describe("createOwnerDelegation", () => {
  test("accepts eleven years, a hundred years and the last second of 9999, and signs the date it was given", async () => {
    for (const expiresAt of [
      new Date(Date.now() + 11 * YEAR_MS),
      new Date(Date.now() + 100 * YEAR_MS),
      new Date(MAX_SIWE_EXPIRY_MS),
    ]) {
      const s = await ownerNode();
      const receipt = await s.node.createOwnerDelegation(ownerParams(s, expiresAt));
      expect(s.signMessage).toHaveBeenCalledTimes(1);
      const prepared = s.prepareSession.mock.calls[0]![0] as { expirationTime: string };
      expect(prepared.expirationTime).toBe(expiresAt.toISOString());
      expect(receipt.delegation.expiry).toEqual(expiresAt);
    }
  });

  test("accepts what the old ten-year limit refused: ten years and one day", async () => {
    const s = await ownerNode();
    await s.node.createOwnerDelegation(ownerParams(s, new Date(Date.now() + 10 * YEAR_MS + DAY_MS)));
    expect(s.signMessage).toHaveBeenCalledTimes(1);
  });

  test("refuses one second after the last second of 9999 with the dated message, before the wallet is asked", async () => {
    const s = await ownerNode();
    await expect(s.node.createOwnerDelegation(ownerParams(s, new Date(MAX_SIWE_EXPIRY_MS + 1000)))).rejects.toThrow(SIWE_DATED);
    expect(s.signMessage).not.toHaveBeenCalled();
    expect(s.prepareSession).not.toHaveBeenCalled();
  });

  test("refuses a five-digit year, the largest Date and an invalid Date before the wallet is asked", async () => {
    for (const [expiresAt, message] of [
      [new Date(Date.UTC(10000, 0, 1)), SIWE_DATED],
      [new Date(8.64e15), SIWE_DATED],
      [new Date(Number.NaN), NOT_A_DATE],
      [new Date(8.64e15 + 1), NOT_A_DATE],
    ] as const) {
      const s = await ownerNode();
      const refusal = await s.node.createOwnerDelegation(ownerParams(s, expiresAt)).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).not.toBeInstanceOf(RangeError);
      expect((refusal as Error).message).toBe(message);
      expect(s.signMessage).not.toHaveBeenCalled();
      expect(s.prepareSession).not.toHaveBeenCalled();
    }
  });

  test("still refuses an expiry that is not a Date, in the past or now, and keeps its wording", async () => {
    const s = await ownerNode();
    for (const expiresAt of [new Date(Date.now() - 1000), "2030-01-01T00:00:00Z" as unknown as Date]) {
      await expect(s.node.createOwnerDelegation(ownerParams(s, expiresAt))).rejects.toThrow(
        "Owner delegation expiry must be explicit, future, and a valid date",
      );
    }
    expect(s.signMessage).not.toHaveBeenCalled();
  });
});

describe("the WASM accepts what the SDK now lets through", () => {
  // Real prepareSession + completeSessionSetup, the same calls createOwnerDelegation makes.
  test("a wallet-signed session to the last second of 9999 round-trips, a year later does not", async () => {
    const wasm = new NodeWasmBindings();
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const address = await signer.getAddress();
    const manager = wasm.createSessionManager();
    const base = {
      abilities: { kv: { "": ["tinycloud.kv/get"] } },
      address,
      chainId: 1,
      domain: "limits.test",
      spaceId: wasm.makeSpaceId(address, 1, "applications"),
      jwk: JSON.parse(manager.jwk("default")!),
      issuedAt: new Date().toISOString(),
    };
    const prepared = wasm.prepareSession({ ...base, expirationTime: new Date(MAX_SIWE_EXPIRY_MS).toISOString() });
    const session = wasm.completeSessionSetup({ ...prepared, signature: await signer.signMessage(prepared.siwe) });
    expect(session.delegationCid).toBeTruthy();
    expect(() => wasm.prepareSession({ ...base, expirationTime: "+010000-01-01T00:00:00.000Z" })).toThrow();
  });
});

describe("the child token limit", () => {
  async function signedSessionTo9999() {
    const spied = spiedWasm();
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const address = await signer.getAddress();
    const manager = spied.wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const spaceId = spied.wasm.makeSpaceId(address, 1, "applications");
    const prepared = spied.wasm.prepareSession({
      abilities: { kv: { "": ["tinycloud.kv/get"] } },
      address,
      chainId: 1,
      domain: "limits.test",
      spaceId,
      jwk,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(MAX_SIWE_EXPIRY_MS).toISOString(),
    });
    const session = spied.wasm.completeSessionSetup({ ...prepared, signature: await signer.signMessage(prepared.siwe) });
    spied.prepareSession.mockClear();
    const node = new TinyCloudNode({ host: HOST, tinycloudRegistryUrl: registry.url.origin, wasmBindings: spied.wasm });
    const wasmSession = {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      jwk,
      spaceId,
      verificationMethod: manager.getDID("default").split("#", 1)[0]!,
    };
    const audience = manager.getDID("default").split("#", 1)[0]!;
    const abilities = { kv: { "vault/": ["tinycloud.kv/get"] } };
    // What createDelegationWrapper does, minus the SDK's own check: the WASM call as it would be made.
    const direct = (expirationSecs: number) => spied.wasm.createDelegation(wasmSession, audience, spaceId, abilities, expirationSecs, 0);
    // The SDK's wrapper, which every delegateTo, agent grant and share delegation goes through.
    const wrapper = (expirationSecs: number) =>
      (node as unknown as { createDelegationWrapper(p: unknown): { expiry: Date } }).createDelegationWrapper({
        session: { ...wasmSession, verificationMethod: manager.getDID("default") },
        delegateDID: audience,
        spaceId,
        abilities,
        expirationSecs,
      });
    return { ...spied, wrapper, direct };
  }

  test("the WASM itself accepts 2255-06-05T23:47:34Z and fails one second later (why the SDK checks first)", async () => {
    const s = await signedSessionTo9999();
    expect(s.direct(MAX_UCAN_EXPIRY_MS / 1000).expiry).toBe(MAX_UCAN_EXPIRY_MS / 1000);
    expect(() => s.direct(MAX_UCAN_EXPIRY_MS / 1000 + 1)).toThrow(WASM_UCAN_RANGE);
  });

  test("a token to exactly 2255-06-05T23:47:34Z is minted from a session signed to 9999", async () => {
    const s = await signedSessionTo9999();
    const result = s.wrapper(MAX_UCAN_EXPIRY_MS / 1000);
    expect(result.expiry.getTime()).toBe(MAX_UCAN_EXPIRY_MS);
  });

  test("a token one second later is refused with the dated message before the WASM is called", async () => {
    const s = await signedSessionTo9999();
    s.createDelegation.mockClear();
    expect(() => s.wrapper(MAX_UCAN_EXPIRY_MS / 1000 + 1)).toThrow(UCAN_DATED);
    expect(() => s.wrapper(Date.UTC(9999, 11, 31) / 1000)).toThrow(UCAN_DATED);
    expect(s.createDelegation).not.toHaveBeenCalled();
  });

  test("an expiry that is not a date is refused, not passed on as NaN", async () => {
    const s = await signedSessionTo9999();
    s.createDelegation.mockClear();
    for (const expirationSecs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const refusal = (() => {
        try {
          s.wrapper(expirationSecs);
        } catch (error) {
          return error as Error;
        }
        return undefined;
      })();
      expect(refusal?.message).toBe(
        "expiry is not a valid date or is too far away to hold; choose one before 2255-06-05",
      );
    }
    expect(s.createDelegation).not.toHaveBeenCalled();
  });
});

// ---- delegateTo / planning on a session signed to 9999, with a mocked WASM so the calls are observable ----

const BOB_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000BB";
const ENTRY: PermissionEntry = {
  service: "tinycloud.kv",
  space: "default",
  path: "items/",
  actions: ["tinycloud.kv/get"],
};

function siweWithExpiry(expirationTime: string): string {
  return [
    "example.com wants you to sign in with your Ethereum account:",
    "0x0000000000000000000000000000000000000001",
    "",
    "Sign-in statement",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: abcdefghij",
    "Issued At: 2024-01-01T00:00:00.000Z",
    `Expiration Time: ${expirationTime}`,
  ].join("\n");
}

function mockedNode(sessionExpiry: string, options: { covered?: boolean; signer?: boolean } = {}) {
  const covered = options.covered ?? true;
  const parseRecap = mock(() =>
    covered ? [{ service: "kv", space: "default", path: "/", actions: ["tinycloud.kv/get"] }] : []);
  const createDelegation = mock(() => ({
    delegation: "fake-ucan",
    cid: "bafyfake",
    delegateDid: BOB_DID,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    resources: [{ service: "kv", space: "space://test", path: "items/", actions: ["tinycloud.kv/get"] }],
  }));
  const prepareSession = mock((config: { spaceId: string }) => ({ siwe: "siwe", spaceId: config.spaceId }));
  const wasm = {
    invoke: mock(() => Promise.resolve({})),
    invokeAny: mock(() => Promise.resolve({})),
    prepareSession,
    completeSessionSetup: mock((config: { spaceId: string }) => ({ spaceId: config.spaceId, delegationCid: "bafysigned", delegationHeader: { Authorization: "signed.header" } })),
    ensureEip55: (a: string) => a,
    makeSpaceId: (a: string, c: number, p: string) => `space://${a}:${c}:${p}`,
    createDelegation,
    parseRecapFromSiwe: parseRecap,
    parseVerifiedRecapFromSiwe: parseRecap,
    protocolVersion: () => 1,
    createSessionManager: () => ({
      createSessionKey: (id: string) => id,
      replaceSessionKey: (_jwk: object, id: string) => id,
      renameSessionKeyId: () => {},
      getDID: (id: string) => `did:key:z6MkTest-${id}`,
      jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
    }),
  } as unknown as IWasmBindings;
  const signMessage = mock(async () => "signature");
  const node = new TinyCloudNode({
    host: HOST,
    tinycloudRegistryUrl: registry.url.origin,
    wasmBindings: wasm,
    ...(options.signer ? { signer: { signMessage } as never } : {}),
  });
  Object.assign(node, {
    _address: "0x0000000000000000000000000000000000000001",
    _chainId: 1,
    auth: {
      resolveResourceDestinations: async () => [{ url: HOST }],
      tinyCloudSession: {
        address: "0x0000000000000000000000000000000000000001",
        chainId: 1,
        sessionKey: "default",
        spaceId: "space://test",
        delegationCid: "bafyparent",
        delegationHeader: { Authorization: "Bearer parent" },
        verificationMethod: "did:key:z6MkTestSession#z6MkTestSession",
        jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
        siwe: siweWithExpiry(sessionExpiry),
        signature: "0xfake",
      },
    },
  });
  return { node, createDelegation, prepareSession, signMessage };
}

describe("delegateTo from a session signed to 9999", () => {
  test("a hundred years is accepted (the session allows it and the token can carry it)", async () => {
    const s = mockedNode("9999-12-31T23:59:59.000Z");
    await s.node.delegateTo(BOB_DID, [ENTRY], { expiry: 100 * YEAR_MS });
    expect(s.createDelegation).toHaveBeenCalledTimes(1);
    const expirationSecs = (s.createDelegation.mock.calls[0] as unknown[])[4] as number;
    expect(expirationSecs).toBeGreaterThan(Date.now() / 1000 + 99 * (YEAR_MS / 1000));
  });

  test("an expiry past 2255-06-05 is refused with the dated message and the WASM is never called", async () => {
    const s = mockedNode("9999-12-31T23:59:59.000Z");
    await expect(s.node.delegateTo(BOB_DID, [ENTRY], { expiry: 300 * YEAR_MS })).rejects.toThrow(UCAN_DATED);
    await expect(s.node.delegateTo(BOB_DID, [ENTRY], { expiry: "250y" })).rejects.toThrow(UCAN_DATED);
    expect(s.createDelegation).not.toHaveBeenCalled();
  });

  test("a manifest-style duration of ms('99999999y') is refused cleanly, not as a RangeError", async () => {
    const s = mockedNode("9999-12-31T23:59:59.000Z");
    const refusal = await s.node.delegateTo(BOB_DID, [ENTRY], { expiry: "99999999y" }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(RangeError);
    expect((refusal as Error).message).toBe(
      "expiry is not a valid date or is too far away to hold; choose one before 2255-06-05",
    );
    expect(s.createDelegation).not.toHaveBeenCalled();
  });

  test("the same far request against a 30-day session is still clamped to the session, as before", async () => {
    const s = mockedNode(new Date(Date.now() + 30 * DAY_MS).toISOString());
    await s.node.delegateTo(BOB_DID, [ENTRY], { expiry: 300 * YEAR_MS });
    const expirationSecs = (s.createDelegation.mock.calls[0] as unknown[])[4] as number;
    expect(expirationSecs * 1000).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  });

  test("forceWalletSign allows what only a wallet-signed message can carry (300 years) and reaches the wallet", async () => {
    const s = mockedNode("9999-12-31T23:59:59.000Z", { signer: true });
    await s.node.delegateTo(BOB_DID, [ENTRY], { expiry: 300 * YEAR_MS, forceWalletSign: true }).catch(() => undefined);
    expect(s.prepareSession).toHaveBeenCalled();
    const prepared = (s.prepareSession.mock.calls[0] as unknown[])[0] as { expirationTime: string };
    expect(prepared.expirationTime.slice(0, 4)).toBe(String(new Date(Date.now() + 300 * YEAR_MS).getUTCFullYear()));
    expect(s.signMessage).toHaveBeenCalled();
  });

  test("an expiry no date can hold is refused on the wallet path before the wallet is asked", async () => {
    const s = mockedNode("9999-12-31T23:59:59.000Z", { signer: true });
    const refusal = await s.node
      .delegateTo(BOB_DID, [ENTRY], { expiry: "99999999y", forceWalletSign: true })
      .catch((error: unknown) => error);
    expect(refusal).not.toBeInstanceOf(RangeError);
    expect((refusal as Error).message).toBe(NOT_A_DATE);
    expect(s.prepareSession).not.toHaveBeenCalled();
    expect(s.signMessage).not.toHaveBeenCalled();
  });

  test("createDelegation for scope outside the session falls back to the wallet, which can carry 300 years", async () => {
    // Not covered by the signed session, so the session-key token path is not taken and its 2255 limit does not apply.
    const s = mockedNode("9999-12-31T23:59:59.000Z", { signer: true, covered: false });
    await s.node
      .createDelegation({ path: "items/", actions: ["tinycloud.kv/get"], delegateDID: BOB_DID, expiryMs: 300 * YEAR_MS })
      .catch(() => undefined);
    expect(s.prepareSession).toHaveBeenCalled();
    expect(s.createDelegation).not.toHaveBeenCalled();
  });
});

describe("the wallet-signed paths refuse before the wallet is asked", () => {
  const parentOf = (expiry: Date) => ({
    cid: "parent-cid",
    delegationHeader: { Authorization: "parent.header.signature" },
    spaceId: "space://test",
    path: "docs",
    actions: ["tinycloud.kv/get"],
    expiry,
    delegateDID: "did:key:z6MkReceiver",
    ownerAddress: "0x0000000000000000000000000000000000000001",
    chainId: 1,
  });
  const child = { path: "docs", actions: ["tinycloud.kv/get"], delegateDID: "did:key:z6MkChild" };

  test("createSubDelegation accepts a hundred years and the last second of 9999", async () => {
    const s = mockedNode("9999-12-31T23:59:59.000Z", { signer: true });
    const last = new Date(MAX_SIWE_EXPIRY_MS);
    const defaulted = await s.node.createSubDelegation(parentOf(last), child);
    expect(defaulted.expiry).toEqual(last);
    const hundred = await s.node.createSubDelegation(parentOf(last), { ...child, expiryMs: 100 * YEAR_MS });
    expect(hundred.expiry.getTime()).toBeGreaterThan(Date.now() + 99 * YEAR_MS);
    expect(s.signMessage).toHaveBeenCalledTimes(2);
  });

  test("createSubDelegation refuses a parent past 9999 or an expiry no date can hold, without a RangeError", async () => {
    for (const [parent, extra, message] of [
      [new Date(8.64e15), {}, SIWE_DATED],
      [new Date(Number.NaN), {}, NOT_A_DATE],
      [new Date(MAX_SIWE_EXPIRY_MS), { expiryMs: 3.15e18 }, NOT_A_DATE],
      [new Date(MAX_SIWE_EXPIRY_MS), { expiryMs: -1e14 }, NOT_A_DATE],
    ] as const) {
      const s = mockedNode("9999-12-31T23:59:59.000Z", { signer: true });
      const refusal = await s.node.createSubDelegation(parentOf(parent), { ...child, ...extra }).catch((error: unknown) => error);
      expect(refusal).not.toBeInstanceOf(RangeError);
      expect((refusal as Error).message).toBe(message);
      expect(s.prepareSession).not.toHaveBeenCalled();
      expect(s.signMessage).not.toHaveBeenCalled();
    }
  });

  test("useDelegation refuses a received delegation that no sign-in message can carry", async () => {
    for (const [expiry, message] of [
      [new Date(8.64e15), SIWE_DATED],
      [new Date(Number.NaN), NOT_A_DATE],
    ] as const) {
      const s = mockedNode("9999-12-31T23:59:59.000Z", { signer: true });
      const received = { ...parentOf(expiry), delegateDID: s.node.did };
      const refusal = await s.node.useDelegation(received as never).catch((error: unknown) => error);
      expect(refusal).not.toBeInstanceOf(RangeError);
      expect((refusal as Error).message).toBe(message);
      expect(s.prepareSession).not.toHaveBeenCalled();
      expect(s.signMessage).not.toHaveBeenCalled();
    }
  });

  test("grantRuntimePermissions accepts a hundred years and refuses an expiry no date can hold before the wallet is asked", async () => {
    const far = mockedNode("9999-12-31T23:59:59.000Z", { signer: true, covered: false });
    await far.node.grantRuntimePermissions([ENTRY], { expiry: 100 * YEAR_MS }).catch(() => undefined);
    expect(far.prepareSession).toHaveBeenCalledTimes(1);

    const huge = mockedNode("9999-12-31T23:59:59.000Z", { signer: true, covered: false });
    const refusal = await huge.node.grantRuntimePermissions([ENTRY], { expiry: "99999999y" }).catch((error: unknown) => error);
    expect(refusal).not.toBeInstanceOf(RangeError);
    expect((refusal as Error).message).toBe(NOT_A_DATE);
    expect(huge.prepareSession).not.toHaveBeenCalled();
    expect(huge.signMessage).not.toHaveBeenCalled();
  });
});

describe("authorizeShareDeliveryV3 (public, the expiry comes from the caller)", () => {
  const SPACE = "tinycloud:pkh:eip155:1:0xD559CCd9EB87c530A9a349262669386dE93cf412:applications";
  const SHARE_URL = `https://share.tinycloud.xyz/s/lqdw5iopqq2tkkvjj6gbbi5vbv#v=4&k=${"A".repeat(43)}&c=bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u`;

  function deliveryNode() {
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const metadata = registryMetadata(input, init);
      if (metadata) return metadata;
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const wasmBindings = {
      invoke: () => ({ Authorization: "delivery-invocation" }),
      ensureEip55: (a: string) => a,
      createSessionManager: () => ({
        createSessionKey: (id: string) => id,
        replaceSessionKey: (_jwk: object, id: string) => id,
        renameSessionKeyId: () => {},
        getDID: (id: string) => `did:key:z6MkTest-${id}`,
        jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
      }),
    } as unknown as IWasmBindings;
    const node = new TinyCloudNode({ host: HOST, tinycloudRegistryUrl: registry.url.origin, wasmBindings });
    Object.assign(node, { _restoredTcSession: { spaceId: SPACE }, _serviceContext: { session: { spaceId: SPACE } } });
    const deliver = (expiresAt: string) =>
      node.authorizeShareDeliveryV3({
        envelope: { version: 3 },
        resourcePath: "shares/test/readme.md",
        recipientEmail: "recipient@example.test",
        shareUrl: SHARE_URL,
        documentName: "readme.md",
        expiresAt,
        deliveryAudience: "https://witness.credentials.org",
        idempotencyKey: "stable-key",
      });
    return { deliver, requests };
  }

  test("a string that is not a date is refused cleanly, with no request sent and no RangeError", async () => {
    const s = deliveryNode();
    const refusal = await s.deliver("tomorrow").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(RangeError);
    expect((refusal as Error).message).toBe(NOT_A_DATE);
    expect(s.requests).toEqual([]);
  });

  test("a year past 9999 is refused with the dated message, with no request sent", async () => {
    const s = deliveryNode();
    await expect(s.deliver("+010000-01-01T00:00:00.000Z")).rejects.toThrow(SIWE_DATED);
    expect(s.requests).toEqual([]);
  });

  test("the last second of 9999 is sent, normalised to three-digit milliseconds", async () => {
    const s = deliveryNode();
    await s.deliver("9999-12-31T23:59:59Z").catch(() => undefined);
    expect(s.requests[0]?.expiresAt).toBe("9999-12-31T23:59:59.000Z");
  });
});

describe("createRootDelegationForSharing (the share link's wallet-signed root)", () => {
  const rootParams = (s: Awaited<ReturnType<typeof ownerNode>>, requestedExpiry: Date) => ({
    shareKeyDID: s.audience,
    spaceId: s.spaceId,
    path: "shares/doc.md",
    actions: ["tinycloud.kv/get"],
    requestedExpiry,
  });
  const createRoot = (s: Awaited<ReturnType<typeof ownerNode>>, requestedExpiry: Date) =>
    (s.node as unknown as { createRootDelegationForSharing(p: unknown): Promise<unknown> }).createRootDelegationForSharing(
      rootParams(s, requestedExpiry),
    );

  test("a share past 9999 or with an invalid date reports the dated refusal, not a missing authorization", async () => {
    for (const [requestedExpiry, message] of [
      [new Date(MAX_SIWE_EXPIRY_MS + 1000), SIWE_DATED],
      [new Date(Number.NaN), NOT_A_DATE],
    ] as const) {
      const s = await ownerNode();
      await expect(createRoot(s, requestedExpiry)).rejects.toThrow(message);
      expect(s.signMessage).not.toHaveBeenCalled();
    }
  });

  test("a share inside the limit gets its wallet-signed root, and any other failure still falls back to undefined", async () => {
    const ok = await ownerNode();
    expect(await createRoot(ok, new Date(Date.now() + 100 * YEAR_MS))).toBeDefined();

    const failing = await ownerNode();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      registryMetadata(input, init) ?? new Response("denied", { status: 403 })) as typeof fetch;
    expect(await createRoot(failing, new Date(Date.now() + 100 * YEAR_MS))).toBeUndefined();
  });
});
