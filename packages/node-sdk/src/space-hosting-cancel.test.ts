import { expect, test } from "bun:test";
import { createPrimarySpace } from "./space-hosting";
import type { SpaceCreationContext, SpaceHostResult } from "@tinycloud/sdk-core";
import type { IWasmBindings, ISigner, TinyCloudSession } from "@tinycloud/sdk-core";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";

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
  let answer!: (approved: boolean) => void;
  let markConfirmationStarted!: () => void;
  const confirmationStarted = new Promise<void>((resolve) => { markConfirmationStarted = resolve; });
  let hostCalls = 0;
  let recorded = false;
  const pending = createPrimarySpace({
    handler: { confirmSpaceCreation: () => new Promise<boolean>((resolve) => { answer = resolve; markConfirmationStarted(); }) },
    context,
    guard: async () => {},
    host: async () => { hostCalls++; return hosted; },
    onHosted: () => { recorded = true; },
    activate: async () => hosted,
    signal: controller.signal,
  });
  await confirmationStarted;
  controller.abort(new Error("signed out"));
  answer(true);
  await expect(pending).rejects.toThrow("signed out");
  expect(hostCalls).toBe(0);
  expect(recorded).toBe(false);
});

test("sign-out after host signing but before its response prevents local hosting state", async () => {
  const controller = new AbortController();
  let resolveHost!: (result: SpaceHostResult) => void;
  let markHostStarted!: () => void;
  const hostStarted = new Promise<void>((resolve) => { markHostStarted = resolve; });
  let recorded = false;
  const pending = createPrimarySpace({
    handler,
    context,
    guard: async () => {},
    host: () => new Promise<SpaceHostResult>((resolve) => { resolveHost = resolve; markHostStarted(); }),
    onHosted: () => { recorded = true; },
    activate: async () => hosted,
    signal: controller.signal,
  });
  await hostStarted;
  controller.abort(new Error("signed out"));
  resolveHost(hosted);
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
  let markSigningStarted!: () => void;
  const signingStarted = new Promise<void>((resolve) => { markSigningStarted = resolve; });
  let resolveSignature!: (signature: string) => void;
  let confirmationCalls = 0;
  let delegationPosts = 0;
  let sessionSiweCalls = 0;

  const signer: ISigner = {
    getAddress: async () => restoredSession.address,
    getChainId: async () => restoredSession.chainId,
    signMessage: async () => {
      markSigningStarted();
      return new Promise<string>((resolve) => { resolveSignature = resolve; });
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
  globalThis.fetch = async (input) => {
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
    await signingStarted;
    controller.abort(new Error("signed out"));
    resolveSignature("0xhost-signature");
    await expect(pending).rejects.toThrow("signed out");
    expect(confirmationCalls).toBe(1);
    expect(sessionSiweCalls).toBe(0);
    expect(delegationPosts).toBe(0);
    expect(auth.spaceHosting).not.toBe("hosted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

