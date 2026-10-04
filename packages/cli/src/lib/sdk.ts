import { TinyCloudNode, type PortableDelegation } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture, type CLIContext, type ProfileConfig } from "../config/types.js";
import { CLIError, wrapError } from "../output/errors.js";
import { ExitCode, PROFILE_COMMIT_LOCK_TIMEOUT_MS } from "../config/constants.js";
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

function signerJwkForProfile(
  profileName: string,
  sessionJwk: unknown,
  key: object | null,
): object {
  const jwk = selectSignerJwk(sessionJwk, key);
  if (jwkHasPrivateParameter(jwk)) {
    return jwk as object;
  }

  throw new CLIError(
    "AUTH_REQUIRED",
    `Profile "${profileName}" cannot restore its session because its private key material is missing.`,
    ExitCode.AUTH_REQUIRED,
    {
      hint: `Sign in again with: tc --profile ${profileName} auth login --method openkey`,
    },
  );
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

  if (!key && !effectivePrivateKey && !(profile?.authMethod === "openkey" && session !== null)) {
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

    let restoredOwnSession = false;
    if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
      await node.restoreSession({
        delegationHeader: session.delegationHeader as { Authorization: string },
        delegationCid: session.delegationCid as string,
        spaceId: session.spaceId as string,
        jwk: signerJwkForProfile(ctx.profile, session.jwk, key),
        verificationMethod: (session.verificationMethod as string) ?? profile?.sessionDid ?? profile?.did,
        address: session.address as string | undefined,
        chainId: session.chainId as number | undefined,
        siwe: session.siwe as string | undefined,
        signature: session.signature as string | undefined,
      });
      restoredOwnSession = true;
    } else {
      await node.signIn();
    }
    // Only the profile's own restored session may migrate its records: a
    // fresh sign-in uses a session key they do not address, and an explicit
    // key is another identity.
    await replayAdditionalDelegations(node, ctx.profile, {
      host: ctx.host,
      ownerSpace: profile.spaceId,
      migrate: restoredOwnSession && options?.privateKey === undefined,
    });
    return node;
  }

  // OpenKey / delegation-based auth
  const node = new TinyCloudNode({
    host: ctx.host,
    privateKey: options?.privateKey,
  });

  // Only the profile's own restored session may run its binding migration.
  let restoredOwnSession = false;
  if (options?.privateKey) {
    // Sign in with private key (existing behavior)
    await node.signIn();
  } else if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
    // Restore session from stored delegation data (browser auth flow)
    await node.restoreSession({
      delegationHeader: session.delegationHeader as { Authorization: string },
      delegationCid: session.delegationCid as string,
      spaceId: session.spaceId as string,
      jwk: signerJwkForProfile(ctx.profile, session.jwk, key),
      verificationMethod: (session.verificationMethod as string) ?? profile?.did,
      address: session.address as string | undefined,
      chainId: session.chainId as number | undefined,
      siwe: session.siwe as string | undefined,
      signature: session.signature as string | undefined,
    });
    restoredOwnSession = true;
  }

  await replayAdditionalDelegations(node, ctx.profile, {
    host: ctx.host,
    ownerSpace: profile?.spaceId,
    migrate: restoredOwnSession,
  });
  return node;
}

/**
 * A delegate-session bootstrap that can be undone while nothing newer has
 * replaced what it wrote.
 */
export interface DelegatedSessionBootstrap {
  readonly node: TinyCloudNode;
  /**
   * Abandons the bootstrap after `cause` failed a later step, then rethrows
   * `cause`. Under the profile lock, the session is removed and the
   * profile's session DID and space put back only if the session and those
   * two fields still hold exactly what the bootstrap wrote; other profile
   * fields are left as they are. Otherwise another writer (a login, logout
   * or profile update) replaced them meanwhile; its state is kept and the
   * rethrown error says so.
   */
  abandon(cause: unknown): Promise<never>;
}

/** The profile fields a bootstrap writes, and a rollback compares and restores. */
const BOOTSTRAP_PROFILE_FIELDS = ["sessionDid", "spaceId"] as const;

/** What a bootstrap replaced and what it wrote, read and written under the profile lock. */
interface BootstrapWrite {
  readonly previousProfile: ProfileConfig;
  readonly profile: ProfileConfig;
  readonly session: Record<string, unknown>;
}

/**
 * Establish the first authenticated session for a fresh delegate-session
 * profile from a delegation targeted at that profile's generated key. The
 * profile, key and absent session are read, and the session and profile
 * written, in one profile-lock critical section; a session that appeared
 * since the caller checked is never replaced.
 */
