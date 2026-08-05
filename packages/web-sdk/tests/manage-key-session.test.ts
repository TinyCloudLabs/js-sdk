import { expect, mock, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  createOpenKeyManageKeySigningStrategy,
  OpenKeyManageKeyError,
  parseCanonicalTinyCloudIdentity,
} from "../../sdk-core/src/authorization/manage-key";
import type { EstablishManageKeySessionOptions } from "../src/manage-key-session";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const identity = {
  version: "v1" as const,
  keyId: "canonical-key-1",
  address: account.address,
  chainId: 1,
  did: `did:pkh:eip155:1:${account.address}`,
  spaceId: `tinycloud:pkh:eip155:1:${account.address}:reference-app`,
};

const localNodeData = new Map<string, unknown>();
const constructedConfigs: any[] = [];

class ControlledLocalTinyCloudWeb {
  readonly kv = {
    put: async (key: string, value: unknown) => {
      localNodeData.set(key, value);
      return { ok: true };
    },
    get: async (key: string) => ({ ok: true, value: localNodeData.get(key) }),
  };

  constructor(readonly config: any) {
    constructedConfigs.push(config);
  }

  async signIn() {
    const [address] = await this.config.provider.request({ method: "eth_accounts" });
    const chain = await this.config.provider.request({ method: "eth_chainId" });
    const response = await this.config.signStrategy.handler({
      address,
      chainId: Number.parseInt(chain, 16),
      message: "reference-app.local wants you to sign in:\n\nexact SIWE bytes \u{1f512}",
      type: "siwe",
      purpose: "sign-in",
    });
    if (!response.approved || !response.signature) throw new Error("sign-in rejected");
    return {
      address,
      walletAddress: address,
      chainId: Number.parseInt(chain, 16),
      sessionKey: "controlled-local-node-session",
      siwe: "reference-app.local wants you to sign in:\n\nexact SIWE bytes \u{1f512}",
      signature: response.signature,
    };
  }
}

mock.module("../src/modules/tcw", () => ({
  TinyCloudWeb: ControlledLocalTinyCloudWeb,
}));
mock.module("@tinycloud/sdk-core", () => ({
  createOpenKeyManageKeySigningStrategy,
  OpenKeyManageKeyError,
  parseCanonicalTinyCloudIdentity,
}));

const { establishManageKeySession } = await import("../src/manage-key-session");

function options(endpoint: string, token = "consented-oauth-token"): EstablishManageKeySessionOptions {
  return {
    identity: { ...identity },
    signer: {
      endpoint,
      token,
      scopes: "openid tinycloud:manage-key",
    },
    tinycloud: {
      capabilityRequest: {
        resources: [
          {
            service: "tinycloud.kv",
            space: identity.spaceId,
            path: "reference/write-read",
            actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
          },
        ],
      },
    } as any,
  };
}

test("public manage-key SDK flow signs a session then writes and reads via a controlled local node", async () => {
  constructedConfigs.length = 0;
  localNodeData.clear();
  const signature = await account.signMessage({
    message: "reference-app.local wants you to sign in:\n\nexact SIWE bytes \u{1f512}",
  });
  const signer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer consented-oauth-token");
      expect(request.headers.get("cookie")).toBeNull();
      return Response.json({ approved: true, signature, canonicalIdentity: identity });
    },
  });
  try {
    const result = await establishManageKeySession(
      options(`http://127.0.0.1:${signer.port}/tinycloud/manage-key`),
    );
    await (result.client as any).kv.put("reference/write-read", { value: "ok" });
    await expect((result.client as any).kv.get("reference/write-read")).resolves.toEqual({
      ok: true,
      value: { value: "ok" },
    });
    expect(result.session.address).toBe(identity.address);
    expect(result.identity.spaceId).toBe(identity.spaceId);
    expect(constructedConfigs[0].autoBootstrapAccount).toBe(false);
    expect(constructedConfigs[0].capabilityRequest.resources).toHaveLength(1);
  } finally {
    signer.stop(true);
  }
});

test("two independent reference clients for one user resolve the same identity and space", async () => {
  const signature = await account.signMessage({
    message: "reference-app.local wants you to sign in:\n\nexact SIWE bytes \u{1f512}",
  });
  const signer = Bun.serve({
    port: 0,
    fetch: async () =>
      Response.json({ approved: true, signature, canonicalIdentity: identity }),
  });
  try {
    const endpoint = `http://127.0.0.1:${signer.port}/tinycloud/manage-key`;
    const [first, second] = await Promise.all([
      establishManageKeySession(options(endpoint, "reference-client-one")),
      establishManageKeySession(options(endpoint, "reference-client-two")),
    ]);
    expect(first.identity.address).toBe(second.identity.address);
    expect(first.identity.did).toBe(second.identity.did);
    expect(first.identity.spaceId).toBe(second.identity.spaceId);
  } finally {
    signer.stop(true);
  }
});
