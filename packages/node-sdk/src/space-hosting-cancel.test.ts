import { afterEach, expect, jest, test } from "bun:test";
import { createPrimarySpace } from "./space-hosting";
import type { SpaceCreationContext, SpaceHostResult } from "@tinycloud/sdk-core";
import type { IWasmBindings, ISigner, TinyCloudSession } from "@tinycloud/sdk-core";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { unregisteredLocationRegistryResponse } from "./test-support/unregistered-location-registry";

const REGISTRY_ORIGIN = "https://registry.hosting-cancel.test";
afterEach(() => jest.useRealTimers());

const context: SpaceCreationContext = {
  spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
  address: "0x0000000000000000000000000000000000000001",
  chainId: 1,
  host: "https://node.example",
};
const hosted: SpaceHostResult = { success: true, status: 200 };
const handler = { confirmSpaceCreation: async () => true };

test("sign-out during confirmation aborts before host delegation and recording", async () => {
  const controller = new AbortController();
  const answer = Promise.withResolvers<boolean>();
  const confirmationStarted = Promise.withResolvers<void>();
  const markConfirmationStarted = () => confirmationStarted.resolve();
  let hostCalls = 0;
  let recorded = false;
  const pending = createPrimarySpace({
    handler: { confirmSpaceCreation: () => { markConfirmationStarted(); return answer.promise; } },
    context,
    guard: async () => {},
    host: async () => { hostCalls++; return hosted; },
    onHosted: () => { recorded = true; },
    activate: async () => hosted,
    signal: controller.signal,
  });
  await confirmationStarted.promise;
  controller.abort(new Error("signed out"));
  answer.resolve(true);
  await expect(pending).rejects.toThrow("signed out");
  expect(hostCalls).toBe(0);
  expect(recorded).toBe(false);
});

test("sign-out after host signing but before its response prevents local hosting state", async () => {
  const controller = new AbortController();
  const hostResult = Promise.withResolvers<SpaceHostResult>();
  const hostStarted = Promise.withResolvers<void>();
  const markHostStarted = () => hostStarted.resolve();
  let recorded = false;
  const pending = createPrimarySpace({
    handler,
    context,
    guard: async () => {},
    host: () => { markHostStarted(); return hostResult.promise; },
    onHosted: () => { recorded = true; },
    activate: async () => hosted,
    signal: controller.signal,
  });
  await hostStarted.promise;
  controller.abort(new Error("signed out"));
  hostResult.resolve(hosted);
  await expect(pending).rejects.toThrow("signed out");
  expect(recorded).toBe(false);
});
const restoredSession: TinyCloudSession = {
  address: "0x0000000000000000000000000000000000000001",
  chainId: 1,
  sessionKey: "restored-session-key",
  spaceId: context.spaceId,
  delegationCid: "bafy-restored",
  delegationHeader: { Authorization: "Bearer restored" },
  verificationMethod: "did:key:restored#restored",
  jwk: { kty: "OKP", kid: "restored-session-key" },
  siwe: "restored session SIWE",
  signature: "0xrestored",
};