export async function bootstrapDelegatedSession(
  ctx: CLIContext,
  delegation: PortableDelegation,
): Promise<DelegatedSessionBootstrap> {
  const written = await ProfileManager.withLock(ctx.profile, async (): Promise<BootstrapWrite> => {
    const previousProfile = await ProfileManager.getProfile(ctx.profile);
    if (resolveProfilePosture(previousProfile) !== "delegate-session") {
      throw new CLIError(
        "AUTH_REQUIRED",
        `Profile "${ctx.profile}" is not a delegate-session profile.`,
        ExitCode.AUTH_REQUIRED,
      );
    }

    const sessionDid = previousProfile.sessionDid ?? previousProfile.did;
    if (delegation.delegateDID.split("#", 1)[0] !== sessionDid.split("#", 1)[0]) {
      throw new CLIError(
        "DELEGATION_AUDIENCE_MISMATCH",
        `Delegation targets ${delegation.delegateDID}, but profile "${ctx.profile}" uses ${sessionDid}.`,
        ExitCode.PERMISSION_DENIED,
      );
    }

    if (await ProfileManager.getSession(ctx.profile) !== null) {
      throw new CLIError(
        "PROFILE_CHANGED_DURING_IMPORT",
        `Profile "${ctx.profile}" gained a session (another login or import) after this import checked it. Nothing was saved; run the import again.`,
        ExitCode.ERROR,
      );
    }

    const jwk = signerJwkForProfile(ctx.profile, undefined, await ProfileManager.getKey(ctx.profile));
    const session = {
      delegationHeader: delegation.delegationHeader,
      delegationCid: delegation.cid,
      spaceId: delegation.spaceId,
      jwk,
      verificationMethod: sessionDid,
    };
    const profile = { ...previousProfile, sessionDid, spaceId: delegation.spaceId };
    try {
      await ProfileManager.setSession(ctx.profile, session);
      await ProfileManager.setProfile(ctx.profile, profile);
    } catch (error) {
      throw annotate(error, await restoreBeforeBootstrap(ctx.profile, previousProfile));
    }
    return { previousProfile, profile, session };
  });

  const abandon = async (cause: unknown): Promise<never> => {
    const note = await ProfileManager.withLock(ctx.profile, async () => {
      const profile = await ProfileManager.getProfile(ctx.profile).catch((error: unknown) => {
        if (error instanceof CLIError && error.code === "PROFILE_NOT_FOUND") return null;
        throw error;
      });
      const session = await ProfileManager.getSession(ctx.profile);
      if (
        profile === null ||
        BOOTSTRAP_PROFILE_FIELDS.some((field) => profile[field] !== written.profile[field]) ||
        JSON.stringify(session) !== JSON.stringify(written.session)
      ) {
        return `Profile "${ctx.profile}" changed while the import was pending (another login, logout or profile update), so its newer state was kept and the provisional session was not rolled back.`;
      }
      return restoreBeforeBootstrap(ctx.profile, written.previousProfile);
    }, { timeoutMs: PROFILE_COMMIT_LOCK_TIMEOUT_MS }).catch((error: unknown) =>
      // The lock or a read failed: the import's error stays the one reported.
      `Rolling back the provisional session of profile "${ctx.profile}" could not run (${failureName(error)}); check \`tc --profile ${ctx.profile} context\`.`);
    throw annotate(cause, note);
  };

  let node: TinyCloudNode;
  try {
    node = await createSDKInstance(ctx);
  } catch (error) {
    return abandon(error);
  }
  return { node, abandon };
}

/**
 * Removes the bootstrap's session and puts back the session DID and space
 * the profile had before it, keeping any other profile field as it is now.
 * Both writes are attempted; returns a note naming any failure.
 */
async function restoreBeforeBootstrap(profileName: string, previousProfile: ProfileConfig): Promise<string | undefined> {
  const failures: string[] = [];
  for (const write of [
    () => ProfileManager.clearSession(profileName),
    () => ProfileManager.updateProfile(profileName, (current) => {
      const restored = { ...current };
      for (const field of BOOTSTRAP_PROFILE_FIELDS) {
        if (previousProfile[field] === undefined) delete restored[field];
        else restored[field] = previousProfile[field];
      }
      return restored;
    }),
  ]) {
    await write().catch((error: unknown) => {
      failures.push(failureName(error));
    });
  }
  if (failures.length === 0) return undefined;
  return `Rolling back the provisional session of profile "${profileName}" failed too (${failures.join("; ")}); check \`tc --profile ${profileName} context\`.`;
}

/**
 * Names a failure for a rollback note by its code (a CLI error code or an
 * errno such as EACCES), never by its message: messages can quote file
 * contents (Node's JSON parse errors quote the malformed text, which may be
 * session material).
 */
function failureName(error: unknown): string {
  if (error instanceof SyntaxError) return "a profile file is not valid JSON";
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown error";
}

/** `error` as a CLIError (same code and exit code) with `note` appended, or unchanged without a note. */
function annotate(error: unknown, note: string | undefined): unknown {
  if (note === undefined) return error;
  const cause = wrapError(error);
  return new CLIError(cause.code, `${cause.message} ${note}`, cause.exitCode, cause.metadata);
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

  // For local auth, we can sign in directly without a stored session. The
  // profile's own key is not an override: createSDKInstance reads it from the
  // profile, so the profile's binding migration may run.
  if (profile?.authMethod === "local" && profile.privateKey) {
    return createSDKInstance(ctx);
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
