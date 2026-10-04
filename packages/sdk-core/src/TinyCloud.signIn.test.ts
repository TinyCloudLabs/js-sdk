import { expect, test } from "bun:test";
import { authorizationVerdictOf, ErrorCodes } from "@tinycloud/sdk-services";
import { TinyCloud } from "./TinyCloud";
import type { ClientSession, IUserAuthorization, SignInOptions } from "./userAuthorization";

test("TinyCloud.signIn forwards per-call nonce options to authorization", async () => {
  const calls: Array<SignInOptions | undefined> = [];
  const session: ClientSession = {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: 1,
    sessionKey: "session-1",
    siwe: "siwe",
    signature: "signature",
  };

  const auth: IUserAuthorization = {
    session: undefined,
    extend() {},
    signIn: async (options?: SignInOptions) => {
      calls.push(options);
      return session;
    },
    signOut: async () => {},
    address: () => undefined,
    chainId: () => undefined,
    signMessage: async () => "0xsignature",
  };

  const tc = new TinyCloud(auth);

  await expect(tc.signIn({ nonce: "call-nonce" })).resolves.toEqual(session);
  expect(calls).toEqual([{ nonce: "call-nonce" }]);
});

test("TinyCloud public-space operations retain typed HTTP refusal and server text", async () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const signedInSession: ClientSession = {
    address, walletAddress: address, chainId: 1, sessionKey: "session",
    siwe: "siwe", signature: "signature",
  };
  const auth: IUserAuthorization = {
    session: undefined,
    extend() {},
    signIn: async () => Object.assign(signedInSession, {
      tinycloudSession: {
        delegationHeader: { Authorization: "Bearer test" },
        delegationCid: "bafy-delegation",
        spaceId: TinyCloud.makePublicSpaceId(address, 1),
        verificationMethod: "did:key:z6MkTest",
        jwk: {},
      },
    }),
    signOut: async () => {},
    address: () => address,
    chainId: () => 1,
    signMessage: async () => "0xsignature",
  };
  for (const [status, body, verdict] of [
    [401, "Forbidden", "unauthenticated"],
    [403, "session expired", "forbidden"],
  ] as const) {
    const publicRead = await TinyCloud.readPublicSpace(
      "https://node.example", TinyCloud.makePublicSpaceId(address, 1), "key",
      async () => new Response(body, { status }),
    );
    expect(publicRead.ok).toBe(false);
    if (!publicRead.ok) {
      expect(publicRead.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
      expect(publicRead.error.meta?.status).toBe(status);
      expect(publicRead.error.message).toContain(String(status));
      expect(publicRead.error.message).toContain(body);
      expect(authorizationVerdictOf(publicRead.error)).toBe(verdict);
    }

    for (const failingRequest of [1, 2]) {
      let requests = 0;
      const tc = new TinyCloud(auth);
      tc.initializeServices(
        () => ({}), ["https://node.example"],
        async () => {
          requests++;
          if (failingRequest === 2 && requests === 1)
            return new Response("", { status: 404 });
          return new Response(body, { status });
        },
      );
      await tc.signIn();
      const result = await tc.ensurePublicSpace();
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
      expect(result.error.meta?.status).toBe(status);
      expect(result.error.message).toContain(String(status));
      expect(result.error.message).toContain(body);
      expect(authorizationVerdictOf(result.error)).toBe(verdict);
    }
  }
});
