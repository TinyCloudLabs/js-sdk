import {
  createOpenKeyManageKeySigningStrategy,
  OpenKeyManageKeyError,
  parseCanonicalTinyCloudIdentity,
  type CanonicalTinyCloudIdentity,
  type ClientSession,
  type OpenKeyManageKeySigningStrategyOptions,
} from "@tinycloud/sdk-core";
import { TinyCloudWeb, type Config } from "./modules/tcw";

/** Configuration for one OAuth-bound canonical TinyCloud sign-in. */
export interface EstablishManageKeySessionOptions {
  /** The canonical identity claim returned with a consented OAuth token. */
  identity: CanonicalTinyCloudIdentity | unknown;
  /** OAuth bearer signer configuration. No browser session credentials are used. */
  signer: Omit<OpenKeyManageKeySigningStrategyOptions, "identity">;
  /** TinyCloud client configuration, including the app's requested capabilities. */
  tinycloud: Omit<Config, "provider" | "signStrategy">;
}

/** Result of a completed TinyCloud sign-in using the OAuth canonical key. */
export interface EstablishManageKeySessionResult {
  client: TinyCloudWeb;
  identity: CanonicalTinyCloudIdentity;
  /** The verified TinyCloud session produced by the public SDK sign-in flow. */
  session: ClientSession;
}

function createCanonicalIdentityProvider(address: string) {
  return {
    request: async ({ method }: { method: string }): Promise<unknown> => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return "0x1";
        case "personal_sign":
          throw new Error(
            "Canonical-key sessions sign only through the OAuth callback",
          );
        default:
          throw new Error(`Unsupported read-only provider method: ${method}`);
      }
    },
  };
}

/**
 * Sign in through the public TinyCloud web SDK using a consented OAuth
 * canonical key. The identity is token-bound; callers cannot select another
 * address or key ID, and the signer makes cookie-free requests only.
 */
export async function establishManageKeySession(
  options: EstablishManageKeySessionOptions,
): Promise<EstablishManageKeySessionResult> {
  const identity = parseCanonicalTinyCloudIdentity(options.identity);
  const client = new TinyCloudWeb({
    ...options.tinycloud,
    provider: createCanonicalIdentityProvider(identity.address),
    signStrategy: createOpenKeyManageKeySigningStrategy({
      ...options.signer,
      identity,
    }),
  });
  const session = await client.signIn();
  if (
    session.address !== identity.address ||
    session.chainId !== identity.chainId
  ) {
    throw new OpenKeyManageKeyError(
      "MESSAGE_REJECTED",
      "TinyCloud session does not match the OAuth canonical identity",
    );
  }
  return { client, identity, session };
}
