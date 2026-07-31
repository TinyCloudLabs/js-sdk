/**
 * Browser-coupled extension types.
 *
 * These types stay in web-sdk because they depend on browser-specific
 * APIs (@tinycloud/web-sdk-wasm, EIP-1193 provider, axios).
 *
 * @packageDocumentation
 */

import { tcwSession } from "@tinycloud/web-sdk-wasm";
import { AxiosInstance } from "axios";
import type { BrowserProvider } from "../adapters/browserProvider";
import type { ClientSession, SiweConfig } from "@tinycloud/sdk-core";
import type { ClientConfig } from "./config";

/** Extra SIWE fields. */
export type ExtraFields = tcwSession.ExtraFields;

/** Overrides for the session configuration. */
export type ConfigOverrides = {
  siwe?: SiweConfig;
};

/** Interface to an intermediate TCW state: connected, but not signed-in. */
export interface IConnected {
  /** Instance of TCWSessionManager. */
  builder: tcwSession.TCWSessionManager;
  /** TCWConfig object. */
  config: ClientConfig;
  /** List of enabled extensions. */
  extensions: Extension[];
  /** Web3 provider. */
  provider: BrowserProvider;
  /** Promise that is initialized on construction to run the "afterConnect" methods of extensions. */
  afterConnectHooksPromise: Promise<void>;
  /** Method to verify if extension is enabled. */
  isExtensionEnabled: (namespace: string) => boolean;
  /** Axios instance. */
  api?: AxiosInstance;
  /** Method to apply the "afterConnect" methods and the delegated capabilities of the extensions. */
  applyExtensions: () => Promise<void>;
  /** Method to apply the "afterSignIn" methods of the extensions. */
  afterSignIn: (session: ClientSession) => Promise<void>;
  /** Method to request the user to sign in. */
  signIn: () => Promise<ClientSession>;
  /** Method to request the user to sign out. */
  signOut: (session: ClientSession) => Promise<void>;
}

/** Interface for an extension to TCW. */
export interface Extension {
  /** [recap] Capability namespace. */
  namespace?: string;
  /** [recap] Default delegated actions in capability namespace. */
  defaultActions?(): Promise<string[]>;
  /** [recap] Delegated actions by target in capability namespace. */
  targetedActions?(): Promise<{ [target: string]: string[] }>;
  /** [recap] Extra metadata to help validate the capability. */
  extraFields?(): Promise<ExtraFields>;
  /** Hook to run after TCW has connected to the user's wallet.
   * This can return an object literal to override the session configuration before the user
   * signs in. */
  afterConnect?(tcw: IConnected): Promise<ConfigOverrides>;
  /** Hook to run after TCW has signed in. */
  afterSignIn?(session: ClientSession): Promise<void>;
}
