import { ISigner } from "./signer";
import { ISessionStorage, PersistedSessionData } from "./storage";
import { SignStrategy, ISpaceCreationHandler } from "./authorization";

// Re-export platform-agnostic types from client-types (canonical definitions)
export { ClientSession, EnsData, SiweConfig, SiweMessage } from "./client-types";

import type { ClientSession, SiweConfig } from "./client-types";

/**
 * Interface for an extension to TCW.
 * This is the platform-agnostic subset — browser-coupled extensions
 * (IConnected, ConfigOverrides, ExtraFields) live in web-sdk/providers.
 */
export interface Extension {
  /** [recap] Capability namespace. */
  namespace?: string;
  /** [recap] Default delegated actions in capability namespace. */
  defaultActions?(): Promise<string[]>;
  /** [recap] Delegated actions by target in capability namespace. */
  targetedActions?(): Promise<{ [target: string]: string[] }>;
  /** [recap] Extra metadata to help validate the capability. */
  extraFields?(): Promise<Record<string, unknown>>;
  /** Hook to run after TCW has signed in. */
  afterSignIn?(session: ClientSession): Promise<void>;
}

/**
 * Partial SIWE message for overrides.
 */
export interface PartialSiweMessage extends Partial<SiweConfig> {
  address?: string;
  chainId?: number;
  uri?: string;
  version?: string;
}

/**
 * Options for a single sign-in call.
 */
export interface SignInOptions {
  /** Nonce to use for this sign-in only. Overrides `siweConfig.nonce` when provided. */
  nonce?: string;
}

/**
 * Platform-agnostic user authorization interface.
 *
 * This interface defines how users authenticate and manage sessions.
 * Implementations differ by platform:
 * - WebUserAuthorization: Browser with wallet popups
 * - NodeUserAuthorization: Node.js with configurable sign strategies
 */
export interface IUserAuthorization {
  /**
   * The current active session, if signed in.
   */
  session?: ClientSession;

  /**
   * Add an extension to the authorization flow.
   * Extensions can add capabilities and lifecycle hooks.
   */
  extend(extension: Extension): void;

  /**
   * Sign in and create a new session.
   * This will prompt for wallet signature (browser) or use configured strategy (node).
   * Per-call options override constructor defaults for this sign-in only.
   * @returns The new session
   */
  signIn(options?: SignInOptions): Promise<ClientSession>;

  /**
   * Sign out and clear the current session.
   */
  signOut(): Promise<void>;

  /**
   * Get the current wallet/signer address.
   * @returns Address or undefined if not connected
   */
  address(): string | undefined;

  /**
   * Get the current chain ID.
   * @returns Chain ID or undefined if not connected
   */
  chainId(): number | undefined;

  /**
   * Sign a message with the connected wallet/signer.
   * @param message - Message to sign
   * @returns Signature hex string
   */
  signMessage(message: string): Promise<string>;

  /**
   * Get the current space ID.
   * @returns Space ID or undefined if not available
   */
  getSpaceId?(): string | undefined;

  /**
   * Ensure the user's space exists on the TinyCloud server.
   * Creates the space if it doesn't exist (when autoCreateSpace is true).
   * This is called automatically during sign-in but can be invoked manually.
   */
  ensureSpaceExists?(): Promise<void>;
}

/**
 * Configuration for creating a UserAuthorization instance.
 */
export interface UserAuthorizationConfig {
  /** The signer to use for signing */
  signer: ISigner;
  /** Session storage implementation */
  sessionStorage?: ISessionStorage;
  /** Default SIWE configuration */
  siweConfig?: SiweConfig;
  /** Domain for SIWE messages */
  domain?: string;
  /** Extensions to apply */
  extensions?: Extension[];

  // Strategy configuration (added for auth module unification)
  /** Strategy for handling sign requests (default: auto-sign for node, callback for web) */
  signStrategy?: SignStrategy;
  /** Handler for space creation confirmation (default: AutoApproveSpaceCreationHandler) */
  spaceCreationHandler?: ISpaceCreationHandler;
  /** Whether to automatically create space if it doesn't exist */
  autoCreateSpace?: boolean;
  /** Space name prefix (default: "default") */
  spacePrefix?: string;
  /** TinyCloud host URLs */
  tinycloudHosts?: string[];
  /** Session expiration in milliseconds */
  sessionExpirationMs?: number;
}
