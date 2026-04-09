/**
 * Client configuration types for TCW.
 *
 * @packageDocumentation
 */

import type { ClientSession, SiweConfig } from "@tinycloud/sdk-core";
import type { RPCProvider, ServerRoutes } from "./types";

/** Core config for TCW. */
export interface ClientConfig {
  /** Connection to a cryptographic keypair and/or network. */
  providers?: ClientProviders;
  /**
   * SIWE nonce override. If omitted, the WASM layer generates a random nonce.
   * If `siweConfig.nonce` is also provided, `siweConfig.nonce` wins.
   */
  nonce?: string;
  /** Optional session configuration for the SIWE message. */
  siweConfig?: SiweConfig;
  /** Whether or not ENS resolution is enabled. True means resolve all on client. */
  resolveEns?: boolean;
}

/** The URL of the server running tcw-server. Providing this field enables SIWE server communication */
export type ServerHost = string;

/** The tcw-powered server configuration settings */
export type ProviderServer = {
  host: ServerHost;
  /** Optional configuration for the server's routes. */
  routes?: ServerRoutes;
};

/** Web3 provider configuration settings */
export interface ProviderWeb3 {
  /**
   * window.ethereum for Metamask;
   * web3modal.connect() for Web3Modal;
   * const signer = useSigner(); const provider = signer.provider; from Wagmi for Rainbowkit
   * */
  driver: any;
}

/** TCW web3 configuration settings */
export interface ClientProviders {
  /** Web3 wallet provider */
  web3?: ProviderWeb3;
  /** JSON RPC provider configurations */
  rpc?: RPCProvider;
  /** Optional reference to server running tcw-server.
   * Providing this field enables communication with tcw-server */
  server?: ProviderServer;
}
