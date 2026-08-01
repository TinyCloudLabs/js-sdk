/**
 * Provider utility functions.
 *
 * @packageDocumentation
 */

import { type Address } from "viem";
import { getEnsAvatar, getEnsName } from "viem/ens";
import {
  isAlchemyProvider,
  isAnkrProvider,
  isCloudflareProvider,
  isCustomProvider,
  isEtherscanProvider,
  isInfuraProvider,
  isPocketProvider,
  type EnsData,
  type Networkish,
  type RPCProvider,
} from "./types";
import type { BrowserProvider } from "../adapters/browserProvider";

/**
 * @param rpc - RPCProvider
 * @returns an EIP-1193 RPC provider based on the RPC configuration.
 */
export const getProvider = (rpc?: RPCProvider): BrowserProvider => {
  const network = networkName(
    rpc && "network" in rpc ? rpc.network : undefined,
  );
  const url = rpcUrl(rpc, network) ?? defaultRpcUrl(network);
  return {
    request: async ({ method, params }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: Array.isArray(params) ? params : [],
        }),
      });
      const payload = (await response.json()) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (payload.error) {
        throw new Error(payload.error.message ?? "RPC request failed");
      }
      return payload.result;
    },
    on: () => undefined,
    removeListener: () => undefined,
  } as BrowserProvider;
};

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

const rpcUrl = (rpc: RPCProvider | undefined, network: string): string | undefined => {
  if (rpc && isCustomProvider(rpc)) {
    if (typeof rpc.url === "string") return rpc.url;
    if (rpc.url && typeof rpc.url.url === "string") return rpc.url.url;
  }
  if (!rpc) return undefined;

  if (isEtherscanProvider(rpc)) {
    return defaultRpcUrl(network);
  }
  if (isCloudflareProvider(rpc)) {
    return network === "homestead" ? "https://cloudflare-eth.com" : undefined;
  }
  if (isAlchemyProvider(rpc)) {
    return `https://eth-${alchemyNetwork(network)}.g.alchemy.com/v2/${rpc.apiKey ?? "demo"}`;
  }
  if (isInfuraProvider(rpc)) {
    const projectId = typeof rpc.apiKey === "string" ? rpc.apiKey : rpc.apiKey.projectId;
    return `https://${infuraNetwork(network)}.infura.io/v3/${projectId}`;
  }
  if (isAnkrProvider(rpc)) {
    return `https://rpc.ankr.com/${network}${rpc.apiKey ? `/${rpc.apiKey}` : ""}`;
  }
  if (isPocketProvider(rpc) && rpc.apiKey) {
    return `https://eth-${alchemyNetwork(network)}.gateway.pokt.network/v1/lb/${rpc.apiKey}`;
  }
  return undefined;
};

const networkName = (network: Networkish | undefined): string => {
  if (network === undefined) return "homestead";
  if (typeof network === "string") return network;

  const chainId = typeof network === "number" ? network : network.chainId;
  const numericChainId =
    typeof chainId === "number"
      ? chainId
      : chainId.startsWith("0x")
        ? Number.parseInt(chainId, 16)
        : Number.parseInt(chainId, 10);

  const knownNetwork = knownNetworkNames[numericChainId];
  if (knownNetwork) return knownNetwork;
  if (typeof network !== "number" && network.name) return network.name;
  return String(chainId);
};

const knownNetworkNames: Record<number, string> = {
  1: "homestead",
  3: "ropsten",
  4: "rinkeby",
  5: "goerli",
  10: "optimism",
  42: "kovan",
  69: "optimism-kovan",
  137: "matic",
  80001: "maticmum",
  42161: "arbitrum",
  421611: "arbitrum-rinkeby",
  11155111: "sepolia",
};

const defaultRpcUrl = (network: string): string => {
  switch (network) {
    case "goerli":
      return "https://ethereum-goerli.publicnode.com";
    case "sepolia":
      return "https://ethereum-sepolia.publicnode.com";
    case "matic":
      return "https://polygon-rpc.com";
    case "maticmum":
      return "https://rpc-mumbai.maticvigil.com";
    case "optimism":
      return "https://mainnet.optimism.io";
    case "arbitrum":
      return "https://arb1.arbitrum.io/rpc";
    default:
      return "https://eth.merkle.io";
  }
};

const alchemyNetwork = (network: string): string => {
  switch (network) {
    case "homestead":
      return "mainnet";
    case "matic":
      return "polygon-mainnet";
    case "maticmum":
      return "polygon-mumbai";
    default:
      return network;
  }
};

const infuraNetwork = (network: string): string =>
  network === "homestead" ? "mainnet" : network;
