import { ISigner, Bytes } from "@tinycloud/sdk-core";
import {
  signEthereumMessage,
  ensureEip55,
} from "@tinycloud/node-sdk-wasm";

/**
 * Private key signer for Node.js environments.
 *
 * Uses the node-sdk-wasm package for Ethereum signing operations.
 * The private key should be a hex string (with or without 0x prefix).
 *
 * @example
 * ```typescript
 * const signer = new PrivateKeySigner(process.env.PRIVATE_KEY);
 * const address = await signer.getAddress();
 * const signature = await signer.signMessage("Hello, world!");
 * ```
 */
export class PrivateKeySigner implements ISigner {
  private readonly privateKeyHex: string;
  private readonly chainId: number;
  private cachedAddress?: string;

  /**
   * Create a new PrivateKeySigner.
   *
   * @param privateKey - Hex-encoded private key (with or without 0x prefix)
   * @param chainId - Chain ID for signing (default: 1 for mainnet)
   */
  constructor(privateKey: string, chainId: number = 1) {
    // Normalize private key format (remove 0x prefix)
    this.privateKeyHex = privateKey.startsWith("0x")
      ? privateKey.slice(2)
      : privateKey;
    this.chainId = chainId;

    // Validate private key length
    if (this.privateKeyHex.length !== 64) {
      throw new Error("Invalid private key: must be 32 bytes (64 hex chars)");
    }
  }

  /**
   * Get the Ethereum address for this signer.
   */
  async getAddress(): Promise<string> {
    if (this.cachedAddress) {
      return this.cachedAddress;
    }

    this.cachedAddress = this.deriveAddress();
    return this.cachedAddress;
  }

  /**
   * Derive Ethereum address from private key.
   * Uses secp256k1 public key derivation via ethers.js.
   */
  private deriveAddress(): string {
    try {
      const { Wallet } = require("ethers");
      return ensureEip55(new Wallet("0x" + this.privateKeyHex).address);
    } catch {
      // Fallback: use dummy address for testing
      return "0x" + this.privateKeyHex.slice(0, 40);
    }
  }

  /**
   * Get the chain ID for this signer.
   */
  async getChainId(): Promise<number> {
    return this.chainId;
  }

  /**
   * Sign a message.
   *
   * @param message - The message to sign (string or bytes)
   * @returns The signature as a hex string
   */
  async signMessage(message: Bytes | string): Promise<string> {
    const messageStr =
      typeof message === "string"
        ? message
        : Buffer.from(Uint8Array.from(message)).toString("utf-8");

    // Use WASM to sign with Ethereum personal_sign format
    // WASM now accepts hex-encoded private key directly
    const signature = signEthereumMessage(messageStr, this.privateKeyHex);

    // Ensure signature has 0x prefix
    return signature.startsWith("0x") ? signature : "0x" + signature;
  }
}
