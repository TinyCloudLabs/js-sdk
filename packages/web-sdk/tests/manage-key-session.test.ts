import { beforeEach, expect, mock, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const identity = {
  version: "v1" as const,
  keyId: "manage-key-session-test",
  address: account.address,
  chainId: 1,
  did: `did:pkh:eip155:1:${account.address}`,
  spaceId: `tinycloud:pkh:eip155:1:${account.address}:applications`,
};
const restoredSession = {
  address: account.address,
  walletAddress: account.address,
  chainId: 1,
  sessionKey: "restored-session-key",
  siwe: "restored SIWE",
  signature: "0xrestored",
};

let capturedConfig: any;
let restoreResult: any;
let restoreCalls = 0;
let signInRequests = 0;

class TinyCloudWebTestDouble {
  constructor(config: unknown) {
    capturedConfig = config;
  }

  async restoreSession() {
    restoreCalls += 1;
    return restoreResult;
  }

  async signIn() {
    signInRequests += 1;
    const response = await capturedConfig.signStrategy.handler({
      address: identity.address,
      chainId: identity.chainId,
      message: "exact session SIWE",
      type: "siwe",
      purpose: "sign-in",
    });
    if (!response.approved) throw new Error(response.reason);
    return { ...restoredSession, siwe: "new SIWE", signature: response.signature };
  }
}

mock.module("../src/modules/tcw", () => ({
  TinyCloudWeb: TinyCloudWebTestDouble,
}));

const { establishManageKeySession } = await import("../src/manage-key-session");

beforeEach(() => {
  capturedConfig = undefined;
  restoreResult = { status: "missing" };
  restoreCalls = 0;
  signInRequests = 0;
});

test("establishManageKeySession installs only the canonical OAuth signer", async () => {
  const signature = await account.signMessage({ message: "exact session SIWE" });
  const requests: RequestInit[] = [];

  const result = await establishManageKeySession({
    identity,
    signer: {
      endpoint: "http://127.0.0.1:9911/api/delegate/sign",
      token: "notes-access-token",
      scopes: "openid tinycloud:manage-key",
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        return Response.json({ approved: true, signature, canonicalIdentity: identity });
      },
    },
    tinycloud: {
      capabilityRequest: {
        resources: [{
          service: "tinycloud.kv",
          space: identity.spaceId,
          path: "notes/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        }],
      },
      // Runtime callers cannot use this to broaden the helper's authority.
      autoBootstrapAccount: true,
    } as any,
  });

  expect(result.identity).toEqual(identity);
  expect(result.session.signature).toBe(signature);
  expect(restoreCalls).toBe(1);
  expect(signInRequests).toBe(1);
  expect(capturedConfig.autoBootstrapAccount).toBe(false);
  expect(capturedConfig.capabilityRequest.resources[0].path).toBe("notes/");
  expect(requests).toHaveLength(1);
  expect(new Headers(requests[0]?.headers).get("authorization")).toBe(
    "Bearer notes-access-token",
  );
  expect(requests[0]?.credentials).toBe("omit");
});

test("establishManageKeySession preserves an authenticated restored session without signing again", async () => {
  restoreResult = { status: "restored", session: restoredSession };
  let signerCalls = 0;

  const result = await establishManageKeySession({
    identity,
    signer: {
      endpoint: "http://127.0.0.1:9912/api/delegate/sign",
      token: "tasks-access-token",
      scopes: "openid tinycloud:manage-key",
      fetch: async () => {
        signerCalls += 1;
        return new Response("must not sign a restored session", { status: 500 });
      },
    },
    tinycloud: { persistSession: true },
  });

  expect(result.session).toEqual(restoredSession);
  expect(result.session.address).toBe(identity.address);
  expect(restoreCalls).toBe(1);
  expect(signInRequests).toBe(0);
  expect(signerCalls).toBe(0);
});
