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
  tinycloud: Omit<
    Config,
    "provider" | "signStrategy" | "autoBootstrapAccount"
  >;
}

/** Result of a completed TinyCloud sign-in using the OAuth canonical key. */
export interface EstablishManageKeySessionResult {
  client: TinyCloudWeb;
  identity: CanonicalTinyCloudIdentity;
  /** The verified TinyCloud session produced by the public SDK sign-in flow. */
  session: ClientSession;
}

function createCanonicalIdentityProvider(address: string, chainId: number) {
  return {
    request: async ({ method }: { method: string }): Promise<unknown> => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
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
    provider: createCanonicalIdentityProvider(identity.address, identity.chainId),
    signStrategy: createOpenKeyManageKeySigningStrategy({
      ...options.signer,
      identity,
    }),
    // The manage-key grant signs exactly one session SIWE. Bootstrap requests
    // need broader authority and must not be silently substituted for the
    // app's requested capabilities.
    autoBootstrapAccount: false,
  });
  // A persisted session has already passed TinyCloud's restore validation.
  // Reuse it before asking the OAuth signer for another one-shot SIWE.
  const restored = await client.restoreSession(identity.address);
  const session =
    restored.status === "restored" && restored.session
      ? restored.session
      : await client.signIn();
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
