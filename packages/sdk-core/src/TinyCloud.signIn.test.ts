import { expect, test } from "bun:test";
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
