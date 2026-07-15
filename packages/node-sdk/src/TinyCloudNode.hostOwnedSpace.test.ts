import { expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

function makeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
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

function makeNode(
  hostOwnedSpace: ReturnType<typeof mock>,
): { node: TinyCloudNode } {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as any,
    wasmBindings: makeWasmBindings(),
  });
  // Simulate post-signIn state.
  (node as any)._address = ADDRESS;
  (node as any)._chainId = 1;
  (node as any).auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    },
    hostOwnedSpace,
  };
  return { node };
}

function withFetch<T>(
  impl: (input: RequestInfo | URL) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("hostOwnedSpace resolves the owned space URI and always submits the host delegation", async () => {
  const APPS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
  const hostOwnedSpace = mock(async () => true);
  const { node } = makeNode(hostOwnedSpace);

  // /delegate re-activation after hosting.
  const spaceId = await withFetch(
    async () =>
      new Response(JSON.stringify({ activated: [APPS], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () => node.hostOwnedSpace("applications"),
  );

  expect(spaceId).toBe(APPS);
  // Always hosts (does not infer "already hosted" from session activation),
  // and passes the resolved owned-space URI to the auth layer.
  expect(hostOwnedSpace).toHaveBeenCalledTimes(1);
  expect(hostOwnedSpace).toHaveBeenCalledWith(APPS);
});

test("hostOwnedSpace succeeds when re-activation omits the space from skipped", async () => {
  // A genuinely-hosted owned space the session has not referenced is reported
  // under neither `activated` nor `skipped`; that must still count as success.
  const APPS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
  const hostOwnedSpace = mock(async () => true);
  const { node } = makeNode(hostOwnedSpace);

  const spaceId = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          activated: [`tinycloud:pkh:eip155:1:${ADDRESS}:default`],
          skipped: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => node.hostOwnedSpace("applications"),
  );

  expect(spaceId).toBe(APPS);
});

test("hostOwnedSpace throws when the host delegation is rejected", async () => {
  const hostOwnedSpace = mock(async () => false);
  const { node } = makeNode(hostOwnedSpace);

  await expect(
    withFetch(
      async () =>
        new Response(JSON.stringify({ activated: [], skipped: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => node.hostOwnedSpace("applications"),
    ),
  ).rejects.toThrow("Failed to host owned space");
});

test("hostOwnedSpace throws when re-activation reports the space skipped", async () => {
  const APPS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
  const hostOwnedSpace = mock(async () => true);
  const { node } = makeNode(hostOwnedSpace);

  await expect(
    withFetch(
      async () =>
        new Response(JSON.stringify({ activated: [], skipped: [APPS] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => node.hostOwnedSpace("applications"),
    ),
  ).rejects.toThrow("Failed to activate session for owned space");
  // The host was still attempted (idempotent), it is only the post-host
  // usability assertion that failed.
  expect(hostOwnedSpace).toHaveBeenCalledWith(APPS);
});

test("hostOwnedSpace throws when re-activation fails", async () => {
  const hostOwnedSpace = mock(async () => true);
  const { node } = makeNode(hostOwnedSpace);

  await expect(
    withFetch(
      async () =>
        new Response("nope", {
          status: 500,
        }),
      () => node.hostOwnedSpace("applications"),
    ),
  ).rejects.toThrow("Failed to activate session for owned space");
});

test("hostOwnedSpace throws when no TinyCloud host is configured", async () => {
  const hostOwnedSpace = mock(async () => true);
  const { node } = makeNode(hostOwnedSpace);
  // Remove every host source so resolution yields none.
  (node as any).config.host = undefined;
  (node as any).auth.hosts = [];

  await expect(node.hostOwnedSpace("applications")).rejects.toThrow(
    "requires a TinyCloud host",
  );
  // Must fail before submitting the host delegation.
  expect(hostOwnedSpace).not.toHaveBeenCalled();
});

test("hostOwnedSpace throws when not signed in", async () => {
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: async () => "0xsig",
    } as any,
    wasmBindings: makeWasmBindings(),
  });
  // No auth session set.
  await expect(node.hostOwnedSpace("applications")).rejects.toThrow(
    "Not signed in",
  );
});
