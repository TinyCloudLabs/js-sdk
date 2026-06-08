export interface GlobalConfig {
  defaultProfile: string;
  version: number;
}

export type AuthMethod = "openkey" | "local";

export const CLI_PROFILE_POSTURES = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
] as const;

export type CLIProfilePosture = typeof CLI_PROFILE_POSTURES[number];

export const CLI_OPERATOR_TYPES = ["human", "agent"] as const;

export type CLIOperatorType = typeof CLI_OPERATOR_TYPES[number];

export function isCLIProfilePosture(value: unknown): value is CLIProfilePosture {
  return typeof value === "string" && CLI_PROFILE_POSTURES.includes(value as CLIProfilePosture);
}

export function isCLIOperatorType(value: unknown): value is CLIOperatorType {
  return typeof value === "string" && CLI_OPERATOR_TYPES.includes(value as CLIOperatorType);
}

export function resolveProfilePosture(profile: {
  posture?: unknown;
  authMethod?: AuthMethod;
}): CLIProfilePosture {
  if (isCLIProfilePosture(profile.posture)) return profile.posture;
  if (profile.authMethod === "local") return "local-owner-key";
  return "owner-openkey";
}

export function resolveProfileOperatorType(profile: {
  operatorType?: unknown;
}): CLIOperatorType {
  if (isCLIOperatorType(profile.operatorType)) return profile.operatorType;
  return "human";
}

export interface ProfileConfig {
  name: string;
  host: string;
  chainId: number;
  spaceName: string;
  did: string;
  primaryDid?: string;
  spaceId?: string;
  createdAt: string;
  posture?: CLIProfilePosture;
  operatorType?: CLIOperatorType;
  authMethod?: AuthMethod;
  /** Hex-encoded Ethereum private key (only present when authMethod is "local") */
  privateKey?: string;
  /** Ethereum address derived from privateKey (only present when authMethod is "local") */
  address?: string;
  /**
   * Optional OpenKey host override. Used for testing accounts or running
   * against a self-hosted OpenKey (e.g. https://openkey.localhost). Falls
   * back to DEFAULT_OPENKEY_HOST when unset. Edit profile.json directly
   * to change.
   */
  openkeyHost?: string;
}

export interface CLIContext {
  profile: string;
  host: string;
  verbose: boolean;
  noCache: boolean;
  quiet: boolean;
}
