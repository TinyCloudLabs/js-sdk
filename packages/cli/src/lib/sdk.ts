import { TinyCloudNode, signedCompactUcanExpiry, type PortableDelegation } from "@tinycloud/node-sdk";
import type { ProfileReplicaLogoutPending } from "@tinycloud/sdk-services/kv/replication";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture, type CLIContext, type ProfileConfig } from "../config/types.js";
import { CLIError, wrapError } from "../output/errors.js";
import { DEFAULT_HOST, ExitCode, PROFILE_COMMIT_LOCK_TIMEOUT_MS } from "../config/constants.js";
import { replayAdditionalDelegations } from "./permissions.js";
import { sessionExpiredError } from "../auth/session-expired.js";
import { ownerSessionLacksProof } from "@tinycloud/operations/profile";
import { recordWarnings } from "../output/warnings.js";
import { delegationExpiredError } from "../auth/delegation-expiry.js";

import { cliRetryPolicy } from "./retry-policy.js";
import { createCliReplicationConfig } from "./replication-config.js";
import { registerReplication } from "./replication-registry.js";
import { assertPendingRemoteLogoutSession, recoverPendingLogout } from "./logout-pending.js";
export { closeReplication, registerReplication, registeredReplications, replicationForProfile } from "./replication-registry.js";
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
      hint: `Sign in again with: ${CLI_NAME} --profile ${profileName} auth login --method openkey`,
    },
  );
}

/** Whether the compact UCAN behind `delegation` signs an expiry that has passed by this machine's clock. */
function signedLifetimePassed(delegation: PortableDelegation): boolean {
  const authorization = delegation.delegationHeader?.Authorization;
  const expiry = typeof authorization === "string" ? signedCompactUcanExpiry(authorization) : undefined;
  return expiry !== undefined && expiry.getTime() <= Date.now();
}

/**
 * Restore the stored session. node-sdk refuses expired or otherwise unusable
 * persisted authority (`AUTH_EXPIRED`) while verifying it locally, before any
 * node request; only a new sign-in fixes that.
 */
async function restoreProfileSession(
  node: TinyCloudNode,
  profileName: string,
  profile: ProfileConfig | null,
  sessionData: Parameters<TinyCloudNode["restoreSession"]>[0],
): Promise<void> {
  const posture = profile === null ? undefined : resolveProfilePosture(profile);
  if (ownerSessionLacksProof(sessionData, profile)) {
    throw sessionExpiredError(profileName, posture);
  }
  try {
    await node.restoreSession(sessionData);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "AUTH_EXPIRED") {
      throw sessionExpiredError(profileName, posture);
    }
    throw error;
  }
}

function persistedSessionData(
  profileName: string,
  profile: ProfileConfig,
  session: Record<string, unknown>,
  key: object | null,
): Parameters<TinyCloudNode["restoreSession"]>[0] {
  return {
    delegationHeader: session.delegationHeader as { Authorization: string },
    delegationCid: session.delegationCid as string,
    spaceId: session.spaceId as string,
    jwk: signerJwkForProfile(profileName, session.jwk, key),
    verificationMethod: (session.verificationMethod as string) ?? profile.sessionDid ?? profile.did,
    address: session.address as string | undefined,
    chainId: session.chainId as number | undefined,
    siwe: session.siwe as string | undefined,
    signature: session.signature as string | undefined,
    replicaStamp: session.replicaStamp as Parameters<TinyCloudNode["restoreSession"]>[0]["replicaStamp"],
  };
}

/** A profile's persisted session restored into a node, or why it could not be. */
export type ProfileSessionRestore =
  | { node: TinyCloudNode }
  | { unavailable: "session_missing" | "session_expired" | "session_invalid" };

/** The part of a CLI context that restoring a stored session reads; a full {@link CLIContext} also fits. */
export type ProfileSessionContext = Pick<CLIContext, "profile" | "host"> & Partial<CLIContext>;

/**
 * Inspect a profile's own persisted session without signing in or replaying a
 * stored grant; this call does not contact the node. Used for local grant
 * inspection and for the read that checks the space after a login.
 */
export async function restoreProfileSessionNode(
  ctx: ProfileSessionContext,
): Promise<ProfileSessionRestore> {
  await recoverPendingLogout(ctx.profile);
  const profile = await ProfileManager.getProfile(ctx.profile);
  const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
  if (!session) return { unavailable: "session_missing" };
  if (typeof session.delegationCid !== "string" || typeof session.spaceId !== "string" ||
    session.delegationHeader === null || typeof session.delegationHeader !== "object" ||
    !("Authorization" in session.delegationHeader) ||
    typeof session.delegationHeader.Authorization !== "string") {
    return { unavailable: "session_invalid" };
  }
  if (typeof session.expiresAt === "string" && Date.parse(session.expiresAt) <= Date.now()) {
    return { unavailable: "session_expired" };
  }
  const key = await ProfileManager.getKey(ctx.profile);
  try {
    const node = new TinyCloudNode({
      host: ctx.host,
      ...(profile.authMethod === "local" && profile.privateKey ? { privateKey: profile.privateKey } : {}),
    });
    await restoreProfileSession(node, ctx.profile, profile, persistedSessionData(ctx.profile, profile, session, key));
    return { node };
  } catch (error) {
    if (error instanceof CLIError && error.metadata?.reason === "session_expired") {
      return { unavailable: "session_expired" };
    }
    return { unavailable: "session_invalid" };
  }
}

