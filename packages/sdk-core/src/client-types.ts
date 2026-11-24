/**
 * Platform-agnostic client types for TinyCloud SDK.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import { SiweMessage } from "siwe";

export { SiweMessage };

/** ENS data associated with a user session. */
export interface EnsData {
  domain?: string | null;
  avatarUrl?: string | null;
}

export const EnsDataSchema = z.object({
  domain: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});

/** SIWE configuration. All fields optional — callers provide only what they need to override. */
export interface SiweConfig {
  domain?: string;
  uri?: string;
  chainId?: number;
  statement?: string;
  nonce?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export const SiweConfigSchema = z
  .object({
    domain: z.string().optional(),
    uri: z.string().optional(),
    chainId: z.number().optional(),
    statement: z.string().optional(),
    nonce: z.string().optional(),
    expirationTime: z.string().optional(),
    notBefore: z.string().optional(),
    requestId: z.string().optional(),
    resources: z.array(z.string()).optional(),
  })
  .passthrough();

/** Representation of an active client session. */
export interface ClientSession {
  /** User address (may be delegated) */
  address: string;
  /** User address without delegation */
  walletAddress: string;
  /** EIP-155 chain ID */
  chainId: number;
  /** Key to identify the session */
  sessionKey: string;
  /** The SIWE message text (from SiweMessage.prepareMessage()) */
  siwe: string;
  /** The signature of the SIWE message */
  signature: string;
  /** ENS data supported by TinyCloud */
  ens?: EnsData;
}

/** Requested resources left out because the node does not advertise named-key support. */
export interface SignInWarning {
  readonly code: "NODE_FEATURE_UNAVAILABLE";
  readonly feature: "encryption-named-keys-v1";
  readonly resources: readonly string[];
}

/** Diagnostics from this sign-in attempt, separate from granted authority. */
export interface SignInResult {
  readonly warnings?: readonly SignInWarning[];
}

export type ClientSignInResult = ClientSession & SignInResult;

export const ClientSessionSchema = z.object({
  address: z.string(),
  walletAddress: z.string(),
  chainId: z.number(),
  sessionKey: z.string(),
  siwe: z.string(),
  signature: z.string(),
  ens: EnsDataSchema.optional(),
});

/** The URL of a server running tinycloud-node. */
export type ServerHost = string;

/** Validate unknown data as a ClientSession. Returns the parsed session or null. */
export function validateClientSession(data: unknown): ClientSession | null {
  const result = ClientSessionSchema.safeParse(data);
  return result.success ? result.data : null;
}
