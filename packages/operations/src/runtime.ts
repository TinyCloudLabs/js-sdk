import type {
  PermissionEntry,
  PortableDelegation,
  RuntimeDelegationActivator,
  TinyCloudNode,
} from "@tinycloud/node-sdk";
import * as nodeSdk from "@tinycloud/node-sdk";

import type {
  InvocationTarget,
  OperationContext,
  OperationRuntime,
  OperationRuntimeRequirement,
  RuntimeOperationContext,
} from "./contract.js";
import { canonicalizeCapabilities } from "./authority.js";
import { operationError, type OperationError } from "./errors.js";
import { resolveInvocationProfile, resolvePosture } from "./profile.js";
import {
  profilePath,
  readAdditionalDelegations,
  readJson,
  readProfile,
  readSession,
} from "./state.js";

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

interface StoredAdditionalDelegation extends Record<string, unknown> {
  readonly delegation?: unknown;
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
      activateValidatedRuntimeDelegation,
      TinyCloudNode: TinyCloudNodeConstructor,
    } = nodeSdk;
    const explicitPrivateKeyOverride = typeof target.privateKey === "string";
    const [session, key, additionalDelegations] = explicitPrivateKeyOverride
      ? [null, null, [] as StoredAdditionalDelegation[]]
      : await Promise.all([
        readSession<StoredSession>(profileName),
        readJson<Record<string, unknown>>(`${profilePath(profileName)}/key.json`),
        readAdditionalDelegations<StoredAdditionalDelegation>(profileName),
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
      await node.restoreSession(activeSession);
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
    const seenCids = new Set<string>();
    for (const entry of additionalDelegations) {
      const delegation = normalizeStoredDelegation(entry);
      if (delegation === undefined || delegation.expiry.getTime() <= Date.now()) continue;
      try {
        const activated = await activateValidatedRuntimeDelegation(node as unknown as RuntimeDelegationActivator, delegation, {
          host: summary.host,
        });
        if (!seenCids.has(activated.cid)) {
          seenCids.add(activated.cid);
          livePermissions.push(...activated.effectivePermissions);
        }
      } catch {
        // Stored data is untrusted transport material. Replaying an invalid,
        // stale, wrong-session, or rejected record must not grant it authority
        // or reveal its contents through a safe operation channel.
      }
    }

    const runtime: OperationRuntime = {
      node,
      granted: canonicalizeCapabilities(livePermissions),
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

function normalizeStoredDelegation(
  entry: StoredAdditionalDelegation,
): PortableDelegation | undefined {
  const raw = entry.delegation;
  if (!isRecord(raw) || !isRecord(raw.delegationHeader)) return undefined;
  const expiry = parseExpiry(raw.expiry);
  if (
    expiry === undefined ||
    typeof raw.cid !== "string" ||
    typeof raw.spaceId !== "string" ||
    typeof raw.path !== "string" ||
    !Array.isArray(raw.actions) || !raw.actions.every((action) => typeof action === "string") ||
    typeof raw.delegateDID !== "string" ||
    typeof raw.ownerAddress !== "string" ||
    typeof raw.chainId !== "number" ||
    typeof raw.delegationHeader.Authorization !== "string"
  ) {
    return undefined;
  }
  return { ...raw, expiry } as PortableDelegation;
}

function parseExpiry(value: unknown): Date | undefined {
  const expiry = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return expiry !== undefined && !Number.isNaN(expiry.getTime()) ? expiry : undefined;
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