/**
 * Whether the profile's stored session, when `createSDKInstance` would restore
 * it, passes the same local verification, run here in a throwaway node: no
 * request is sent and nothing is written. `true` when there is none to restore.
 */
export async function storedSessionVerifiesLocally(profileName: string): Promise<boolean> {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);
  if (profile === null) return true;
  const local = profile.authMethod === "local" && typeof profile.privateKey === "string";
  await recoverPendingLogout(profileName);
  try {
    const session = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
    if (!session || typeof session.delegationCid !== "string" || typeof session.spaceId !== "string" ||
      session.delegationHeader === null || typeof session.delegationHeader !== "object" ||
      !("Authorization" in session.delegationHeader) ||
      typeof session.delegationHeader.Authorization !== "string") return true;
    const key = await ProfileManager.getKey(profileName);
    const node = new TinyCloudNode({
      ...cliRetryPolicy(),
      host: profile.host ?? DEFAULT_HOST,
      ...(local ? { privateKey: profile.privateKey } : {}),
    });
    await restoreProfileSession(node, profileName, profile, persistedSessionData(profileName, profile, session, key));
    return true;
  } catch {
    return false;
  }
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
  options?: {
    privateKey?: string;
    pendingRemoteLogout?: { marker: ProfileReplicaLogoutPending; ownerDid: string; sessionCid: string };
  },
): Promise<TinyCloudNode> {
  if (options?.pendingRemoteLogout) {
    await assertPendingRemoteLogoutSession(ctx.profile, options.pendingRemoteLogout);
  } else {
    await recoverPendingLogout(ctx.profile);
  }
  // A headless delegate may pass a private key with no persisted profile at all.
  // Only require a profile when we have no explicit key to fall back on.
  const storedProfile = options?.privateKey
    ? await ProfileManager.getProfile(ctx.profile).catch(() => null)
    : await ProfileManager.getProfile(ctx.profile);
  if (storedProfile?.authSignedOut === true && !options?.privateKey) {
    throw new CLIError("AUTH_REQUIRED",
      `Profile "${ctx.profile}" was explicitly signed out. Run \`${CLI_NAME} --profile ${ctx.profile} auth login\` to establish a new session.`,
      ExitCode.AUTH_REQUIRED);
  }
  // A headless --private-key identity is not the logged-out profile's key or replica.
  const profile = storedProfile?.authSignedOut === true ? null : storedProfile;
  const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
  const key = await ProfileManager.getKey(ctx.profile);

  // For local auth, use the stored private key
  const effectivePrivateKey = options?.privateKey ?? profile?.privateKey;

  if (!key && !effectivePrivateKey && !(profile?.authMethod === "openkey" && session !== null)) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `No key found for profile "${ctx.profile}". Run \`${CLI_NAME} --profile ${ctx.profile} auth rotate\` to create a new key and sign in.`,
      ExitCode.AUTH_REQUIRED,
    );
  }

  if (profile?.authMethod === "local" && effectivePrivateKey) {
    // Local key auth: prefer the persisted TinyCloud session so the CLI
    // keeps the same session key DID across request/grant/import flows.
    const replication = createCliReplicationConfig(
      ctx.profile,
      profile?.replication,
      { debug: ctx.replicationDebug, quiet: ctx.quiet },
      ctx.replication,
    );
    if (ctx.replication && !replication) {
      process.stderr.write("[replication] Enabled, but this profile has no configured prefixes; reads use the network.\n");
    }
    const node = new TinyCloudNode({
      ...cliRetryPolicy(),
      host: ctx.host,
      privateKey: effectivePrivateKey,
      ...(replication ? { replication } : {}),
    });
    if (node.replication) registerReplication(ctx.profile, node.replication);

    if (options?.pendingRemoteLogout &&
        (!session || session.delegationCid !== options.pendingRemoteLogout.sessionCid)) {
      throw new CLIError("PROFILE_CHANGED_DURING_REVOKE",
        "The retained revocation session disappeared before SDK restore.", ExitCode.ERROR);
    }
    const restoredOwnSession = Boolean(session && session.delegationHeader && session.delegationCid && session.spaceId);
    if (restoredOwnSession) {
      await restoreProfileSession(node, ctx.profile, profile, persistedSessionData(ctx.profile, profile, session!, key));
    } else {
      await node.signIn();
    }
    // The restored persisted session may replay even when an explicit local
    // key is supplied; only ordinary invocations run binding migration.
    if (restoredOwnSession) {
      recordWarnings(await replayAdditionalDelegations(node, ctx.profile, {
        host: ctx.host,
        ownerSpace: profile.spaceId,
        migrate: options?.privateKey === undefined && options?.pendingRemoteLogout === undefined,
      }));
    }
    if (options?.pendingRemoteLogout) {
      await assertPendingRemoteLogoutSession(ctx.profile, options.pendingRemoteLogout);
    }
    return node;
  }

  // OpenKey / delegation-based auth
  const replication = createCliReplicationConfig(
    ctx.profile,
    profile?.replication,
    { debug: ctx.replicationDebug, quiet: ctx.quiet },
    ctx.replication,
  );
  if (ctx.replication && !replication) {
    process.stderr.write("[replication] Enabled, but this profile has no configured prefixes; reads use the network.\n");
  }
  const node = new TinyCloudNode({
    ...cliRetryPolicy(),
    host: ctx.host,
    privateKey: options?.privateKey,
    ...(replication ? { replication } : {}),
  });
  if (node.replication) registerReplication(ctx.profile, node.replication);
  if (options?.pendingRemoteLogout &&
      (!session || session.delegationCid !== options.pendingRemoteLogout.sessionCid)) {
    throw new CLIError("PROFILE_CHANGED_DURING_REVOKE",
      "The retained revocation session disappeared before SDK restore.", ExitCode.ERROR);
  }

  if (options?.privateKey) {
    await node.signIn();
  } else if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
    await restoreProfileSession(node, ctx.profile, profile, persistedSessionData(ctx.profile, profile!, session, key));
    recordWarnings(await replayAdditionalDelegations(node, ctx.profile, {
      host: ctx.host,
      ownerSpace: profile?.spaceId,
      migrate: options?.pendingRemoteLogout === undefined,
    }));
  }
  if (options?.pendingRemoteLogout) {
    await assertPendingRemoteLogoutSession(ctx.profile, options.pendingRemoteLogout);
  }
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
    // A delegation whose signed lifetime has passed would only become a
    // session every command refuses: report the delegation, write nothing.
    if (signedLifetimePassed(delegation)) throw delegationExpiredError();

    const jwk = signerJwkForProfile(ctx.profile, undefined, await ProfileManager.getKey(ctx.profile));
    const session = {
      delegationHeader: delegation.delegationHeader,
      delegationCid: delegation.cid,
      spaceId: delegation.spaceId,
      jwk,
      verificationMethod: sessionDid,
    };
    // A delegated session never carries named-key authority.
    const { namedKeys: _namedKeys, ...previousFields } = previousProfile;
    const profile = { ...previousFields, sessionDid, spaceId: delegation.spaceId };
    try {
      await ProfileManager.setSession(ctx.profile, session);
      await ProfileManager.setProfile(ctx.profile, profile);
    } catch (error) {
      throw annotate(error, await restoreBeforeBootstrap(ctx.profile, previousProfile));
    }
    return { previousProfile, profile, session };
  });

  const abandon = async (cause: unknown): Promise<never> => {
    // The delegation expired after the check above and a restore of it was
    // refused (this bootstrap's, or the request-bound import's runtime):
    // report the delegation, as that check would have. Rollback is unchanged.
    const reported = cause instanceof CLIError && cause.code === "AUTH_REQUIRED" && signedLifetimePassed(delegation)
      ? delegationExpiredError()
      : cause;
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
      `Rolling back the provisional session of profile "${ctx.profile}" could not run (${failureName(error)}); check \`${CLI_NAME} --profile ${ctx.profile} context\`.`);
    throw annotate(reported, note);
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
  return `Rolling back the provisional session of profile "${profileName}" failed too (${failures.join("; ")}); check \`${CLI_NAME} --profile ${profileName} context\`.`;
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
  options?: {
    privateKey?: string;
    pendingRemoteLogout?: { marker: ProfileReplicaLogoutPending; ownerDid: string; sessionCid: string };
  },
): Promise<TinyCloudNode> {
  // An explicitly-provided private key (--private-key / TC_PRIVATE_KEY) is a
  // first-class headless identity: accept it before any profile/session gate so
  // delegates can authenticate with no persisted profile and no login session.
  if (options?.privateKey) {
    return createSDKInstance(ctx, options);
  }

  const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);
  if (profile?.authSignedOut === true) {
    throw new CLIError("AUTH_REQUIRED",
      `Profile "${ctx.profile}" was explicitly signed out. Run \`${CLI_NAME} --profile ${ctx.profile} auth login\` to establish a new session.`,
      ExitCode.AUTH_REQUIRED);
  }

  // For local auth, we can sign in directly without a stored session. The
  // profile's own key is not an override: createSDKInstance reads it from the
  // profile, so the profile's binding migration may run.
  if (profile?.authMethod === "local" && profile.privateKey) {
    return createSDKInstance(ctx, options);
  }

  const session = await ProfileManager.getSession(ctx.profile);

  if (!session) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `Not authenticated. Run \`${CLI_NAME} auth login\` or \`${CLI_NAME} init\` first.`,
      ExitCode.AUTH_REQUIRED,
    );
  }

  return createSDKInstance(ctx, options);
}
