import { ISigner, Bytes } from "@tinycloud/sdk-core";
import { providers, Signer } from "ethers";

/**
 * Browser wallet signer that wraps ethers.js Web3Provider.
 * Supports MetaMask, WalletConnect, and any EIP-1193 provider.
 *
 * The wallet popup is triggered implicitly by ethers.js when
 * signMessage() is called -- no separate "strategy" type needed.
 */
export class BrowserWalletSigner implements ISigner {
  private provider: providers.Web3Provider;
  private signer: Signer;
  private cachedAddress?: string;
  private cachedChainId?: number;

  constructor(externalProvider: providers.ExternalProvider | providers.Web3Provider) {
    if ((externalProvider as providers.Web3Provider)._isProvider) {
      this.provider = externalProvider as providers.Web3Provider;
    } else {
      this.provider = new providers.Web3Provider(externalProvider as providers.ExternalProvider);
    }
    this.signer = this.provider.getSigner();
  }

  async getAddress(): Promise<string> {
    if (!this.cachedAddress) {
      // This triggers wallet connection popup if not already connected
      this.cachedAddress = await this.signer.getAddress();
    }
    return this.cachedAddress;
  }

  async getConnectedAddress(): Promise<string | undefined> {
    if (this.cachedAddress) return this.cachedAddress;

    const accounts = await this.provider.send("eth_accounts", []);
    const address = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof address === "string" && address.length > 0) {
      this.cachedAddress = address;
      return address;
    }
    return undefined;
  }

  async getChainId(): Promise<number> {
    if (!this.cachedChainId) {
      this.cachedChainId = await this.signer.getChainId();
    }
    return this.cachedChainId;
  }

  async signMessage(message: Bytes | string): Promise<string> {
    return this.signer.signMessage(message);
  }

  /** Get the underlying ethers.js Web3Provider (for advanced use) */
  getProvider(): providers.Web3Provider {
    return this.provider;
  }
}
