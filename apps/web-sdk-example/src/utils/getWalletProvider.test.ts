import { expect, test } from "bun:test";
import type { BrowserWalletProvider } from "@tinycloud/web-sdk";
import { getWalletProvider } from "./getWalletProvider";

test("uses the connector's EIP-1193 provider as the TinyCloud driver", async () => {
  const provider = {
    on: () => undefined,
    removeListener: () => undefined,
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x1";
      throw new Error(`Unexpected method: ${method}`);
    },
  } as unknown as BrowserWalletProvider;
  const walletClient = {
    transport: { type: "viem", request: "not-an-eip-1193-request" },
  };
  const connector = {
    getProvider: async () => provider,
  };

  const driver = await getWalletProvider(connector);

  expect(driver).toBe(provider);
  expect(driver).not.toBe(walletClient.transport);
  expect(typeof driver.request).toBe("function");
  await expect(
    driver.request({ method: "eth_chainId" }),
  ).resolves.toBe("0x1");
});

test("rejects a connector result without an EIP-1193 request method", async () => {
  const connector = {
    getProvider: async () => ({ type: "viem transport" }),
  };

  await expect(getWalletProvider(connector)).rejects.toThrow(
    "EIP-1193 request method",
  );
});
