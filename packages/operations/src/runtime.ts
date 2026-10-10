import type {
  PermissionEntry,
  RuntimeDelegationActivator,
  TinyCloudNode,
} from "@tinycloud/node-sdk";
import * as nodeSdk from "@tinycloud/node-sdk";

import {
  type InvocationTarget,
  type OperationContext,
  type OperationWarning,
  type OperationRuntime,
  type OperationRuntimeRequirement,
  type RuntimeOperationContext,
} from "./contract.js";
import { canonicalizeCapabilities } from "./authority.js";
import { operationError, type OperationError } from "./errors.js";
import { resolveInvocationProfile, resolvePosture } from "./profile.js";
import { operationSpaceResolver } from "./secrets.js";
import {
  profilePath,
  readJson,
  readProfile,
  readSession,
} from "./state.js";
import { replayProfileDelegations } from "./delegation-binding.js";

export type InvocationRuntimeResolution =
  | Readonly<{ ok: true; context: OperationContext }>
  | Readonly<{
    ok: false;
    context: RuntimeOperationContext["summary"];
    error: OperationError;
  }>;

interface StoredSession extends Record<string, unknown> {
  readonly delegationHeader?: unknown;
  readonly delegationCid?: unknown;
  readonly spaceId?: unknown;
  readonly jwk?: unknown;
  readonly verificationMethod?: unknown;
  readonly address?: unknown;
  readonly chainId?: unknown;
  readonly siwe?: unknown;
  readonly signature?: unknown;
  readonly tinycloudHosts?: unknown;
}

/**
 * Creates one authenticated runtime for an invocation. The selected profile
 * name is resolved once and every subsequent read is explicitly scoped to that
 * name; no failure path can choose a different profile.
 */
type AuthenticatedRuntimeResolution =
  | Readonly<{ ok: true; context: RuntimeOperationContext }>
  | Exclude<InvocationRuntimeResolution, Readonly<{ ok: true; context: OperationContext }>>;

