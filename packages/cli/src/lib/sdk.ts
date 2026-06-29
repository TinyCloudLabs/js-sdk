import { TinyCloudNode } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import type { CLIContext } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { replayAdditionalDelegations } from "./permissions.js";

/**
 * Returns true when a JWK carries the private-key parameter required by the
 * WASM signer. The CLI is OKP/EC-only (Ed25519, secp256k1) where `d` is the
 * private scalar — RSA's `p`/`q`/etc. are out of scope.
 *
 * Defensive: a public-only JWK (e.g. one echoed back by OpenKey after the
 * delegation flow stripped `d`) must not be used to construct the signer.
 */
export function jwkHasPrivateParameter(jwk: unknown): boolean {
  if (!jwk || typeof jwk !== "object") return false;
  const d = (jwk as Record<string, unknown>).d;
  return typeof d === "string" && d.length > 0;
}

/**
 * Pick the JWK to hand to the signer: the persisted session's JWK only if it
 * carries the private parameter, otherwise the profile's `key.json` (which is
 * always the full keypair). This guards against `session.json` containing a
 * public-only JWK — e.g. when OpenKey echoes back the stripped delegation key.
 */
export function selectSignerJwk(
  sessionJwk: unknown,
  key: object | null,
): object | undefined {
  if (jwkHasPrivateParameter(sessionJwk)) {
    return sessionJwk as object;
  }
  return key ?? undefined;
}

/**
 * Create a TinyCloudNode instance from the current CLI context.
 * Uses the profile's persisted session and key.
 *
 * Supports both auth methods:
 * - "local": Uses the stored Ethereum private key directly
 * - "openkey": Restores session from stored delegation data (browser auth flow)
 */
export async function createSDKInstance(
  ctx: CLIContext,
  options?: { privateKey?: string }
): Promise<TinyCloudNode> {
  // A headless delegate may pass a private key with no persisted profile at all.
  // Only require a profile when we have no explicit key to fall back on.
  const profile = options?.privateKey
    ? await ProfileManager.getProfile(ctx.profile).catch(() => null)
    : await ProfileManager.getProfile(ctx.profile);
  const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
  const key = await ProfileManager.getKey(ctx.profile);

  // For local auth, use the stored private key
  const effectivePrivateKey = options?.privateKey ?? profile?.privateKey;

  if (!key && !effectivePrivateKey) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `No key found for profile "${ctx.profile}". Run \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED,
    );
  }

  if (profile?.authMethod === "local" && effectivePrivateKey) {
    // Local key auth: prefer the persisted TinyCloud session so the CLI
    // keeps the same session key DID across request/grant/import flows.
    const node = new TinyCloudNode({
      host: ctx.host,
      privateKey: effectivePrivateKey,
    });

    if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
      await node.restoreSession({
        delegationHeader: session.delegationHeader as { Authorization: string },
        delegationCid: session.delegationCid as string,
        spaceId: session.spaceId as string,
        jwk: selectSignerJwk(session.jwk, key),
        verificationMethod: (session.verificationMethod as string) ?? profile?.sessionDid ?? profile?.did,
        address: session.address as string | undefined,
        chainId: session.chainId as number | undefined,
        siwe: session.siwe as string | undefined,
        signature: session.signature as string | undefined,
      });
    } else {
      await node.signIn();
    }
    await replayAdditionalDelegations(node, ctx.profile);
    return node;
  }

  // OpenKey / delegation-based auth
  const node = new TinyCloudNode({
    host: ctx.host,
    privateKey: options?.privateKey,
  });

  if (options?.privateKey) {
    // Sign in with private key (existing behavior)
    await node.signIn();
  } else if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
    // Restore session from stored delegation data (browser auth flow)
    await node.restoreSession({
      delegationHeader: session.delegationHeader as { Authorization: string },
      delegationCid: session.delegationCid as string,
      spaceId: session.spaceId as string,
      jwk: selectSignerJwk(session.jwk, key),
      verificationMethod: (session.verificationMethod as string) ?? profile?.did,
      address: session.address as string | undefined,
      chainId: session.chainId as number | undefined,
      siwe: session.siwe as string | undefined,
      signature: session.signature as string | undefined,
    });
  }

  await replayAdditionalDelegations(node, ctx.profile);
  return node;
}

/**
 * Ensure the user is authenticated.
 * Throws AUTH_REQUIRED if no session exists.
 */
export async function ensureAuthenticated(
  ctx: CLIContext,
  options?: { privateKey?: string }
): Promise<TinyCloudNode> {
  // An explicitly-provided private key (--private-key / TC_PRIVATE_KEY) is a
  // first-class headless identity: accept it before any profile/session gate so
  // delegates can authenticate with no persisted profile and no login session.
  if (options?.privateKey) {
    return createSDKInstance(ctx, options);
  }

  const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);

  // For local auth, we can sign in directly without a stored session
  if (profile?.authMethod === "local" && profile.privateKey) {
    return createSDKInstance(ctx, { privateKey: profile.privateKey });
  }

  const session = await ProfileManager.getSession(ctx.profile);

  if (!session) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `Not authenticated. Run \`tc auth login\` or \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED,
    );
  }

  return createSDKInstance(ctx, options);
}
