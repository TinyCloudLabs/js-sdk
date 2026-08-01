import { bytesToHex, stringToHex, type EIP1193Provider } from "viem";
import { getEnsAddress, getEnsAvatar, getEnsName } from "viem/ens";

/** The provider shapes accepted by browser wallet adapters. */
export type BrowserWalletProvider =
  | EIP1193Provider
  | {
      provider?: EIP1193Provider;
      send(method: string, params?: unknown[]): Promise<unknown>;
    };

/** The EIP-1193 provider used by the browser-facing SDK. */
export type BrowserProvider = EIP1193Provider;

/**
 * The provider surface retained by TinyCloudWeb.provider for applications
 * written against the pre-viem SDK. New code should use BrowserProvider or
 * TinyCloudWeb.eip1193Provider instead.
 */
export type LegacyWeb3Provider = BrowserProvider & {
  provider: BrowserProvider;
  send(method: string, params?: unknown[]): Promise<unknown>;
  getNetwork(): Promise<{ chainId: number; name: string }>;
  getSigner(address?: string): {
    getAddress(): Promise<string>;
    getChainId(): Promise<number>;
    signMessage(message: string | Uint8Array): Promise<string>;
  };
  lookupAddress(address: string): Promise<string | null>;
  resolveName(name: string): Promise<string | null>;
  getAvatar(address: string): Promise<string | null>;
};

const chainNames: Record<number, string> = {
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

function ensClient(provider: BrowserProvider) {
  return {
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
    request: provider.request.bind(provider),
  } as Parameters<typeof getEnsName>[0];
}

function messageToHex(message: string | Uint8Array): string {
  if (typeof message === "string") {
    return stringToHex(message);
  }
  return bytesToHex(message);
}

/**
 * Adds the legacy Web3Provider methods without bringing ethers back into the
 * browser bundle. The EIP-1193 provider remains the source of truth.
 */
export function toLegacyWeb3Provider(
  provider: BrowserProvider,
): LegacyWeb3Provider {
  const send = (method: string, params: unknown[] = []) =>
    provider.request({ method, params });
  const getChainId = async () => {
    const value = await send("eth_chainId");
    return Number.parseInt(String(value), 16);
  };
  const getAddress = async () => {
    const accounts = await send("eth_requestAccounts");
    const [address] = Array.isArray(accounts) ? accounts : [];
    if (typeof address !== "string" || !address) {
      throw new Error("No wallet account is connected");
    }
    return address;
  };
  const signer = {
    getAddress,
    getChainId,
    signMessage: async (message: string | Uint8Array) => {
      const address = await getAddress();
      return send("personal_sign", [messageToHex(message), address]) as Promise<string>;
    },
  };

  return {
    ...provider,
    provider,
    send,
    getNetwork: async () => {
      const chainId = await getChainId();
      return { chainId, name: chainNames[chainId] ?? `unknown-${chainId}` };
    },
    getSigner: () => signer,
    lookupAddress: async (address) => getEnsName(ensClient(provider), { address: address as `0x${string}` }),
    resolveName: async (name) => getEnsAddress(ensClient(provider), { name }),
    getAvatar: async (address) => {
      const name = await getEnsName(ensClient(provider), { address: address as `0x${string}` });
      return name ? getEnsAvatar(ensClient(provider), { name }) : null;
    },
  };
}

/**
 * Normalizes injected providers and legacy provider wrappers to EIP-1193.
 */
export function toEip1193Provider(
  provider: BrowserWalletProvider,
): EIP1193Provider {
  if ("request" in provider && typeof provider.request === "function") {
    return provider as EIP1193Provider;
  }

  if (
    "provider" in provider &&
    provider.provider &&
    typeof provider.provider.request === "function"
  ) {
    return provider.provider;
  }

  if ("send" in provider && typeof provider.send === "function") {
    return {
      request: ({ method, params }) =>
        provider.send(method, Array.isArray(params) ? params : []),
      on: () => undefined,
      removeListener: () => undefined,
    } as EIP1193Provider;
  }

  throw new Error("The wallet provider does not implement EIP-1193 request");
}
