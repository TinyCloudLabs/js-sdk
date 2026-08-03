import { ISigner, Bytes } from "@tinycloud/sdk-core";
import { bytesToHex, stringToHex, type Address } from "viem";
import {
  type BrowserProvider,
  type BrowserWalletProvider,
} from "./browserProvider";

/**
 * Browser wallet signer that wraps an EIP-1193 provider.
 * Supports MetaMask, WalletConnect, and any EIP-1193 provider.
 *
 * The wallet popup is triggered by eth_requestAccounts when getAddress() is
 * called -- no separate "strategy" type needed.
 */
export class BrowserWalletSigner implements ISigner {
  private provider: BrowserProvider;
  private cachedAddress?: string;
  private cachedChainId?: number;

  constructor(provider: BrowserWalletProvider) {
    this.provider = provider;
  }

  async getAddress(): Promise<string> {
    if (!this.cachedAddress) {
      const addresses = await this.provider.request({
        method: "eth_requestAccounts",
        params: [],
      });
      const [address] = Array.isArray(addresses) ? addresses : [];
      if (!address) {
        throw new Error("No wallet account is connected");
      }
      this.cachedAddress = address;
    }
    return this.cachedAddress;
  }

  async getConnectedAddress(): Promise<string | undefined> {
    if (this.cachedAddress) return this.cachedAddress;

    const accounts = await this.provider.request({
      method: "eth_accounts",
      params: [],
    });
    const [address] = Array.isArray(accounts) ? accounts : [];
    if (typeof address === "string" && address.length > 0) {
      this.cachedAddress = address;
      return address;
    }
    return undefined;
  }

  async getChainId(): Promise<number> {
    if (!this.cachedChainId) {
      const chainId = await this.provider.request({
        method: "eth_chainId",
        params: [],
      });
      this.cachedChainId = Number.parseInt(String(chainId), 16);
    }
    return this.cachedChainId;
  }

  async signMessage(message: Bytes | string): Promise<string> {
    const address = (await this.getAddress()) as Address;
    const rawMessage =
      typeof message === "string"
        ? stringToHex(message)
        : bytesToHex(Uint8Array.from(message));
    return this.provider.request({
      method: "personal_sign",
      params: [rawMessage, address],
    }) as Promise<string>;
  }

  /** Get the underlying EIP-1193 provider (for advanced use). */
  getProvider(): BrowserProvider {
    return this.provider;
  }
}