export function createInvocationRuntime(
  target: InvocationTarget,
): Promise<AuthenticatedRuntimeResolution>;
export function createInvocationRuntime(
  target: InvocationTarget,
  requirement: "authenticated",
): Promise<AuthenticatedRuntimeResolution>;
export function createInvocationRuntime(
  target: InvocationTarget,
  requirement: "inspection",
): Promise<InvocationRuntimeResolution>;
export function createInvocationRuntime(
  target: InvocationTarget,
  requirement: OperationRuntimeRequirement,
): Promise<InvocationRuntimeResolution>;
export async function createInvocationRuntime(
  target: InvocationTarget,
  requirement: OperationRuntimeRequirement = "authenticated",
): Promise<InvocationRuntimeResolution> {
  const resolved = await resolveInvocationProfile(target);
  if (!resolved.ok) {
    return {
      ok: false,
      context: unresolvedSummary(target),
      error: resolved.error,
    };
  }

  const summary = resolved.context;
  if (requirement === "inspection") {
    return { ok: true, context: { summary } };
  }

  const profileName = summary.profile;
  try {
    // Keep the value import namespace-shaped so projection modules remain
    // compatible with lightweight node-sdk test doubles.
    const {
      TinyCloudNode: TinyCloudNodeConstructor,
    } = nodeSdk;
    const explicitPrivateKeyOverride = typeof target.privateKey === "string";
    const [session, key] = explicitPrivateKeyOverride
      ? [null, null]
      : await Promise.all([
        readSession<StoredSession>(profileName),
        readJson<Record<string, unknown>>(`${profilePath(profileName)}/key.json`),
      ]);
    const profile = resolved.profile;

    // The inspection summary and authenticated material are intentionally
    // separate reads. Fail closed if the profile changed posture between
    // them; otherwise local-owner-key could be authenticated under a stale
    // delegate-session summary and bypass the caller's posture policy.
    const actualPosture = resolvePosture(profile);
    if (!explicitPrivateKeyOverride && actualPosture !== summary.posture) {
      return failed(
        { ...summary, posture: actualPosture },
        operationError(
          "PROFILE_POSTURE_NOT_ALLOWED",
          "The selected profile changed posture during runtime resolution.",
        ),
      );
    }

    const privateKey = typeof target.privateKey === "string"
      ? target.privateKey
      : typeof profile.privateKey === "string"
      ? profile.privateKey
      : undefined;
    const selectedPosture = explicitPrivateKeyOverride || profile.authMethod === "local"
      ? "local-owner-key"
      : summary.posture;
    if (selectedPosture !== summary.posture && !explicitPrivateKeyOverride) {
      return failed(
        { ...summary, posture: selectedPosture },
        operationError(
          "PROFILE_POSTURE_NOT_ALLOWED",
          "The selected profile authentication material does not match its posture.",
        ),
      );
    }
    const node = new TinyCloudNodeConstructor({
      host: summary.host,
      ...(privateKey === undefined ? {} : { privateKey }),
    });

    const activeSession = session === null ? undefined : normalizeSession(session, key);
    if (explicitPrivateKeyOverride) {
      // An explicit key is a complete, non-persisted identity. Do not inherit
      // an OpenKey session (or require one) from the selected profile.
      await node.signIn();
    } else if (activeSession === undefined) {
      if (profile.authMethod === "local" && privateKey !== undefined) {
        await node.signIn();
      } else {
        return failed(summary, operationError(
          "SESSION_NOT_FOUND",
          "The selected profile does not have an active session.",
        ));
      }
    } else {
      try {
        await node.restoreSession(activeSession);
      } catch (error) {
        // node-sdk refuses expired or otherwise unusable persisted authority
        // (`AUTH_EXPIRED`) while verifying it locally, before any node request.
        // Only a new sign-in fixes that: the same non-retryable `AUTH_REQUIRED`
        // a node's 401 for a stale session produces.
        if (isRecord(error) && error.code === "AUTH_EXPIRED") {
          return failed(summary, operationError(
            "AUTH_REQUIRED",
            "The stored session has expired or is no longer valid. Sign in again.",
            { retryable: false },
          ));
        }
        throw error;
      }
    }

    // The restored node is the authority for the active session identity. In
    // particular, do not report the persisted verification method if SDK
    // restoration failed to install its key as the live session key.
    const activeSessionDid = normalizeDid(node.sessionDid);
    const livePrincipalDid = normalizeDid(node.did);
    const authenticatedSpace = explicitPrivateKeyOverride
      ? spaceForAuthenticatedPrincipal(livePrincipalDid)
      : undefined;
    // This API derives from the restored, verified base session rather than
    // from an SDK private field or a second parse of signed authority here.
    const livePermissions: PermissionEntry[] = [...node.getVerifiedSessionCapabilities()];
    const resolveSpace = operationSpaceResolver(node, authenticatedSpace ?? summary.space);
    const warnings: OperationWarning[] = [];
    // A local sign-in without a persisted session has a fresh session key.
    // Neither that key nor an explicit private-key override may inherit this
    // profile's stored grants.
    if (!explicitPrivateKeyOverride && activeSession !== undefined) {
      const replay = await replayProfileDelegations(
        profileName,
        node as unknown as RuntimeDelegationActivator,
        { host: summary.host, migrate: true, resolveSpace },
      );
      for (const installed of replay.installed) {
        livePermissions.push(...installed.effectivePermissions);
      }
      warnings.push(...replay.warnings);
    }

    const runtime: OperationRuntime = {
      node,
      granted: canonicalizeCapabilities(livePermissions),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
    return {
      ok: true,
      context: {
        summary: {
          ...summary,
          posture: selectedPosture,
          ...(livePrincipalDid === undefined ? {} : { principalDid: livePrincipalDid }),
          ...(explicitPrivateKeyOverride && livePrincipalDid !== undefined
            ? { ownerDid: livePrincipalDid }
            : {}),
          ...(authenticatedSpace === undefined ? {} : { space: authenticatedSpace }),
          ...(activeSessionDid === undefined ? {} : { sessionDid: activeSessionDid }),
        },
        runtime,
      },
    };
  } catch {
    return failed(summary, operationError(
      "NODE_ERROR",
      "The selected profile runtime could not be initialized.",
      { retryable: true },
    ));
  }
}

function spaceForAuthenticatedPrincipal(principal: string | undefined): string | undefined {
  if (principal === undefined) return undefined;
  try {
    const pkh = nodeSdk.parsePkhDid(principal);
    return pkh === null ? undefined : nodeSdk.makePkhSpaceId(pkh.address, pkh.chainId, "secrets");
  } catch {
    return undefined;
  }
}

function normalizeSession(
  session: StoredSession,
  key: Record<string, unknown> | null,
): Parameters<TinyCloudNode["restoreSession"]>[0] | undefined {
  const header = session.delegationHeader;
  const jwk = hasPrivateParameter(session.jwk) ? session.jwk : key;
  if (
    !isRecord(header) ||
    typeof header.Authorization !== "string" ||
    typeof session.delegationCid !== "string" ||
    typeof session.spaceId !== "string" ||
    !hasPrivateParameter(jwk) ||
    typeof session.verificationMethod !== "string"
  ) {
    return undefined;
  }

  return {
    delegationHeader: { Authorization: header.Authorization },
    delegationCid: session.delegationCid,
    spaceId: session.spaceId,
    jwk,
    verificationMethod: session.verificationMethod,
    ...(typeof session.address === "string" ? { address: session.address } : {}),
    ...(typeof session.chainId === "number" ? { chainId: session.chainId } : {}),
    ...(typeof session.siwe === "string" ? { siwe: session.siwe } : {}),
    ...(typeof session.signature === "string" ? { signature: session.signature } : {}),
    ...(Array.isArray(session.tinycloudHosts) && session.tinycloudHosts.every((host) => typeof host === "string")
      ? { tinycloudHosts: session.tinycloudHosts }
      : {}),
  };
}

function hasPrivateParameter(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.d === "string" && value.d.length > 0;
}

function normalizeDid(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split("#", 1)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(
  context: RuntimeOperationContext["summary"],
  error: OperationError,
): InvocationRuntimeResolution {
  return { ok: false, context, error };
}

function unresolvedSummary(target: InvocationTarget): RuntimeOperationContext["summary"] {
  return {
    profile: target.profile ?? "unresolved",
    host: target.host ?? "unresolved",
    posture: "unauthenticated",
  };
}
