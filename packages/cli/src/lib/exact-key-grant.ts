import { ownerFullAccess } from "@tinycloud/sdk-core";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore } from "@tinycloud/operations/state";
import type { PermissionEntry, TinyCloudNode } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";
import type { CLIContext, ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { recordRegistryFallbackWarning } from "../output/warnings.js";

/** The shortest session a grant can be cut from: the node refuses a delegation from a session about to end. */
const MIN_SIGNING_SESSION_MS = 10 * 60 * 1000;

/**
 * A node signed in with the owner's wallet key whose session is the owner's plain sign-in plus `keyEntries` (each
 * secret's own key, with only the actions asked for; never a `secrets/` prefix), so `delegateTo` can hand those keys to an agent. A secret's
 * key must be in the SIGNED session a grant is cut from (TinyCloudNode.delegateTo), and the profile's stored
 * session never carries one. This session is one-use: it is never stored, and it ends no later than the grant it
 * signs (a secret-key grant lasts 1 hour unless asked, at most 7 days).
 *
 * The wallet key is the profile's own (`local` method) or `TC_PRIVATE_KEY`; a profile with neither cannot sign.
 */
export async function withExactKeyNode<T>(params: {
  ctx: Pick<CLIContext, "host" | "profile">;
  profile: ProfileConfig | null;
  keyEntries: readonly PermissionEntry[];
  /** The request's `requestedExpiry`: what the grant itself lasts, clamped like any secret-key grant. */
  expiry: string | number | undefined;
}, use: (node: TinyCloudNode) => Promise<T>): Promise<T> {
  const privateKey = (params.profile?.authMethod === "local" ? params.profile.privateKey : undefined) ??
    (process.env.TC_PRIVATE_KEY || undefined);
  if (!privateKey) {
    throw new CLIError(
      "AUTH_REQUIRED",
      "This profile has no wallet key, and granting access to a secret needs your wallet's own key to sign it. Set `TC_PRIVATE_KEY` and rerun it, or use a profile set up with `tc init --key-only` and `tc auth login --method local`.",
      ExitCode.AUTH_REQUIRED,
    );
  }
  const nodeSdk = await import("@tinycloud/node-sdk");
  const grantMs = nodeSdk.secretKeyGrantExpiryMs(params.expiry);
  const keyAbilities: Record<string, string[]> = {};
  for (const entry of params.keyEntries) {
    keyAbilities[entry.path] = [...new Set([...(keyAbilities[entry.path] ?? []), ...entry.actions])];
  }
  const node = new nodeSdk.TinyCloudNode({
    registryCacheStore: createProfileRegistryCacheStore(params.ctx.profile),
    registrySequenceStore: createProfileRegistrySequenceStore(params.ctx.profile),
    onRegistryFallback: recordRegistryFallbackWarning,
    tinycloudRegistryUrl: process.env.TC_REGISTRY_URL || params.profile?.tinycloudRegistryUrl,
    privateKey,
    ...ownerFullAccess(),
    host: params.ctx.host,
    autoCreateSpace: true,
    additionalRawAbilities: keyAbilities,
    sessionExpirationMs: Math.max(grantMs, MIN_SIGNING_SESSION_MS),
  });
  try {
    await node.signIn();
    return await use(node);
  } finally {
    // The session ends with the grant, success or not; it was never stored.
    await node.signOut().catch(() => undefined);
  }
}
