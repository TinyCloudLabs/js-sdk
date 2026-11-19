import { expect, test } from "bun:test";
import { stringToHex } from "viem";
import { BrowserWalletSigner } from "../src/adapters/BrowserWalletSigner";

test("signs a SIWE message through a raw EIP-1193 provider", async () => {
  const address = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const siweMessage = [
    "app.example wants you to sign in with your Ethereum account:",
    address,
    "",
    "Sign in to TinyCloud",
    "",
    "URI: https://app.example",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: test-nonce",
  ].join("\n");
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      requests.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return "0x1";
        case "personal_sign":
          return "0xsigned-siwe-message";
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    },
  };

  const signer = new BrowserWalletSigner(provider);
  const signature = await signer.signMessage(siweMessage);

  expect(signature).toBe("0xsigned-siwe-message");
  expect(requests.at(-1)).toEqual({
    method: "personal_sign",
    params: [stringToHex(siweMessage), address],
  });
});

test("connected wallet lookup reflects account switches and disconnections", async () => {
  const first = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
  const second = "0x1111111111111111111111111111111111111111";
  let accounts = [first];
  const signer = new BrowserWalletSigner({
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return accounts;
      throw new Error(`Unexpected method: ${method}`);
    },
  });

  expect(await signer.getConnectedAddress()).toBe(first);
  accounts = [second];
  expect(await signer.getConnectedAddress()).toBe(second);
  accounts = [];
  expect(await signer.getConnectedAddress()).toBeUndefined();
});
