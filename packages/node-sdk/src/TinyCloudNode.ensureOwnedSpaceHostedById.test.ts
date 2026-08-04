/**
 * Per-sign-in hosting memo for the private `ensureOwnedSpaceHostedById`
 * (TC-293 P3).
 *
 * `AccountService.ensureAccountSpaceHosted` funnels six calls through this
 * method during account bootstrap. Each one POSTs `/delegate` with the primary
 * session, whose recap covers only `default` + `secrets` — so the account space
 * appears in neither `activated` nor `skipped`, the guard returns immediately,
 * and the repeat calls cannot change the outcome. These tests pin that the
 * delegate submission happens once per space per sign-in, and that `signIn`
 * resets the memo.
 */
import { expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const HOST = "https://tinycloud.test";
const ACCOUNT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;
const SECRETS_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;

function makeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  } as unknown as ISessionManager;
}

function makeWasmBindings(): IWasmBindings {
  return {
    invoke: async () => undefined,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    createSessionManager: makeSessionManager,
  } as unknown as IWasmBindings;
}

function makeNode(): TinyCloudNode {
  const node = new TinyCloudNode({
    host: HOST,
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: mock(async () => "0xsig"),
    } as any,
    wasmBindings: makeWasmBindings(),
  });
  // Simulate post-signIn state.
  (node as any)._address = ADDRESS;
  (node as any)._chainId = 1;
  (node as any).auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      // Unique per node so sdk-core's in-flight activation dedupe (keyed on
      // host + header) can never mask a repeated submission across tests.
      delegationHeader: { Authorization: `token-${Math.random()}` },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    },
    hostOwnedSpace: mock(async (spaceId: string) => spaceId),
  };
  return node;
}

/**
 * Stub `fetch` and count POSTs to `/delegate`. `activated`/`skipped` default to
 * empty, which is the real production shape for a space the primary session's
 * recap never mentions.
 */
function withDelegateFetch<T>(
  body: { activated?: string[]; skipped?: string[] },
  fn: (calls: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/delegate") && init?.method === "POST") {
      calls += 1;
      return new Response(
        JSON.stringify({
          cid: "bafy-activation",
          activated: body.activated ?? [],
          skipped: body.skipped ?? [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  }) as unknown as typeof fetch;
  return fn(() => calls).finally(() => {
    globalThis.fetch = original;
  });
}

test("ensureOwnedSpaceHostedById submits /delegate ONCE across the six bootstrap calls", async () => {
  const node = makeNode();

  await withDelegateFetch({}, async (calls) => {
    for (let i = 0; i < 6; i += 1) {
      await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    }
    expect(calls()).toBe(1);
  });
});

test("the memo is per space, not global", async () => {
  const node = makeNode();

  await withDelegateFetch({}, async (calls) => {
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    await (node as any).ensureOwnedSpaceHostedById(SECRETS_SPACE);
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    await (node as any).ensureOwnedSpaceHostedById(SECRETS_SPACE);

    expect(calls()).toBe(2);
  });
});

test("a skipped space is NOT memoized as hosted", async () => {
  const node = makeNode();

  // `skipped` includes the space => the guard does not return early, so the
  // create path runs and only the post-create activation may confirm hosting.
  await withDelegateFetch({ skipped: [ACCOUNT_SPACE] }, async (calls) => {
    await expect(
      (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE),
    ).rejects.toThrow(/Failed to activate session after creating owned space/);
    // Initial probe + post-create retry.
    expect(calls()).toBe(2);
  });

  // The failure must not have poisoned the memo into "hosted".
  await withDelegateFetch({}, async (calls) => {
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    expect(calls()).toBe(1);
  });
});

test("hosting confirmed after a create is memoized too", async () => {
  const node = makeNode();

  // First activation reports the space as skipped, so the space is created and
  // the retry activation (empty skipped) confirms it.
  let firstCall = true;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/delegate") && init?.method === "POST") {
      calls += 1;
      const skipped = firstCall ? [ACCOUNT_SPACE] : [];
      firstCall = false;
      return new Response(JSON.stringify({ cid: "bafy", activated: [], skipped }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  try {
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    expect(calls).toBe(2);

    // Already confirmed: no further /delegate submissions.
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("signIn clears the memo so the next session re-confirms hosting", async () => {
  const node = makeNode();

  // Confirm hosting under the current session.
  await withDelegateFetch({}, async (calls) => {
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    expect(calls()).toBe(1);
  });
  expect((node as any).confirmedHostedSpaceIds.has(ACCOUNT_SPACE)).toBe(true);

  // Drive the real signIn() with its network layers stubbed out.
  const tc = (node as any).tc;
  tc.signIn = mock(async () => ({
    address: ADDRESS,
    walletAddress: ADDRESS,
    chainId: 1,
    sessionKey: "session-test",
    siwe: "fake-siwe",
    signature: `0x${"ff".repeat(65)}`,
  }));
  (node as any).syncResolvedHostFromAuth = () => {};
  (node as any).initializeServices = () => {};
  (node as any).resolveBootstrapDecision = async () => ({ action: "skip" });
  (node as any).ensureRequestedEncryptionNetworks = async () => {};
  (node as any).scheduleAccountRegistrySync = () => {};

  // signIn itself ensures the `secrets` space is hosted, so keep the delegate
  // stub in place and let that real call run.
  await withDelegateFetch({}, async () => {
    await node.signIn();
  });

  // The pre-signIn confirmation is gone; only what THIS session confirmed
  // remains.
  expect((node as any).confirmedHostedSpaceIds.has(ACCOUNT_SPACE)).toBe(false);
  expect((node as any).confirmedHostedSpaceIds.has(SECRETS_SPACE)).toBe(true);

  // The new session therefore re-submits /delegate for the account space.
  await withDelegateFetch({}, async (calls) => {
    await (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE);
    expect(calls()).toBe(1);
  });
});

test("ensureOwnedSpaceHostedById still requires an active session", async () => {
  const node = makeNode();
  (node as any).auth = { tinyCloudSession: undefined };

  await expect(
    (node as any).ensureOwnedSpaceHostedById(ACCOUNT_SPACE),
  ).rejects.toThrow("Owned space hosting requires an active session");
});
