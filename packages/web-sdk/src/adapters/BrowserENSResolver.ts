import { IENSResolver } from "@tinycloud/sdk-core";
import { type Address } from "viem";
import { getEnsAddress, getEnsAvatar, getEnsName, normalize } from "viem/ens";
import {
  toEip1193Provider,
  type BrowserWalletProvider,
} from "./browserProvider";

export class BrowserENSResolver implements IENSResolver {
  private readonly provider: Parameters<typeof getEnsName>[0];

  constructor(provider: BrowserWalletProvider) {
    const eip1193 = toEip1193Provider(provider);
    this.provider = {
      chain: {
        id: 1,
        name: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["https://eth.merkle.io"] } },
        contracts: {
          ensUniversalResolver: {
            address: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee",
          },
        },
      },
      request: eip1193.request.bind(eip1193),
    } as Parameters<typeof getEnsName>[0];
  }

  async resolveAddress(ensName: string): Promise<string | null> {
    return getEnsAddress(this.provider, { name: normalize(ensName) });
  }

  async resolveName(address: string): Promise<string | null> {
    return getEnsName(this.provider, { address: address as Address });
  }

  async resolveAvatar(ensName: string): Promise<string | null> {
    return getEnsAvatar(this.provider, { name: normalize(ensName) }).catch(
      () => null,
    );
  }
}
