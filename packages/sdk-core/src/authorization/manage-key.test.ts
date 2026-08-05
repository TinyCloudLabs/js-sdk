import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  OpenKeyManageKeyError,
  TINYCLOUD_CANONICAL_IDENTITY_CLAIM,
  createOpenKeyManageKeySigningStrategy,
  hasTinyCloudManageKeyScope,
  parseCanonicalTinyCloudIdentity,
  parseCanonicalTinyCloudIdentityClaims,
  requestTinyCloudManageKeyScope,
} from "./manage-key";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const identity = {
  version: "v1" as const,
  keyId: "canonical-key-1",
  address: account.address,
  chainId: 1 as const,
  did: `did:pkh:eip155:1:${account.address}`,
  spaceId: `tinycloud:pkh:eip155:1:${account.address}:applications`,
};
const request = {
  address: account.address,
  chainId: 1,
  message: "example.test wants you to sign in:\n\nLine one\n�� unicode\n",
  type: "siwe" as const,
  purpose: "sign-in" as const,
};

describe("tinycloud:manage-key OAuth signer", () => {
  test("adds the explicit consent scope without granting unrelated clients", () => {
    expect(requestTinyCloudManageKeyScope("openid profile")).toBe(
      "openid profile tinycloud:manage-key",
    );
    expect(
      requestTinyCloudManageKeyScope([
        "openid",
        "tinycloud:manage-key",
        "openid",
      ]),
    ).toBe("openid tinycloud:manage-key");
    expect(hasTinyCloudManageKeyScope("openid profile")).toBe(false);
    expect(hasTinyCloudManageKeyScope("openid tinycloud:manage-key")).toBe(
      true,
    );
  });

  test("parses only a canonical EIP-55 identity claim", () => {
    expect(parseCanonicalTinyCloudIdentity(identity)).toEqual(identity);
    expect(
      parseCanonicalTinyCloudIdentityClaims({
        [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: identity,
      }),
    ).toEqual(identity);

    expect(() =>
      parseCanonicalTinyCloudIdentity({
        ...identity,
        address: identity.address.toLowerCase(),
      }),
    ).toThrow(OpenKeyManageKeyError);
    expect(() =>
      parseCanonicalTinyCloudIdentity({
        ...identity,
        did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000000",
      }),
    ).toThrow(OpenKeyManageKeyError);

    const nonApplicationIdentity = {
      ...identity,
      chainId: 137,
      did: `did:pkh:eip155:137:${account.address}`,
      spaceId: `tinycloud:pkh:eip155:137:${account.address}:reference-app`,
    };
    expect(parseCanonicalTinyCloudIdentity(nonApplicationIdentity)).toEqual(
      nonApplicationIdentity,
    );
  });

  test("signs the exact sign-in SIWE through one bearer-only cookie-free request", async () => {
    const requests: Array<{ body: string; init: RequestInit | undefined }> = [];
    const signature = await account.signMessage({ message: request.message });
    const strategy = createOpenKeyManageKeySigningStrategy({
      endpoint: "http://127.0.0.1:9999/api/delegate/sign",
      token: "consented-oauth-token",
      scopes: "openid tinycloud:manage-key",
      identity,
      fetch: async (_input, init) => {
        requests.push({ body: String(init?.body), init });
        return new Response(
          JSON.stringify({
            approved: true,
            signature,
            canonicalIdentity: identity,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(strategy.handler(request)).resolves.toEqual({
      approved: true,
      signature,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer consented-oauth-token",
    );
    expect(new Headers(requests[0]?.init?.headers).get("cookie")).toBeNull();
    expect(JSON.parse(requests[0]!.body)).toEqual({
      address: identity.address,
      chainId: 1,
      message: request.message,
      type: "siwe",
    });
  });

  test("round-trips the exact SIWE through a real local signer boundary", async () => {
    const signature = await account.signMessage({ message: request.message });
    const received: Array<{
      rawBody: string;
      authorization: string | null;
      cookie: string | null;
    }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (incoming) => {
        const rawBody = await incoming.text();
        received.push({
          rawBody,
          authorization: incoming.headers.get("authorization"),
          cookie: incoming.headers.get("cookie"),
        });
        return Response.json({
          approved: true,
          signature,
          canonicalIdentity: identity,
        });
      },
    });
    try {
      const strategy = createOpenKeyManageKeySigningStrategy({
        endpoint: `http://127.0.0.1:${server.port}/api/delegate/sign`,
        token: "consented-oauth-token",
        scopes: "openid tinycloud:manage-key",
        identity,
      });
      await expect(strategy.handler(request)).resolves.toEqual({
        approved: true,
        signature,
      });
      expect(received).toEqual([
        {
          rawBody: JSON.stringify({
            address: identity.address,
            chainId: 1,
            message: request.message,
            type: "siwe",
          }),
          authorization: "Bearer consented-oauth-token",
          cookie: null,
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("requires consent before it can call the signer", async () => {
    let calls = 0;
    const strategy = createOpenKeyManageKeySigningStrategy({
      endpoint: "https://openkey.example.test/api/delegate/sign",
      token: "",
      scopes: "openid tinycloud:manage-key",
      identity,
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });

    await expect(strategy.handler(request)).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  test("does not grant signing authority to a bearer without the scope", async () => {
    let calls = 0;
    const strategy = createOpenKeyManageKeySigningStrategy({
      endpoint: "https://openkey.example.test/api/delegate/sign",
      token: "unscoped-oauth-token",
      scopes: "openid profile",
      identity,
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });

    await expect(strategy.handler(request)).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  test.each([
    ["missing_scope", "CONSENT_REQUIRED"],
    ["client_disabled", "GRANT_DISABLED"],
    ["signing_disabled", "GRANT_DISABLED"],
    ["user_exclusive", "USER_EXCLUSIVE"],
    ["token_expired", "TOKEN_EXPIRED"],
    ["expired_token", "TOKEN_EXPIRED"],
    ["grant_disabled", "GRANT_DISABLED"],
    ["message_rejected", "MESSAGE_REJECTED"],
  ] as const)(
    "maps %s to the stable terminal %s error",
    async (upstreamCode, code) => {
      const strategy = createOpenKeyManageKeySigningStrategy({
        endpoint: "https://openkey.example.test/api/delegate/sign",
        token: "consented-oauth-token",
        scopes: "openid tinycloud:manage-key",
        identity,
        fetch: async () =>
          new Response(
            JSON.stringify({
              approved: false,
              code: upstreamCode,
              reason: "denied by policy",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      });

      await expect(strategy.handler(request)).rejects.toMatchObject({
        name: "OpenKeyManageKeyError",
        code,
        retryable: false,
      });
    },
  );

  test("treats an unauthenticated signer response as an expired token", async () => {
    const strategy = createOpenKeyManageKeySigningStrategy({
      endpoint: "https://openkey.example.test/api/delegate/sign",
      token: "expired-oauth-token",
      scopes: "openid tinycloud:manage-key",
      identity,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });

    await expect(strategy.handler(request)).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
      retryable: false,
    });
  });

  test("reports a signer identity mismatch distinctly from a rejected message", async () => {
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const otherIdentity = {
      ...identity,
      keyId: "canonical-key-2",
      address: other.address,
      did: `did:pkh:eip155:1:${other.address}`,
      spaceId: `tinycloud:pkh:eip155:1:${other.address}:applications`,
    };
    const strategy = createOpenKeyManageKeySigningStrategy({
      endpoint: "https://openkey.example.test/api/delegate/sign",
      token: "consented-oauth-token",
      scopes: "openid tinycloud:manage-key",
      identity,
      fetch: async () =>
        Response.json({
          approved: true,
          signature: await other.signMessage({ message: request.message }),
          canonicalIdentity: otherIdentity,
        }),
    });

    await expect(strategy.handler(request)).rejects.toMatchObject({
      code: "IDENTITY_MISMATCH",
      retryable: false,
    });
  });

  test("does not broaden authority to message or bootstrap requests", async () => {
    let calls = 0;
    const strategy = createOpenKeyManageKeySigningStrategy({
      endpoint: "https://openkey.example.test/api/delegate/sign",
      token: "consented-oauth-token",
      scopes: "openid tinycloud:manage-key",
      identity,
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    });

    await expect(
      strategy.handler({ ...request, purpose: "bootstrap-session" }),
    ).rejects.toMatchObject({
      code: "MESSAGE_REJECTED",
    });
    expect(calls).toBe(0);
  });
});