test("sign-out during host signing prevents the delegation POST and hosting record", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const signingStarted = Promise.withResolvers<void>();
  const markSigningStarted = () => signingStarted.resolve();
  const signature = Promise.withResolvers<string>();
  let confirmationCalls = 0;
  let delegationPosts = 0;
  let sessionSiweCalls = 0;

  const signer: ISigner = {
    getAddress: async () => restoredSession.address,
    getChainId: async () => restoredSession.chainId,
    signMessage: async () => {
      markSigningStarted();
      return signature.promise;
    },
  };
  const wasmBindings = {
    generateHostSIWEMessage: () => "host SIWE",
    siweToDelegationHeaders: () => ({ Authorization: "Bearer host" }),
    prepareSession: () => { sessionSiweCalls++; throw new Error("unexpected session SIWE"); },
    createSessionManager: () => ({
      createSessionKey: () => "session-key",
      replaceSessionKey: () => "session-key",
      renameSessionKeyId: () => {},
      getDID: () => "did:key:test",
      jwk: () => undefined,
    }),
  } as unknown as IWasmBindings;
  const auth = new NodeUserAuthorization({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    signer,
    wasmBindings,
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spaceCreationHandler: {
      confirmSpaceCreation: async () => { confirmationCalls++; return true; },
    },
  });
  auth.setRestoredTinyCloudSession(restoredSession);
  globalThis.fetch = async (input, init) => {
    const metadata = unregisteredLocationRegistryResponse(input, REGISTRY_ORIGIN, init);
    if (metadata) return metadata;
    const url = String(input);
    if (url.includes("/peer/generate/")) return new Response("peer-id");
    if (url.endsWith("/delegate")) {
      delegationPosts++;
      return new Response(JSON.stringify({ activated: [restoredSession.spaceId], skipped: [] }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const pending = auth.ensurePrimarySpaceHosted("not-hosted", controller.signal);
    await Promise.race([signingStarted.promise, pending]);
    controller.abort(new Error("signed out"));
    signature.resolve("0xhost-signature");
    await expect(pending).rejects.toThrow("signed out");
    expect(confirmationCalls).toBe(1);
    expect(sessionSiweCalls).toBe(0);
    expect(delegationPosts).toBe(0);
    expect(auth.spaceHosting).not.toBe("hosted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("replacing the restored session during confirmation rejects without signing or posting for the new session", async () => {
  const originalFetch = globalThis.fetch;
  const approval = Promise.withResolvers<boolean>();
  const confirmationStarted = Promise.withResolvers<void>();
  const markConfirmationStarted = () => confirmationStarted.resolve();
  const hostAddresses: string[] = [];
  let signatureCalls = 0;
  let delegationPosts = 0;
  let sessionSiweCalls = 0;
  const nextSession: TinyCloudSession = {
    ...restoredSession,
    address: "0x0000000000000000000000000000000000000002",
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:default",
  };
  const auth = new NodeUserAuthorization({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    signer: {
      getAddress: async () => restoredSession.address,
      getChainId: async () => restoredSession.chainId,
      signMessage: async () => { signatureCalls++; return "0xsignature"; },
    },
    wasmBindings: {
      generateHostSIWEMessage: (fields: Record<string, unknown>) => {
        hostAddresses.push(String(fields.address));
        return "host SIWE";
      },
      siweToDelegationHeaders: () => ({ Authorization: "Bearer host" }),
      prepareSession: () => { sessionSiweCalls++; throw new Error("unexpected session SIWE"); },
      createSessionManager: () => ({
        createSessionKey: () => "session-key",
        replaceSessionKey: () => "session-key",
        renameSessionKeyId: () => {},
        getDID: () => "did:key:test",
        jwk: () => undefined,
      }),
    } as unknown as IWasmBindings,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    spaceCreationHandler: {
      confirmSpaceCreation: () => {
        markConfirmationStarted();
        return approval.promise;
      },
    },
  });
  auth.setRestoredTinyCloudSession(restoredSession);
  globalThis.fetch = async (input, init) => {
    const metadata = unregisteredLocationRegistryResponse(input, REGISTRY_ORIGIN, init);
    if (metadata) return metadata;
    const url = String(input);
    if (url.includes("/peer/generate/")) return new Response("peer-id");
    if (url.endsWith("/delegate") && init?.method === "POST") {
      delegationPosts++;
      return new Response(JSON.stringify({ activated: [restoredSession.spaceId], skipped: [] }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const pending = auth.ensurePrimarySpaceHosted("not-hosted");
    await Promise.race([confirmationStarted.promise, pending]);
    auth.setRestoredTinyCloudSession(nextSession);
    approval.resolve(true);

    await expect(pending).rejects.toThrow();

    expect(hostAddresses).toEqual([]);
    expect(signatureCalls).toBe(0);
    expect(sessionSiweCalls).toBe(0);
    expect(delegationPosts).toBe(0);
    expect(auth.spaceHosting).toBe("unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("sign-out during the propagation delay prevents activation and onSpaceCreated", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  let activateCalls = 0;
  let createdCalls = 0;
  const pending = createPrimarySpace({
    handler: {
      confirmSpaceCreation: async () => true,
      onSpaceCreated: () => { createdCalls++; },
    },
    context,
    guard: async () => {},
    host: async () => hosted,
    onHosted: () => {},
    activate: async () => { activateCalls++; return hosted; },
    signal: controller.signal,
  });
  try {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    controller.abort(new Error("signed out"));
    jest.advanceTimersByTime(100);
    await expect(pending).rejects.toThrow("signed out");
    expect(activateCalls).toBe(0);
    expect(createdCalls).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

