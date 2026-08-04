/**
 * Provider utility functions.
 *
 * @packageDocumentation
 */

import { type Address } from "viem";
import { getEnsAvatar, getEnsName } from "viem/ens";
import type { EnsData } from "./types";
import type { BrowserProvider } from "../adapters/browserProvider";

/**
 * Resolves ENS data supported by TCW.
 * @param provider - EIP-1193 RPC provider.
 * @param address - User address.
 * @returns Object containing ENS data.
 */
export const resolveEns = async (
  provider: BrowserProvider,
  /* User Address */
  address: string
): Promise<EnsData> => {
  if (!address) {
    throw new Error("Missing address.");
  }
  const ens: EnsData = {};

  try {
    const client = {
      chain: {
        id: 1,
        name: "Ethereum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["https://cloudflare-eth.com"] } },
        contracts: {
          ensUniversalResolver: {
            address: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee",
          },
        },
      },
      request: provider.request.bind(provider),
    } as Parameters<typeof getEnsName>[0];
    const domain = await getEnsName(client, { address: address as Address });
    if (domain) {
      ens["domain"] = domain;
      const avatarUrl = await getEnsAvatar(client, { name: domain });
      if (avatarUrl) {
        ens["avatarUrl"] = avatarUrl;
      }
    }
  } catch (error) {
    console.error(error);
  }

  return ens;
};
