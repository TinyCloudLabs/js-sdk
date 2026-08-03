import type { Connector } from "wagmi";
import type { BrowserWalletProvider } from "@tinycloud/web-sdk";

type ConnectedWalletConnector = Pick<Connector, "getProvider">;

export async function getWalletProvider(
  connector: ConnectedWalletConnector | undefined,
): Promise<BrowserWalletProvider> {
  if (!connector) {
    throw new Error("No connected wallet connector is available");
  }

  const provider = await connector.getProvider();
  if (
    !provider ||
    typeof (provider as { request?: unknown }).request !== "function"
  ) {
    throw new Error("Connected wallet did not provide an EIP-1193 request method");
  }

  return provider as BrowserWalletProvider;
}
