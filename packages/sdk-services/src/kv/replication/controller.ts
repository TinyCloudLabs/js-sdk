import { wrapError } from "../../errors";
import { ErrorCodes, err, ok, serviceError, type Result } from "../../types";
import type { KVGetOptions, KVListOptions, KVResponse } from "../types";
import { kvPrefixCovers, listRangeCovers, requiresSecretsOptIn } from "./scope";
import { classifyWriteOutcome } from "./outcome";
import { afterSync, begin, clearPending as clearPendingRecords, clearPrefix, emptyPendingState, pinnedKeys, settle } from "./pendingWrites";
import { localGet, type LocalGetResponse } from "./localResponse";
import { cursorRestart, decodeTcr1, listPathCovered, localList } from "./listLocal";
import { emitEvent, type ReplicationEventInput } from "./events";
import type { KVListPage, KVReplicaHandle, KVReplicationController, LocalGetResult, LocalReadMeta, LocalReplicaStatus, ReplicaInspectedStatus, ReplicaGrantInfo, PendingWriteState, ReplicaDevice, ReplicaPeerCommit, ReplicationEvent, ReplicationReason, ReplicaStatusEntry, KVReplicationDeps, LocalSyncResult } from "./types";
import type { ReplicaDeliveryDecision, ReplicaSessionStamp } from "./lifecycle";
import { DEFAULT_GRANT_TTL_MS, RENEW_BELOW_FRACTION } from "./grantPolicyConstants";
import { clampConsentAnchor, consentDeadlineMs, mintRemainingMs, needsSilentRenewal } from "./grantPolicy";
import type { ReplicaConsentAnchor } from "./grantPolicyTypes";

const CLOSE_TIMEOUT_MS = 3_000;
const STATUS_REFRESH_TIMEOUT_MS = CLOSE_TIMEOUT_MS;
type SyncAbortCause = "timeout" | "caller" | "close" | "purge";
interface SyncContext { abortCause?: SyncAbortCause }
interface StatusInspection { abort: AbortController; settled: Promise<void> }
interface InspectedStatusResult { missing: boolean; local?: LocalReplicaStatus | ReplicaInspectedStatus; errorCode?: string }
interface ReplicaDerivationPlan { path: "session" | "runtime"; parentCid: string; expiresAt: number }
interface Opened {
  handle?: KVReplicaHandle;
  opening?: Promise<KVReplicaHandle>;
  sync?: Promise<LocalSyncResult>;
  syncContext?: SyncContext;
  abort?: AbortController;
  mintAbort?: AbortController;
  timer?: () => void;
  renewalTimer?: () => void;
  renewing?: Promise<void>;
  lastError?: string;
  reason?: ReplicationReason;
  strategy?: "session" | "minted" | "installed";
  retryAt?: number;
  failures?: number;
  unsupported?: boolean;
  authorityRevoked?: boolean;
  reportedExpired?: boolean;
  reportedCappedCid?: string;
  reportedRenewalUnqualifiedCid?: string;
}
const nowDate = (now: number) => new Date(now).toISOString();
const errorCode = (e: unknown): string => typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : "REPLICA_UNAVAILABLE";
function raceSignal<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error("KV request was aborted"), { code: ErrorCodes.ABORTED }));
  let remove = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason ?? Object.assign(new Error("KV request was aborted"), { code: ErrorCodes.ABORTED }));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([job, aborted]).finally(remove);
}

export function createKVReplication(deps: KVReplicationDeps): KVReplicationController {
  const { options, mode, storage, identity, session, authority, pending, scheduler } = deps;
  const emit = (event: ReplicationEventInput): void => emitEvent(deps.emit, scheduler, event);
  const replicas = new Map<string, Opened>();
  const statusInspections = new Set<StatusInspection>();
  let isClosed = false;
  let purgeStarted = false;
  let purgeInProgress = false;
  let previous = deps.previous;
  let pinnedStateReported = false;
  const inProcessProof = new Set<string>();
  let anchorUnavailable = false;
  let consentAnchor: ReplicaConsentAnchor | null = null;
  try {
    consentAnchor = clampConsentAnchor(authority.consentAnchor?.() ?? null, scheduler.now());
    if (consentAnchor?.source === "first_install") consentAnchor = null;
  } catch {
    anchorUnavailable = true;
  }
  const grantPolicy = { grantTtlMs: options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS, consentAnchor };
  const quota = options.maxBytes === undefined && options.minFreeBytes === undefined
    ? undefined : { maxBytes: options.maxBytes, minFreeBytes: options.minFreeBytes };
  const policyDeadline = consentAnchor === null ? null : consentDeadlineMs(consentAnchor);
  let scheduledConsentDeadline: number | null = null;
  let cancelConsentTimer: (() => void) | undefined;
  function durableDeadline(): number | null {
    if (storage.kind !== "indexeddb" || !deps.stamp) return null;
    try {
      const deadline = storage.lifecycle?.consentDeadline(deps.stamp);
      return typeof deadline === "number" && Number.isFinite(deadline) ? deadline : null;
    } catch {
      return null;
    }
  }
  function mintDeadline(): number | null {
    if (policyDeadline === null) return null;
    if (storage.kind !== "indexeddb") return policyDeadline;
    const durable = durableDeadline();
    return durable === null ? null : Math.min(policyDeadline, durable);
  }
  function scheduleConsentDeadline(): void {
    const deadline = durableDeadline();
    if (deadline === null || consentDenyStarted || isClosed) return;
    const now = scheduler.now();
    if (!Number.isFinite(now)) return;
    if (scheduledConsentDeadline === deadline && cancelConsentTimer) return;
    scheduledConsentDeadline = deadline;
    cancelConsentTimer?.();
    cancelConsentTimer = scheduler.setTimeout(() => {
      cancelConsentTimer = undefined;
      checkDelivery();
    }, Math.max(0, deadline - now));
  }
  const reportedDeadline = new Set<string>();
  let consentDenyStarted = false;
  function checkDelivery(): ReplicaDeliveryDecision {
    const gate = storage.lifecycle;
    if (!gate) return storage.kind === "indexeddb" || anchorUnavailable || deps.stamp !== undefined
      ? { status: "gated", gate: "gate_unavailable" }
      : { status: "allow" };
    if (!deps.stamp) return { status: "gated", gate: "not_established" };
    if (consentDenyStarted) return { status: "gated", gate: "stamp_stale" };
    try {
      const decision = gate.checkDelivery(deps.stamp);
      if (decision.status === "consent_expired") startConsentDenial();
      if (decision.status !== "allow") return decision;
      if (storage.kind === "indexeddb") {
        const deadline = durableDeadline();
        if (deadline === null) return { status: "gated", gate: "gate_unavailable" };
        const now = scheduler.now();
        if (!Number.isFinite(now)) return { status: "gated", gate: "gate_unavailable" };
        if (now >= deadline) {
          startConsentDenial();
          return { status: "consent_expired", code: "CONSENT_EXPIRED" };
        }
      }
      return anchorUnavailable ? { status: "gated", gate: "gate_unavailable" } : decision;
    } catch {
      return { status: "gated", gate: "gate_unavailable" };
    }
  }
  function markConsentExpired(): boolean {
    if (consentDenyStarted || isClosed || purgeStarted) return false;
    cancelConsentTimer?.();
    cancelConsentTimer = undefined;
    consentDenyStarted = true;
    for (const state of replicas.values()) {
      state.renewalTimer?.();
      state.renewalTimer = undefined;
      state.mintAbort?.abort();
      const id = state.handle?.replicaId;
      if (id && !reportedDeadline.has(id)) {
        reportedDeadline.add(id);
        emit({ type: "replication.grant", replicaId: id, action: "consent_deadline_reached", code: "CONSENT_EXPIRED" });
      }
    }
    return true;
  }
  function observeConsentExpired(stamp: ReplicaSessionStamp): void {
    if (!deps.stamp || stamp.incarnation !== deps.stamp.incarnation || stamp.lifecycleEpoch !== deps.stamp.lifecycleEpoch) return;
    if (markConsentExpired()) emit({ type: "replication.lifecycle", action: "denied", reason: "consent_expired" });
  }
  function startConsentDenial(): void {
    const gate = storage.lifecycle;
    if (!gate || !markConsentExpired()) return;
    void gate.deny({ reason: "consent_expired", principal: identity.principal }).then(
      (outcome) => emit({ type: "replication.lifecycle", action: outcome.status === "denied" ? "denied" : outcome.status === "stale" ? "deny_stale" : outcome.status === "deleted" ? "database_deleted" : outcome.status === "marker" ? "marker_set" : "unguarded", reason: "consent_expired" }),
      () => emit({ type: "replication.lifecycle", action: "deny_failed", reason: "consent_expired" }),
    );
  }
  function deliveryError(decision: Exclude<ReplicaDeliveryDecision, { status: "allow" }>): Error {
    return Object.assign(new Error(decision.status === "consent_expired" ? "Replica consent expired" : "Replica session is gated"), {
      code: decision.status === "consent_expired" ? decision.code : "REPLICA_GATED",
      ...(decision.status === "gated" ? { gate: decision.gate } : {}),
    });
  }
  function deliveryReason(code: string): ReplicationReason {
    return code === "CONSENT_EXPIRED" || code === "GRANT_EXPIRED" ? "grant_expired" : code === "REPLICA_GATED" ? "replica_gated" : "replica_error";
  }
  function reportGrantExpiry(prefix: string): void {
    const state = replicas.get(prefix);
    if (!state) return;
    state.reason = "grant_expired";
    state.lastError = "GRANT_EXPIRED";
    const replicaId = state.handle?.replicaId;
    if (!replicaId || state.reportedExpired) return;
    state.reportedExpired = true;
    emit({ type: "replication.grant", replicaId, action: "expired", code: "GRANT_EXPIRED" });
  }
  function reportGrantCap(state: Opened, handle: KVReplicaHandle, grant: ReplicaGrantInfo | null | undefined): void {
    if (
      !grant?.unconstrained || !handle.replicaId ||
      typeof grant.effectiveExpiresAt !== "number" || !Number.isFinite(grant.effectiveExpiresAt) ||
      !(grant.expiresAt === null || grant.effectiveExpiresAt < grant.expiresAt)
    ) return;
    const capKey = `${grant.cid}:${grant.effectiveExpiresAt}`;
    if (state.reportedCappedCid === capKey) return;
    state.reportedCappedCid = capKey;
    emit({ type: "replication.grant", replicaId: handle.replicaId, action: "capped", effectiveExpiresAt: nowDate(grant.effectiveExpiresAt) });
  }
  const configuredPrefix = (path: string) => options.prefixes.find((prefix) => kvPrefixCovers(prefix, path));
  function recordRevocation(prefix: string, error: unknown): void {
    if (errorCode(error) !== "GRANT_REVOKED") return;
    const state = replicas.get(prefix) ?? {};
    state.authorityRevoked = true;
    state.reason = "grant_revoked";
    state.lastError = "GRANT_REVOKED";
    replicas.set(prefix, state);
  }
  function markRootUnsupported(prefix: string): void {
    const state = replicas.get(prefix) ?? {};
    const firstRefusal = state.lastError !== "REPLICATION_ROOT_UNSUPPORTED";
    state.reason = "replica_unavailable";
    state.lastError = "REPLICATION_ROOT_UNSUPPORTED";
    replicas.set(prefix, state);
    if (firstRefusal) {
      emit({ type: "replication.state", space: session.space, replica: prefix, state: "unavailable", code: "REPLICATION_ROOT_UNSUPPORTED" });
    }
  }
  function unsupportedRoot(prefix: string): Error {
    markRootUnsupported(prefix);
    return Object.assign(new Error("This node doesn't support whole-space sync yet."), { code: "REPLICATION_ROOT_UNSUPPORTED" });
  }


  function canReuseInstalled(grant: ReplicaGrantInfo | null | undefined, sessionOnly: boolean): boolean {
    if (!grant?.unconstrained) return false;
    if (!deps.stamp) return true;
    if (!sessionOnly && consentAnchor === null) return false;
    const now = scheduler.now();
    const deadline = storage.kind === "indexeddb" ? durableDeadline() : policyDeadline ?? grant.consentDeadline;
    return grant.state === "active" &&
      typeof grant.installedAt === "number" && Number.isFinite(grant.installedAt) &&
      typeof grant.effectiveExpiresAt === "number" && Number.isFinite(grant.effectiveExpiresAt) &&
      typeof grant.consentDeadline === "number" && Number.isFinite(grant.consentDeadline) &&
      typeof deadline === "number" && Number.isFinite(deadline) &&
      Number.isFinite(now) && now >= grant.installedAt &&
      (grant.expiresAt === null || typeof grant.expiresAt === "number" && Number.isFinite(grant.expiresAt) && now < grant.expiresAt) &&
      now < Math.min(grant.effectiveExpiresAt, grant.consentDeadline, deadline);
  }
  function sessionRefusal(prefix: string): string | undefined {
    try {
      if (authority.sessionOnly !== true) return undefined;
      // A signed get+sync grant for the configured prefix covers its contained get key/list path.
      const grant = authority.sessionGrant(prefix);
      return "refused" in grant ? grant.refused : undefined;
    } catch {
      return "NOT_COVERED";
    }
  }


  async function open(prefix: string): Promise<KVReplicaHandle> {
    const delivery = checkDelivery();
    if (delivery.status !== "allow") throw deliveryError(delivery);
    if (isClosed || purgeStarted) throw Object.assign(new Error("Replication controller is closed"), { code: "REPLICA_CLOSED" });
    let state = replicas.get(prefix);
    if (state?.handle) return state.handle;
    if (state?.opening) return state.opening;
    state ??= {};
    replicas.set(prefix, state);
    if (state.unsupported) throw Object.assign(new Error("Replication runtime is unsupported"), { code: "RUNTIME_UNSUPPORTED" });
    if (state.retryAt !== undefined && scheduler.now() < state.retryAt) throw Object.assign(new Error("Replica open is backing off"), { code: state.lastError ?? "REPLICA_UNAVAILABLE" });
    if (requiresSecretsOptIn(session.space, prefix) && !options.allowSecrets) {
      const firstRefusal = state.lastError !== "SECRETS_OPT_IN_REQUIRED";
      state.reason = "replica_unavailable";
      state.lastError = "SECRETS_OPT_IN_REQUIRED";
      if (firstRefusal) emit({ type: "replication.state", space: session.space, replica: prefix, state: "unavailable", code: "SECRETS_OPT_IN_REQUIRED" });
      throw Object.assign(new Error("Replication requires allowSecrets for this space or prefix"), { code: "SECRETS_OPT_IN_REQUIRED" });
    }
    state.opening = (async () => {
      if (previous) { await previous; previous = undefined; }
      const delivery = checkDelivery();
      if (delivery.status !== "allow") throw deliveryError(delivery);
      const sessionOnly = authority.sessionOnly === true;
      const sessionGrant = authority.sessionGrant(prefix);
      const delegated = "refused" in sessionGrant ? undefined : sessionGrant;
      const plan = sessionOnly ? undefined : authority.plan(prefix);
      let refusalCode: string | undefined;
      if ("refused" in sessionGrant) refusalCode = sessionGrant.refused;
      if (plan && "refused" in plan) refusalCode ??= plan.refused;
      if (deps.stamp && consentAnchor === null && !sessionOnly) refusalCode = "REPLICA_GATED";
      let device: ReplicaDevice | undefined;
      if (delegated) { device = delegated.device; state!.strategy = "session"; }
      const spec = {
        identity, space: session.space, prefix, allowSecrets: options.allowSecrets, grantPolicy,
        ...(quota ? { quota } : {}),
        ...(options.contentFetch ? { contentFetch: options.contentFetch } : {}),
        ...(deps.stamp ? { stamp: deps.stamp } : {}),
        ...(device ? { device } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        onPeerCommit: (info: ReplicaPeerCommit) => {
          if (isClosed || purgeStarted || state!.handle === undefined) return;
          emit({
            type: "replication.sync", space: session.space, replica: prefix,
            trigger: "peer", origin: "peer", outcome: "ok", durationMs: 0, lagMs: null,
            ...(info.changes === undefined ? {} : { changes: info.changes }),
            ...(info.coverage === undefined ? {} : { coverage: info.coverage }),
          });
        },
      };
      if (prefix === "/" && deps.nodeFeatures !== undefined && !deps.nodeFeatures.includes("kv-sync-root")) {
        throw unsupportedRoot(prefix);
      }
      const handle = await storage.open(spec);
      state!.handle = handle;
      const afterOpen = checkDelivery();
      if (afterOpen.status !== "allow") throw deliveryError(afterOpen);
      emit({ type: "replication.state", space: session.space, replica: prefix, state: "opened" });
      const runtimePlan = !sessionOnly && plan && !("refused" in plan) ? plan : undefined;
      let installed = runtimePlan || delegated ? await handle.grant() : undefined;
      if (installed && !canReuseInstalled(installed, sessionOnly)) {
        if (installed.unconstrained) refusalCode = consentAnchor === null && !sessionOnly ? "REPLICA_GATED" : "GRANT_EXPIRED";
        installed = undefined;
      }
      let mintedExpiryMs: number | undefined;
      if (delegated && consentAnchor !== null) {
        const beforeInstall = checkDelivery();
        if (beforeInstall.status !== "allow") throw deliveryError(beforeInstall);
        installed = await handle.installGrant(delegated.ucan);
      } else if (runtimePlan) {
        if (!installed || !installed.unconstrained || installed.parentCid !== runtimePlan.parentCid || (installed.expiresAt !== null && runtimePlan.expiresAt > installed.expiresAt + 300_000)) {
          const deadline = mintDeadline();
          const expiryMs = mintRemainingMs({ now: scheduler.now(), grantTtlMs: grantPolicy.grantTtlMs, consentDeadline: deadline ?? Number.NaN });
          if (expiryMs > 0) {
            try {
              const mintAbort = new AbortController();
              state!.mintAbort = mintAbort;
              const minted = await authority.mint(handle.deviceDid, prefix, mintAbort.signal, { expiryMs });
              const beforeInstall = checkDelivery();
              if (beforeInstall.status !== "allow") throw deliveryError(beforeInstall);
              installed = await handle.installGrant(minted.ucan);
              state!.strategy = "minted";
              mintedExpiryMs = expiryMs;
            } catch (error) {
              if (errorCode(error) === "CONSENT_EXPIRED" || errorCode(error) === "REPLICA_GATED" || !installed?.unconstrained) throw error;
            } finally { state!.mintAbort = undefined; }
          }
        }
        if (installed?.unconstrained) { state!.strategy ??= "installed"; state!.reason = undefined; }
      } else if ((delegated || sessionOnly) && installed?.unconstrained) {
        state!.strategy = "installed";
      }
      const beforeGrantEvent = checkDelivery();
      if (beforeGrantEvent.status !== "allow") throw deliveryError(beforeGrantEvent);
      reportGrantCap(state!, handle, installed);
      if (mintedExpiryMs !== undefined) state!.reportedExpired = false;
      if (mintedExpiryMs !== undefined && handle.replicaId) emit({ type: "replication.grant", replicaId: handle.replicaId, action: "minted", expiryMs: mintedExpiryMs });
      if (!installed?.unconstrained) {
        state!.reason = "grant_missing";
        state!.lastError = refusalCode ?? "SESSION_LACKS_SYNC";
        emit({ type: "replication.state", space: session.space, replica: prefix, state: "grant_missing", code: state!.lastError });
      } else emit({ type: "replication.state", space: session.space, replica: prefix, state: "grant_installed", strategy: state!.strategy });
      if (isClosed || purgeStarted) {
        await handle.close();
        throw Object.assign(new Error("Replication controller is closed"), { code: "REPLICA_CLOSED" });
      }
      if (installed?.unconstrained) await maybeRenew(prefix, handle, installed, runtimePlan);
      if (mode === "background" && state!.reason !== "grant_missing") {
        void syncPrefix(prefix, "start").catch(() => undefined);
        schedule(prefix);
      }
      return handle;
    })();
    try { return await state.opening; } catch (error) {
      const code = errorCode(error);
      if (code === "CONSENT_EXPIRED") startConsentDenial();
      recordRevocation(prefix, error);
      if (code === "REPLICA_GATED" || code === "CONSENT_EXPIRED") state.reason = deliveryReason(code);
      else if (code !== "GRANT_REVOKED") state.reason = "replica_unavailable";
      state.lastError = code;
      state.failures = (state.failures ?? 0) + 1;
      if (code === "RUNTIME_UNSUPPORTED") state.unsupported = true;
      else if (code !== "REPLICA_CLOSED" && code !== "REPLICATION_ROOT_UNSUPPORTED" && code !== "REPLICA_GATED" && code !== "CONSENT_EXPIRED") state.retryAt = scheduler.now() + Math.min(300_000, 5_000 * 2 ** Math.min(state.failures - 1, 6));
      state.handle?.close().catch(() => undefined);
      state.handle = undefined;
      throw error;
    } finally { state.opening = undefined; }
  }

  function scheduleRenewal(prefix: string, handle: KVReplicaHandle, grant: ReplicaGrantInfo, plan: ReplicaDerivationPlan): void {
    const state = replicas.get(prefix);
    state?.renewalTimer?.();
    if (state) state.renewalTimer = undefined;
    if (!state || isClosed || purgeStarted || plan.path !== "session" || !authority.canRenew) return;
    const { installedAt, effectiveExpiresAt } = grant;
    const deadline = mintDeadline();
    if (
      typeof installedAt !== "number" || !Number.isFinite(installedAt) ||
      typeof effectiveExpiresAt !== "number" || !Number.isFinite(effectiveExpiresAt) ||
      !(effectiveExpiresAt > installedAt) || deadline === null
    ) return;
    const threshold = installedAt + (effectiveExpiresAt - installedAt) * (1 - RENEW_BELOW_FRACTION);
    const now = scheduler.now();
    if (!Number.isFinite(now) || !(threshold < deadline) || now > threshold) return;
    state.renewalTimer = scheduler.setTimeout(() => {
      state.renewalTimer = undefined;
      void maybeRenew(prefix, handle).catch(() => undefined);
    }, Math.max(0, Math.floor(threshold) + 1 - now));
  }

  async function maybeRenew(prefix: string, handle: KVReplicaHandle, knownGrant?: ReplicaGrantInfo, knownPlan?: ReplicaDerivationPlan): Promise<void> {
    const state = replicas.get(prefix);
    if (!state || state.handle !== handle || isClosed || purgeStarted || !authority.canRenew) return;
    if (state.renewing) return state.renewing;
    const decision = checkDelivery();
    if (decision.status !== "allow") return;
    const grant = knownGrant ?? await handle.grant();
    if (!grant?.unconstrained) return;
    const { installedAt, effectiveExpiresAt } = grant;
    const deadline = mintDeadline();
    if (
      typeof installedAt !== "number" || !Number.isFinite(installedAt) ||
      typeof effectiveExpiresAt !== "number" || !Number.isFinite(effectiveExpiresAt) ||
      deadline === null
    ) return;
    const now = scheduler.now();
    if (!needsSilentRenewal({ now, installedAt, effectiveExpiresAt, consentDeadline: deadline })) {
      if (knownPlan) scheduleRenewal(prefix, handle, grant, knownPlan);
      return;
    }
    let plan: ReplicaDerivationPlan | undefined = knownPlan;
    try {
      if (!plan) {
        const selected = authority.plan(prefix);
        if ("refused" in selected) {
          if (handle.replicaId) emit({ type: "replication.grant", replicaId: handle.replicaId, action: "renewal_refused", code: selected.refused });
          return;
        }
        plan = selected;
      }
    } catch {
      if (handle.replicaId) emit({ type: "replication.grant", replicaId: handle.replicaId, action: "renewal_deferred" });
      return;
    }
    if (plan?.path !== "session") {
      if (handle.replicaId && state.reportedRenewalUnqualifiedCid !== grant.cid) {
        state.reportedRenewalUnqualifiedCid = grant.cid;
        emit({ type: "replication.grant", replicaId: handle.replicaId, action: "renewal_deferred" });
      }
      return;
    }
    const expiryMs = mintRemainingMs({ now, grantTtlMs: grantPolicy.grantTtlMs, consentDeadline: deadline });
    if (!(expiryMs > 0)) return;
    state.renewalTimer?.();
    state.renewalTimer = undefined;
    const mintAbort = new AbortController();
    state.mintAbort = mintAbort;
    const job = Promise.resolve().then(async () => {
      const minted = await authority.mint(handle.deviceDid, prefix, mintAbort.signal, { expiryMs, renewalOnly: true });
      const beforeInstall = checkDelivery();
      if (beforeInstall.status !== "allow") throw deliveryError(beforeInstall);
      const installed = await handle.installGrant(minted.ucan);
      const beforeEvent = checkDelivery();
      if (beforeEvent.status !== "allow") throw deliveryError(beforeEvent);
      reportGrantCap(state, handle, installed);
      state.reportedExpired = false;
      if (state.reason === "grant_expired") state.reason = undefined;
      if (state.lastError === "GRANT_EXPIRED") state.lastError = undefined;
      if (handle.replicaId) emit({ type: "replication.grant", replicaId: handle.replicaId, action: "renewed", expiryMs });
      if (typeof installed.effectiveExpiresAt === "number" && installed.effectiveExpiresAt > effectiveExpiresAt) {
        scheduleRenewal(prefix, handle, installed, plan);
      }
    });
    state.renewing = job;
    try {
      await job;
    } catch (error) {
      const code = errorCode(error);
      if (code === "CONSENT_EXPIRED" || code === "REPLICA_GATED") throw error;
      if (!isClosed && handle.replicaId) {
        const refused = typeof error === "object" && error !== null && "refused" in error && typeof error.refused === "string" ? error.refused : null;
        emit({ type: "replication.grant", replicaId: handle.replicaId, action: refused ? "renewal_refused" : "renewal_deferred", code: refused ?? code });
      }
    } finally {
      state.renewing = undefined;
      if (state.mintAbort === mintAbort) state.mintAbort = undefined;
    }
  }

  function schedule(prefix: string): void {
    const state = replicas.get(prefix);
    if (!state || mode !== "background" || isClosed || purgeStarted) return;
    state.timer = scheduler.setTimeout(() => {
      state.timer = undefined;
      void syncPrefix(prefix, "interval").catch(() => undefined).finally(() => schedule(prefix));
    }, options.syncIntervalMs);
  }

  async function syncPrefix(prefix: string, trigger: "start" | "interval" | "stale_read" | "manual", signal?: AbortSignal, context?: SyncContext): Promise<LocalSyncResult> {
    if (prefix === "/" && deps.nodeFeatures !== undefined && !deps.nodeFeatures.includes("kv-sync-root")) {
      throw unsupportedRoot(prefix);
    }
    const initialRefusal = sessionRefusal(prefix);
    if (initialRefusal) throw Object.assign(new Error("Current session does not cover replica sync"), { code: initialRefusal });
    const handle = await open(prefix);
    const state = replicas.get(prefix)!;
    if (state.sync) return state.sync;
    const abort = new AbortController();
    const syncContext = context ?? {};
    state.syncContext = syncContext;
    state.abort = abort;
    const abortFromCaller = () => {
      syncContext.abortCause ??= "caller";
      abort.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const started = scheduler.now();
    let job!: Promise<LocalSyncResult>;
    job = (async () => {
      try {
        const syncStartEpoch = (await pending.read()).committedEpoch;
        const beforeSync = checkDelivery();
        if (beforeSync.status !== "allow") throw deliveryError(beforeSync);
        await maybeRenew(prefix, handle);
        const afterRenewal = checkDelivery();
        if (afterRenewal.status !== "allow") throw deliveryError(afterRenewal);
        const refusal = sessionRefusal(prefix);
        if (refusal) throw Object.assign(new Error("Current session does not cover replica sync"), { code: refusal });
        const result = await handle.sync({ signal: abort.signal, syncStartEpoch });
        const afterSyncDelivery = checkDelivery();
        if (afterSyncDelivery.status !== "allow") throw deliveryError(afterSyncDelivery);
        if (result.status === "busy") {
          emit({ type: "replication.sync", space: session.space, replica: prefix, trigger, outcome: "busy", durationMs: scheduler.now() - started, lagMs: null });
          return result;
        }
        inProcessProof.add(prefix);
        const snapshot = await pending.read();
        const beforePending = checkDelivery();
        if (beforePending.status !== "allow") throw deliveryError(beforePending);
        const clearedCandidates = snapshot.records.some((r) => r.state === "committed" && r.epoch !== null && r.epoch <= syncStartEpoch && kvPrefixCovers(prefix, r.key));
        const cleared = clearedCandidates ? await pending.update((s) => afterSync(s, prefix, syncStartEpoch)) : 0;
        const beforeResult = checkDelivery();
        if (beforeResult.status !== "allow") throw deliveryError(beforeResult);
        emit({ type: "replication.sync", space: session.space, replica: prefix, trigger, outcome: "ok", durationMs: scheduler.now() - started, lagMs: null, pendingCleared: cleared, pages: result.pages, changes: result.changes, deleted: result.deleted, fetched: result.fetched, contentMissing: result.contentMissing, coverage: result.coverage });
        return result;
      } catch (error) {
        const code = errorCode(error); state.lastError = code; recordRevocation(prefix, error);
        if (code === "CONSENT_EXPIRED") startConsentDenial();
        emit({ type: "replication.sync", space: session.space, replica: prefix, trigger, outcome: abort.signal.aborted ? "aborted" : "error", class: code === "CONSENT_EXPIRED" || code === "REPLICA_GATED" ? "lifecycle" : code === "NETWORK_ERROR" || code === "TIMEOUT" ? "offline" : "node", code, durationMs: scheduler.now() - started, lagMs: null });
        throw error;
      } finally { signal?.removeEventListener("abort", abortFromCaller); state.abort = undefined; }
    })();
    state.sync = job;
    try { return await job; } finally {
      if (state.sync === job) {
        state.sync = undefined;
        state.syncContext = undefined;
      }
    }
  }
  type DrainedSync = { settled: false } | { settled: true; result: LocalSyncResult } | { settled: true; error: unknown };
  async function drainForegroundSync(prefix: string, sync: Promise<LocalSyncResult>): Promise<DrainedSync> {
    let cancel = () => {};
    const settled: Promise<DrainedSync> = sync.then(
      (result) => ({ settled: true, result }),
      (error: unknown) => ({ settled: true, error }),
    );
    const timeout = new Promise<DrainedSync>((resolve) => {
      cancel = scheduler.setTimeout(() => resolve({ settled: false }), CLOSE_TIMEOUT_MS);
    });
    try {
      const drained = await Promise.race([settled, timeout]);
      if (!drained.settled) emit({ type: "replication.sync", space: session.space, replica: prefix, trigger: "stale_read", outcome: "aborted", code: "DRAIN_TIMEOUT", durationMs: CLOSE_TIMEOUT_MS, lagMs: null });
      return drained;
    } finally { cancel(); }
  }
  function validateReadMeta(meta: LocalReadMeta): void {
    if (meta.coverage !== "complete") throw Object.assign(new Error("Replica coverage changed before the local read"), { code: "COVERAGE_INCOMPLETE" });
    if (meta.authority !== "valid") {
      const code = meta.authority === "expired" ? "GRANT_EXPIRED" : meta.authority === "revoked" ? "GRANT_REVOKED" : "GRANT_NOT_YET_VALID";
      throw Object.assign(new Error("Replica authority changed before the local read"), { code });
    }
  }
  function reasonForReadMetaCode(code: string): ReplicationReason {
    if (code === "COVERAGE_INCOMPLETE") return "coverage_incomplete";
    if (code === "GRANT_EXPIRED") return "grant_expired";
    if (code === "GRANT_REVOKED") return "grant_revoked";
    if (code === "GRANT_NOT_YET_VALID") return "grant_not_yet_valid";
    return "replica_error";
  }
  async function statusAfterDrain(handle: KVReplicaHandle, signal: AbortSignal): Promise<LocalReplicaStatus> {
    let cancel = () => {};
    const timeout = new Promise<never>((_resolve, reject) => {
      cancel = scheduler.setTimeout(
        () => reject(Object.assign(new Error("Replica status refresh timed out"), { code: "STATUS_TIMEOUT" })),
        STATUS_REFRESH_TIMEOUT_MS,
      );
    });
    try {
      return await raceSignal(Promise.race([handle.status(), timeout]), signal);
    } finally { cancel(); }
  }
  function staleSyncOutcome(outcome: { result: LocalSyncResult } | { error: unknown }, timedOut: boolean, currentStatus: LocalReplicaStatus): { status: LocalReplicaStatus; syncError?: string; syncedBeforeRead: boolean; failure?: "busy" | "error" } {
    if ("error" in outcome) {
      const code = errorCode(outcome.error);
      if (code === "NETWORK_ERROR" || (timedOut && (code === "ABORTED" || code === "TIMEOUT"))) return { status: currentStatus, syncedBeforeRead: false, syncError: code === "NETWORK_ERROR" ? code : "TIMEOUT" };
      return { status: currentStatus, syncedBeforeRead: false, syncError: code, failure: "error" };
    }
    if (outcome.result.status === "busy") return { status: currentStatus, syncedBeforeRead: false, failure: "busy" };
    return { status: currentStatus, syncedBeforeRead: true };
  }
  async function freshness(prefix: string, handle: KVReplicaHandle, signal: AbortSignal): Promise<{ status: LocalReplicaStatus; syncError?: string; syncedBeforeRead: boolean; failure?: "busy" | "error" }> {
    let currentStatus = await handle.status();
    const syncedAt = currentStatus.lastSyncAt === null ? null : Date.parse(currentStatus.lastSyncAt);
    const stale = syncedAt === null || !Number.isFinite(syncedAt) || scheduler.now() - syncedAt > options.maxStalenessMs;
    let snapshot;
    try { snapshot = await pending.read(); } catch (error) { return { status: currentStatus, syncedBeforeRead: false, syncError: errorCode(error), failure: "error" }; }
    const behind = currentStatus.syncedThroughEpoch < snapshot.committedEpoch;
    const unproven = !pending.durable && !inProcessProof.has(prefix);
    if ((stale || behind || unproven) && !signal.aborted) {
      const syncController = mode === "foreground" ? new AbortController() : undefined;
      const syncState = replicas.get(prefix);
      const ownsSync = !syncState?.sync;
      const syncContext = syncState?.syncContext ?? {};
      const abortFromCaller = () => {
        if (ownsSync) syncContext.abortCause ??= "caller";
        syncController?.abort(signal.reason);
      };
      if (syncController) signal.addEventListener("abort", abortFromCaller, { once: true });
      let cancelTimeout = () => {};
      const timeout = new Promise<{ timeout: true }>((resolve) => {
        cancelTimeout = scheduler.setTimeout(() => resolve({ timeout: true }), options.staleSyncTimeoutMs);
      });
      let cancelAbort = () => {};
      const callerAbort = new Promise<{ callerAborted: true }>((resolve) => {
        if (signal.aborted) resolve({ callerAborted: true });
        else {
          const listener = () => resolve({ callerAborted: true });
          signal.addEventListener("abort", listener, { once: true });
          cancelAbort = () => signal.removeEventListener("abort", listener);
        }
      });
      const sync = syncPrefix(prefix, "stale_read", syncController?.signal, syncContext);
      const outcome = await Promise.race([
        sync.then((result) => ({ result }), (error: unknown) => ({ error })),
        timeout,
        callerAbort,
      ]);
      cancelTimeout();
      cancelAbort();
      signal.removeEventListener("abort", abortFromCaller);
      if ("callerAborted" in outcome) {
        if (syncController && ownsSync) {
          syncContext.abortCause ??= "caller";
          syncController.abort(signal.reason);
          await drainForegroundSync(prefix, sync);
        }
        return { status: currentStatus, syncedBeforeRead: false, syncError: cancellationCode(signal) };
      }
      if ("timeout" in outcome) {
        if (ownsSync) {
          syncContext.abortCause ??= "timeout";
          syncController?.abort(Object.assign(new Error("Stale-read sync timed out"), { code: "TIMEOUT" }));
        }
        const drained = syncController ? await drainForegroundSync(prefix, sync) : undefined;
        if (signal.aborted) return { status: currentStatus, syncedBeforeRead: false, syncError: cancellationCode(signal) };
        if (drained && !drained.settled) return { status: currentStatus, syncedBeforeRead: false, syncError: "DRAIN_TIMEOUT", failure: "error" };
        try { currentStatus = await statusAfterDrain(handle, signal); }
        catch (error) {
          if (signal.aborted) return { status: currentStatus, syncedBeforeRead: false, syncError: cancellationCode(signal), failure: "error" };
          return { status: currentStatus, syncedBeforeRead: false, syncError: errorCode(error), failure: "error" };
        }
        const timeoutAbort = syncContext.abortCause === "timeout";
        return staleSyncOutcome(
          drained?.settled ? ("result" in drained ? { result: drained.result } : { error: drained.error }) : { error: Object.assign(new Error("Stale-read sync timed out"), { code: "TIMEOUT" }) },
          timeoutAbort || !syncController,
          currentStatus,
        );
      }
      if ("error" in outcome) return staleSyncOutcome({ error: outcome.error }, false, currentStatus);
      if (outcome.result.status === "busy") return { status: currentStatus, syncedBeforeRead: false, failure: "busy" };
      currentStatus = await handle.status();
      return { status: currentStatus, syncedBeforeRead: true };
    }
    return { status: currentStatus, syncedBeforeRead: false };
  }

  function readEvent(op: "get" | "list", path: string, prefix: string | null, source: "replica" | "network" | "none", reason: ReplicationReason, outcome: "found" | "not_found" | "error", started: number, extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>> = {}): void {
    if (prefix !== null && reason === "grant_expired" && extra.code !== "CONSENT_EXPIRED") reportGrantExpiry(prefix);
    emit({ type: "replication.read", op, space: session.space, key: path, replica: prefix, source, reason, outcome, latencyMs: scheduler.now() - started, stalenessMs: null, coverage: null, authority: null, ...extra });
  }
  async function networkRead<T>(
    network: () => Promise<Result<T>>, op: "get" | "list", path: string, prefix: string | null,
    reason: ReplicationReason, started: number,
    extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>> = {},
  ): Promise<Result<T>> {
    let outcome: "found" | "not_found" | "error" = "error";
    try {
      const result = await network();
      outcome = result.ok ? "found" : op === "get" && (reason === "pending_write" || reason === "not_covered") && result.error.code === ErrorCodes.KV_NOT_FOUND ? "not_found" : "error";
      return result;
    } finally {
      readEvent(op, path, prefix, "network", reason, outcome, started, extra);
    }
  }
  async function verifyGet<T>(
    r: { space: string; path: string; signal: AbortSignal; network: () => Promise<Result<KVResponse<T>>> },
    local: Result<KVResponse<T>>,
    reason: ReplicationReason,
    started: number,
    extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>>,
  ): Promise<Result<KVResponse<T>>> {
    const prefix = configuredPrefix(r.path) ?? null;
    const localFound = local.ok;
    const localNotFound = !local.ok && local.error.code === ErrorCodes.KV_NOT_FOUND;
    const outcome = localFound ? "found" : localNotFound ? "not_found" : "error";
    try {
      const network = await raceSignal(r.network(), r.signal);
      if (r.signal.aborted) {
        readEvent("get", r.path, prefix, "none", "aborted", "error", started, { ...extra, verify: "aborted" });
        return abortedResult(r.signal);
      }
      const delivery = checkDelivery();
      if (delivery.status !== "allow") {
        readEvent("get", r.path, prefix, "network", delivery.status === "consent_expired" ? "grant_expired" : "replica_gated", network.ok ? "found" : "error", started, { code: delivery.status === "consent_expired" ? delivery.code : "REPLICA_GATED" });
        return network;
      }
      const refusal = prefix === null ? undefined : sessionRefusal(prefix);
      if (refusal) {
        readEvent("get", r.path, prefix, "network", "grant_missing", network.ok ? "found" : "error", started, { code: refusal });
        return network;
      }
      if (!network.ok && network.error.code !== ErrorCodes.KV_NOT_FOUND) {
        readEvent("get", r.path, prefix, "replica", reason, outcome, started, { ...extra, code: network.error.code, verify: "error" });
        return local;
      }
      const networkFound = network.ok;
      const networkNotFound = !network.ok && network.error.code === ErrorCodes.KV_NOT_FOUND;
      const localEtag = local.ok ? local.data.headers.etag ?? null : null;
      const networkEtag = network.ok ? network.data.headers.etag ?? null : null;
      const matches = localFound && networkFound ? localEtag === networkEtag : localNotFound && networkNotFound;
      const verify = matches ? "match" : "diverged";
      if (!matches) {
        emit({
          type: "replication.divergence",
          op: "get",
          space: r.space,
          key: r.path,
          replica: prefix ?? "",
          kind: localFound && networkFound ? "value" : localNotFound ? "missing_local" : "extra_local",
          localEtag,
          networkEtag,
          stalenessMs: typeof extra.stalenessMs === "number" ? extra.stalenessMs : null,
        });
      }
      readEvent("get", r.path, prefix, "replica", reason, outcome, started, { ...extra, verify });
      return local;
    } catch (error) {
      if (r.signal.aborted) {
        readEvent("get", r.path, prefix, "none", "aborted", "error", started, { ...extra, verify: "aborted" });
        return abortedResult(r.signal);
      }
      const delivery = checkDelivery();
      if (delivery.status !== "allow") {
        readEvent("get", r.path, prefix, "network", delivery.status === "consent_expired" ? "grant_expired" : "replica_gated", "error", started, { code: delivery.status === "consent_expired" ? delivery.code : "REPLICA_GATED" });
        return err(wrapError("kv", error));
      }
      const refusal = prefix === null ? undefined : sessionRefusal(prefix);
      if (refusal) {
        readEvent("get", r.path, prefix, "network", "grant_missing", "error", started, { code: refusal });
        return err(wrapError("kv", error));
      }
      readEvent("get", r.path, prefix, "replica", reason, outcome, started, { ...extra, code: errorCode(error), verify: "error" });
      return local;
    }
  }
  async function verifyList(
    r: { space: string; listPath: string; signal: AbortSignal; network: () => Promise<Result<KVListPage>> },
    local: KVListPage,
    started: number,
    extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>>,
  ): Promise<Result<KVListPage>> {
    const prefix = listPathCovered(options.prefixes, r.listPath) ?? null;
    try {
      const network = await raceSignal(r.network(), r.signal);
      if (r.signal.aborted) {
        readEvent("list", r.listPath, prefix, "none", "aborted", "error", started, { ...extra, verify: "aborted" });
        return abortedResult(r.signal);
      }
      const delivery = checkDelivery();
      if (delivery.status !== "allow") {
        readEvent("list", r.listPath, prefix, "network", delivery.status === "consent_expired" ? "grant_expired" : "replica_gated", network.ok ? "found" : "error", started, { code: delivery.status === "consent_expired" ? delivery.code : "REPLICA_GATED" });
        return network;
      }
      const refusal = prefix === null ? undefined : sessionRefusal(prefix);
      if (refusal) {
        readEvent("list", r.listPath, prefix, "network", "grant_missing", network.ok ? "found" : "error", started, { code: refusal });
        return network;
      }
      if (!network.ok) {
        readEvent("list", r.listPath, prefix, "replica", "hit", "found", started, { ...extra, code: network.error.code, verify: "error" });
        return ok(local);
      }
      const localSet = new Set(local.keys);
      const networkSet = new Set(network.data.keys);
      const localOnly = local.keys.filter((key) => !networkSet.has(key));
      const networkOnly = network.data.keys.filter((key) => !localSet.has(key));
      const sameKeys = localOnly.length === 0 && networkOnly.length === 0;
      const sameOrder = sameKeys && local.keys.every((key, index) => key === network.data.keys[index]);
      const verify = sameOrder ? "match" : "diverged";
      if (!sameKeys || !sameOrder) {
        emit({
          type: "replication.divergence",
          op: "list",
          space: r.space,
          key: r.listPath,
          replica: prefix ?? "",
          kind: sameKeys ? "order" : "keys",
          ...(!sameKeys ? { localOnly, networkOnly } : {}),
          stalenessMs: typeof extra.stalenessMs === "number" ? extra.stalenessMs : null,
        });
      }
      readEvent("list", r.listPath, prefix, "replica", "hit", "found", started, { ...extra, verify });
      return ok(local);
    } catch (error) {
      if (r.signal.aborted) {
        readEvent("list", r.listPath, prefix, "none", "aborted", "error", started, { ...extra, verify: "aborted" });
        return abortedResult(r.signal);
      }
      const delivery = checkDelivery();
      if (delivery.status !== "allow") {
        readEvent("list", r.listPath, prefix, "network", delivery.status === "consent_expired" ? "grant_expired" : "replica_gated", "error", started, { code: delivery.status === "consent_expired" ? delivery.code : "REPLICA_GATED" });
        return err(wrapError("kv", error));
      }
      const refusal = prefix === null ? undefined : sessionRefusal(prefix);
      if (refusal) {
        readEvent("list", r.listPath, prefix, "network", "grant_missing", "error", started, { code: refusal });
        return err(wrapError("kv", error));
      }
      readEvent("list", r.listPath, prefix, "replica", "hit", "found", started, { ...extra, code: errorCode(error), verify: "error" });
      return ok(local);
    }
  }
  async function reportExistingPins(): Promise<void> {
    if (pinnedStateReported) return;
    pinnedStateReported = true;
    try {
      const records = await pending.read();
      const pins = pinnedKeys(records, "", scheduler.now());
      if (pins.length > 0) emit({ type: "replication.state", space: session.space, state: "pinned", count: pins.length, keys: pins.map((pin) => pin.key) });
    } catch { emit({ type: "replication.state", space: session.space, state: "pending_store_error", code: "STORAGE_ERROR" }); }
  }

  async function get<T>(r: { space: string; key: string; path: string; options: KVGetOptions | undefined; signal: AbortSignal; network: () => Promise<Result<KVResponse<T>>> }): Promise<Result<KVResponse<T>>> {
    const started = scheduler.now();
    const prefix = configuredPrefix(r.path);
    if (r.options?.source === "network") {
      let outcome: "found" | "not_found" | "error" = "error";
      try {
        const value = await r.network();
        outcome = value.ok ? "found" : value.error.code === ErrorCodes.KV_NOT_FOUND ? "not_found" : "error";
        return value;
      } finally {
        observeNetworkRequested({ op: "get", space: r.space, path: r.path, reason: "NETWORK_REQUESTED", outcome, latencyMs: scheduler.now() - started });
      }
    }
    let networkRejected = false;
    const fallback = async (
      replica: string, reason: ReplicationReason,
      extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>> = {},
    ) => {
      try { return await networkRead(r.network, "get", r.path, replica, reason, started, extra); }
      catch (error) { networkRejected = true; throw error; }
    };
    if (prefix === undefined) return networkRead(r.network, "get", r.path, null, "not_covered", started);
    const delivery = checkDelivery();
    if (delivery.status !== "allow") {
      return fallback(prefix, delivery.status === "consent_expired" ? "grant_expired" : "replica_gated",
        { code: delivery.status === "consent_expired" ? delivery.code : "REPLICA_GATED" });
    }
    const refusal = sessionRefusal(prefix);
    if (refusal) return fallback(prefix, "grant_missing", { code: refusal });
    try { await raceSignal(reportExistingPins(), r.signal); } catch { if (r.signal.aborted) return abortedResult(r.signal); }
    let handle: KVReplicaHandle;
    try { handle = await raceSignal(open(prefix), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      if (errorCode(error) === "CONSENT_EXPIRED") startConsentDenial();
      const code = errorCode(error);
      return fallback(prefix, code === "RUNTIME_UNSUPPORTED" ? "runtime_unsupported" : code === "CONSENT_EXPIRED" || code === "REPLICA_GATED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "replica_unavailable", { code });
    }
    if (replicas.get(prefix)?.reason === "grant_missing") {
      const code = replicas.get(prefix)?.lastError;
      return fallback(prefix, code === "GRANT_EXPIRED" ? "grant_expired" : code === "REPLICA_GATED" ? "replica_gated" : "grant_missing", { code });
    }

    let fresh: Awaited<ReturnType<typeof freshness>>;
    try { fresh = await freshness(prefix, handle, r.signal); }
    catch (error) {
      recordRevocation(prefix, error);
      if (errorCode(error) === "CONSENT_EXPIRED") startConsentDenial();
      if (r.signal.aborted) return abortedResult(r.signal);
      const code = errorCode(error);
      return fallback(prefix, code === "CONSENT_EXPIRED" || code === "REPLICA_GATED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "replica_error", { code });
    }
    if (r.signal.aborted) return abortedResult(r.signal);
    if (fresh.failure) {
      const code = fresh.failure === "busy" ? "REPLICA_BUSY" : fresh.syncError;
      return fallback(prefix, code === "GRANT_REVOKED" ? "grant_revoked" : code === "REPLICA_GATED" || code === "CONSENT_EXPIRED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "stale",
        { code, syncedBeforeRead: fresh.syncedBeforeRead });
    }
    let pendingState: PendingWriteState;
    try { pendingState = await raceSignal(pending.read(), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      const code = errorCode(error);
      return fallback(prefix, code === "REPLICA_GATED" || code === "CONSENT_EXPIRED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "replica_unavailable", { code });
    }
    const record = pendingState.records.find((x) => x.key === r.path);
    if (record) return fallback(prefix, "pending_write", { pendingState: record.state, syncedBeforeRead: fresh.syncedBeforeRead });
    if (!pending.durable && !inProcessProof.has(prefix)) return fallback(prefix, "REPLICA_UNPROVEN_SINCE_START");
    if (fresh.status.syncedThroughEpoch < pendingState.committedEpoch) return fallback(prefix, "REPLICA_BEHIND_OWN_WRITES");
    if (fresh.status.authority.state !== "valid") return fallback(prefix, fresh.status.authority.state === "expired" ? "grant_expired" : fresh.status.authority.state === "revoked" ? "grant_revoked" : "grant_not_yet_valid");
    if (fresh.status.coverage !== "complete") return fallback(prefix, "coverage_incomplete");
    try {
      const local = await raceSignal(handle.get(r.path), r.signal);
      const delivery = checkDelivery();
      if (delivery.status !== "allow") throw deliveryError(delivery);
      const refusal = sessionRefusal(prefix);
      if (refusal) return await fallback(prefix, "grant_missing", { code: refusal });
      try { validateReadMeta(local.meta); }
      catch (error) {
        const code = errorCode(error);
        recordRevocation(prefix, error);
        return await fallback(prefix, reasonForReadMetaCode(code), { code });
      }
      if (local.status === "coverage_incomplete" || local.status === "not_covered" || local.status === "content_missing") return await fallback(prefix, local.status === "content_missing" ? "content_missing" : local.status === "coverage_incomplete" ? "coverage_incomplete" : "not_covered");
      if (local.status === "present" && r.options?.maxResponseBytes !== undefined && local.value.byteLength > r.options.maxResponseBytes) {
        return await fallback(prefix, "unsupported_option");
      }
      const result = localGet<T>(local as LocalGetResult, r.path, r.options ?? {});
      const reason = local.status === "present" ? "hit" : local.status;
      const syncedAt = fresh.status.lastSyncAt === null ? null : Date.parse(fresh.status.lastSyncAt);
      const event = {
        syncedBeforeRead: fresh.syncedBeforeRead,
        coverage: local.meta.coverage,
        authority: local.meta.authority,
        stalenessMs: syncedAt === null ? null : scheduler.now() - syncedAt,
        ...(fresh.syncError ? { syncError: fresh.syncError } : {}),
      };
      if (options.verify) return await verifyGet(r, result as Result<KVResponse<T>>, reason, started, event);
      readEvent("get", r.path, prefix, "replica", reason, result.ok ? "found" : result.error.code === ErrorCodes.KV_NOT_FOUND ? "not_found" : "error", started, event);
      return result as LocalGetResponse<T>;
    } catch (error) {
      if (networkRejected) throw error;
      recordRevocation(prefix, error);
      if (errorCode(error) === "CONSENT_EXPIRED") startConsentDenial();
      if (r.signal.aborted) return abortedResult(r.signal);
      return fallback(prefix, deliveryReason(errorCode(error)), { code: errorCode(error) });
    }
  }

  async function list(r: { space: string; listPath: string; options: KVListOptions | undefined; signal: AbortSignal; network: () => Promise<Result<KVListPage>> }): Promise<Result<KVListPage>> {
    const started = scheduler.now();
    if (r.options?.source === "network") {
      let outcome: "found" | "not_found" | "error" = "error";
      try {
        const result = await r.network();
        outcome = result.ok ? "found" : "error";
        return result;
      } finally {
        observeNetworkRequested({ op: "list", space: r.space, path: r.listPath, reason: "NETWORK_REQUESTED", outcome, latencyMs: scheduler.now() - started });
      }
    }
    const cursor = r.options?.cursor;
    const decoded = cursor?.startsWith("tcr1.") ? decodeTcr1(cursor) : null;
    if (cursor && cursor.startsWith("tcr1.") && !decoded) { readEvent("list", r.listPath, null, "none", "cursor_restart", "error", started); return cursorRestart(); }
    if (cursor && !cursor.startsWith("tcr1.")) return networkRead(r.network, "list", r.listPath, null, "network_cursor", started);
    const prefix = listPathCovered(options.prefixes, r.listPath);
    let networkRejected = false;
    const fallback = async (
      replica: string, reason: ReplicationReason,
      extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>> = {},
    ) => {
      try { return await networkRead(r.network, "list", r.listPath, replica, reason, started, extra); }
      catch (error) { networkRejected = true; throw error; }
    };
    if (prefix !== undefined && !r.options?.raw) {
      const delivery = checkDelivery();
      if (delivery.status !== "allow") {
        if (decoded) { readEvent("list", r.listPath, prefix, "none", "cursor_restart", "error", started); return cursorRestart(); }
        return fallback(prefix, delivery.status === "consent_expired" ? "grant_expired" : "replica_gated",
          { code: delivery.status === "consent_expired" ? delivery.code : "REPLICA_GATED" });
      }
    }
    if (prefix !== undefined && !r.options?.raw) {
      const refusal = sessionRefusal(prefix);
      if (refusal) {
        if (decoded) { readEvent("list", r.listPath, prefix, "none", "cursor_restart", "error", started); return cursorRestart(); }
        return fallback(prefix, "grant_missing", { code: refusal });
      }
    }
    try { await raceSignal(reportExistingPins(), r.signal); } catch { if (r.signal.aborted) return abortedResult(r.signal); }
    const restart = () => { readEvent("list", r.listPath, prefix ?? null, "none", "cursor_restart", "error", started); return cursorRestart(); };
    if (cursor && decoded && (decoded.space !== r.space || decoded.path !== r.listPath)) return restart();
    if (prefix === undefined || r.options?.raw) { if (cursor && decoded) return restart(); return networkRead(r.network, "list", r.listPath, prefix ?? null, prefix !== undefined ? "unsupported_option" : "not_covered", started); }
    let handle: KVReplicaHandle;
    try { handle = await raceSignal(open(prefix), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      if (errorCode(error) === "CONSENT_EXPIRED") startConsentDenial();
      if (cursor && decoded) return restart();
      const code = errorCode(error);
      return fallback(prefix, code === "RUNTIME_UNSUPPORTED" ? "runtime_unsupported" : code === "CONSENT_EXPIRED" || code === "REPLICA_GATED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "replica_unavailable", { code });
    }
    if (replicas.get(prefix)?.reason === "grant_missing") {
      if (cursor && decoded) return restart();
      const code = replicas.get(prefix)?.lastError;
      return fallback(prefix, code === "GRANT_EXPIRED" ? "grant_expired" : code === "REPLICA_GATED" ? "replica_gated" : "grant_missing", { code });
    }
    let fresh: Awaited<ReturnType<typeof freshness>>;
    try { fresh = await freshness(prefix, handle, r.signal); }
    catch (error) {
      recordRevocation(prefix, error);
      if (errorCode(error) === "CONSENT_EXPIRED") startConsentDenial();
      if (r.signal.aborted) return abortedResult(r.signal);
      if (cursor && decoded) return restart();
      const code = errorCode(error);
      return fallback(prefix, code === "CONSENT_EXPIRED" || code === "REPLICA_GATED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "replica_error", { code });
    }
    if (r.signal.aborted) return abortedResult(r.signal);
    let state: PendingWriteState;
    try { state = await raceSignal(pending.read(), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      if (cursor && decoded) return restart();
      const code = errorCode(error);
      return fallback(prefix, code === "REPLICA_GATED" || code === "CONSENT_EXPIRED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "replica_unavailable", { code });
    }
    const pendingRange = state.records.find((record) => listRangeCovers(r.listPath, record.key));
    const behind = fresh.status.syncedThroughEpoch < state.committedEpoch;
    if (cursor && decoded && (fresh.failure || pendingRange || behind || fresh.status.coverage !== "complete" || fresh.status.authority.state !== "valid" || (!pending.durable && !inProcessProof.has(prefix)))) return restart();
    if (behind) return fallback(prefix, "REPLICA_BEHIND_OWN_WRITES");
    if (fresh.failure) {
      const code = fresh.failure === "busy" ? "REPLICA_BUSY" : fresh.syncError;
      return fallback(prefix, code === "GRANT_REVOKED" ? "grant_revoked" : code === "REPLICA_GATED" || code === "CONSENT_EXPIRED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : "stale", { code });
    }
    if (pendingRange) return fallback(prefix, "pending_write", { pendingState: pendingRange.state });
    if (!pending.durable && !inProcessProof.has(prefix)) return fallback(prefix, "REPLICA_UNPROVEN_SINCE_START");
    if (fresh.status.coverage !== "complete" || fresh.status.authority.state !== "valid") return fallback(prefix, fresh.status.coverage !== "complete" ? "coverage_incomplete" : fresh.status.authority.state === "expired" ? "grant_expired" : fresh.status.authority.state === "revoked" ? "grant_revoked" : "grant_not_yet_valid");
    try {
      const signalHandle = { list: (o: { prefix: string; after?: string; limit?: number }) => raceSignal(handle.list(o), r.signal) };
      const page = await raceSignal(localList(signalHandle, r.space, r.listPath, r.options?.limit, cursor, validateReadMeta), r.signal);
      const latest = await raceSignal(pending.read(), r.signal);
      const laterPending = latest.records.find((record) => listRangeCovers(r.listPath, record.key));
      if (cursor && decoded && (laterPending || fresh.status.syncedThroughEpoch < latest.committedEpoch)) return restart();
      if (fresh.status.syncedThroughEpoch < latest.committedEpoch) return await fallback(prefix, "REPLICA_BEHIND_OWN_WRITES");
      if (laterPending) return await fallback(prefix, "pending_write", { pendingState: laterPending.state });
      const delivery = checkDelivery();
      if (delivery.status !== "allow") throw deliveryError(delivery);
      const refusal = sessionRefusal(prefix);
      if (refusal) {
        if (decoded) return restart();
        return await fallback(prefix, "grant_missing", { code: refusal });
      }
      const event = {
        count: page.keys.length,
        syncedBeforeRead: fresh.syncedBeforeRead,
        stalenessMs: fresh.status.lastSyncAt === null ? null : scheduler.now() - Date.parse(fresh.status.lastSyncAt),
        ...(fresh.syncError ? { syncError: fresh.syncError } : {}),
      };
      if (options.verify && !cursor) return await verifyList(r, page, started, event);
      readEvent("list", r.listPath, prefix, "replica", "hit", "found", started, event);
      return ok(page);
    } catch (error) {
      if (networkRejected) throw error;
      if (r.signal.aborted) return abortedResult(r.signal);
      const code = errorCode(error);
      if (code === "CONSENT_EXPIRED") startConsentDenial();
      recordRevocation(prefix, error);
      if (cursor && decoded) return restart();
      const reason = code === "CONSENT_EXPIRED" || code === "REPLICA_GATED" || code === "GRANT_EXPIRED" ? deliveryReason(code) : reasonForReadMetaCode(code);
      return fallback(prefix, reason, { code });
    }
  }

  async function write<T>(r: { op: "put" | "delete" | "batchPut"; space: string; entries: ReadonlyArray<{ path: string; body?: Blob | string }>; signal: AbortSignal; conditional?: boolean; network: () => Promise<Result<T>> }): Promise<Result<T>> {
    const covered = r.entries.flatMap((entry) => {
      const prefix = configuredPrefix(entry.path);
      return prefix !== undefined ? [{ key: entry.path, op: r.op === "delete" ? "delete" as const : "put" as const }] : [];
    });
    if (covered.length === 0) return r.network();
    if (checkDelivery().status !== "allow") return r.network();
    await reportExistingPins();
    if (checkDelivery().status !== "allow") return r.network();
    const opId = globalThis.crypto?.randomUUID?.() ?? `${scheduler.now()}-${Math.random()}`;
    try { await pending.update((s) => begin(s, opId, covered, nowDate(scheduler.now()))); }
    catch (error) {
      if (errorCode(error) === "REPLICA_GATED" || errorCode(error) === "CONSENT_EXPIRED" || checkDelivery().status !== "allow") return r.network();
      return err(serviceError(ErrorCodes.KV_WRITE_FAILED, "Unable to persist pending KV write; request was not dispatched", "kv", { cause: error instanceof Error ? error : undefined, meta: { replication: "pending_store_unavailable", requestDispatched: false } }));
    }
    const started = scheduler.now();
    let result: Result<T>;
    try { result = await r.network(); }
    catch (error) {
      const wrapped = wrapError("kv", error);
      result = err({
        ...wrapped,
        meta: { ...wrapped.meta, requestMayHaveDispatched: true },
      });
    }
    const outcome = classifyWriteOutcome(r.op, result, { conditional: r.conditional === true });
    let settleError: unknown;
    try { await pending.update((s) => settle(s, opId, outcome, nowDate(scheduler.now()), result.ok ? undefined : result.error.code)); } catch (error) { settleError = error; }
    emit({ type: "replication.write", space: r.space, op: r.op, keys: covered.map((x) => x.key), outcome, ...(!result.ok ? { code: result.error.code } : {}), latencyMs: scheduler.now() - started });
    const state = await pending.read().catch(() => undefined);
    const pins = state ? pinnedKeys(state, "", scheduler.now()) : [];
    if (outcome === "ambiguous") emit({ type: "replication.state", space: r.space, state: "pinned", count: pins.length, keys: pins.map((p) => p.key) });
    if (settleError) emit({ type: "replication.state", space: r.space, state: "pending_store_error", code: "STORAGE_ERROR" });
    return result;
  }

  function observeNetworkRequested(r: { op: "get" | "list"; space: string; path: string; reason: "NETWORK_REQUESTED"; outcome: "found" | "not_found" | "error"; latencyMs: number }): void {
    emit({ type: "replication.read", op: r.op, space: r.space, key: r.path, replica: null, source: "network", reason: "NETWORK_REQUESTED", outcome: r.outcome, latencyMs: r.latencyMs, stalenessMs: null, coverage: null, authority: null });
  }

  async function inspectPersistedStatus(prefix: string): Promise<InspectedStatusResult> {
    if (!storage.inspectStatus || isClosed || purgeInProgress) return { missing: false };
    const sessionGrant = authority.sessionGrant(prefix);
    const device = "refused" in sessionGrant ? undefined : sessionGrant.device;
    const spec = { identity, space: session.space, prefix, allowSecrets: options.allowSecrets, ...(device ? { device } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) };
    const abort = new AbortController();
    const job = Promise.resolve().then(() => storage.inspectStatus!(spec, { signal: abort.signal }));
    const settled = job.then(() => undefined, () => undefined);
    const inspection = { abort, settled };
    statusInspections.add(inspection);
    void settled.then(() => statusInspections.delete(inspection));
    let cancel = () => {};
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      cancel = scheduler.setTimeout(() => {
        abort.abort(Object.assign(new Error("Replica status inspection timed out"), { code: "STATUS_TIMEOUT" }));
        resolve({ timedOut: true });
      }, STATUS_REFRESH_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([job.then((local) => ({ local })), timeout]);
      if ("timedOut" in result) return { missing: false, errorCode: "STATUS_TIMEOUT" };
      return { missing: result.local === undefined, ...(result.local ? { local: result.local } : {}) };
    } catch (error) {
      return { missing: false, errorCode: errorCode(error) };
    } finally { cancel(); }
  }

  function cancelStatusInspections(): Promise<void> {
    const active = [...statusInspections];
    for (const inspection of active) inspection.abort.abort(Object.assign(new Error("Replica status inspection cancelled"), { code: "ABORTED" }));
    return Promise.all(active.map((inspection) => inspection.settled)).then(() => undefined);
  }

  function gatedStatus(decision: Exclude<ReplicaDeliveryDecision, { status: "allow" }>): ReplicaStatusEntry[] {
    return options.prefixes.map((prefix) => ({
      prefix,
      state: "gated",
      reason: "replica_gated",
      gate: decision.status === "gated" ? decision.gate : "stamp_stale",
      errorCode: decision.status === "consent_expired" ? decision.code : "REPLICA_GATED",
      pending: { inFlight: 0, committed: 0, ambiguous: 0 },
      pinned: [],
      lagMs: null,
      redacted: true,
    }));
  }

  async function status(): Promise<ReplicaStatusEntry[]> {
    const beforeStatus = checkDelivery();
    if (beforeStatus.status !== "allow") return gatedStatus(beforeStatus);
    let persistedSnapshot: PendingWriteState | null | undefined;
    try {
      persistedSnapshot = pending.readExisting ? await pending.readExisting() : await pending.read();
    } catch (error) {
      const delivery = checkDelivery();
      if (delivery.status !== "allow") return gatedStatus(delivery);
      throw error;
    }
    const afterPending = checkDelivery();
    if (afterPending.status !== "allow") return gatedStatus(afterPending);
    const snapshot = persistedSnapshot ?? emptyPendingState(identity);
    const entries = await Promise.all(options.prefixes.map(async (prefix): Promise<ReplicaStatusEntry | undefined> => {
      if (prefix === "/" && deps.nodeFeatures !== undefined && !deps.nodeFeatures.includes("kv-sync-root")) {
        markRootUnsupported(prefix);
      }
      const records = snapshot.records.filter((r) => kvPrefixCovers(prefix, r.key));
      const opened = replicas.get(prefix);
      let local: LocalReplicaStatus | ReplicaInspectedStatus | undefined;
      if (opened?.handle) {
        try { local = await opened.handle.status(); }
        catch { /* A generation-fenced or unavailable handle has no live status. */ }
      }
      let inspected: InspectedStatusResult = { missing: false };
      if (!local && !opened?.opening && !opened?.authorityRevoked) inspected = await inspectPersistedStatus(prefix);
      local ??= inspected.local;
      if (inspected.missing && !opened?.reason && !opened?.authorityRevoked && !opened?.opening && !isClosed) return undefined;
      const full = local && !("redacted" in local) ? local : undefined;
      const revoked = opened?.authorityRevoked === true || full?.authority.state === "revoked";
      const rootUnsupported = opened?.lastError === "REPLICATION_ROOT_UNSUPPORTED";
      const state = isClosed ? "closed" as const : revoked ? "revoked" as const : rootUnsupported || opened?.reason === "grant_expired" ? "unavailable" as const : opened?.reason === "grant_missing" ? "grant_missing" as const : full?.coverage === "complete" && full.authority.state === "valid" ? "ready" as const : opened?.reason || inspected.errorCode ? "unavailable" as const : "idle" as const;
      return {
        prefix,
        state,
        ...(opened?.reason ? { reason: opened.reason } : inspected.errorCode ? { reason: "replica_unavailable" as const } : {}),
        ...(inspected.errorCode ?? opened?.lastError ? { errorCode: inspected.errorCode ?? opened?.lastError } : {}),
        ...(local ?? {}),
        ...(revoked ? { authority: { state: "revoked" as const, expiresAt: full?.authority.expiresAt ?? null } } : {}),
        pending: {
          inFlight: records.filter((r) => r.state === "in_flight").length,
          committed: records.filter((r) => r.state === "committed").length,
          ambiguous: records.filter((r) => r.state === "ambiguous").length,
        },
        pinned: pinnedKeys(snapshot, prefix, scheduler.now()),
        lagMs: full?.lastSyncAt ? scheduler.now() - Date.parse(full.lastSyncAt) : null,
      };
    }));
    const beforeReturn = checkDelivery();
    if (beforeReturn.status !== "allow") return gatedStatus(beforeReturn);
    return entries.filter((entry): entry is ReplicaStatusEntry => entry !== undefined);
  }

  async function sync(o?: { prefix?: string; signal?: AbortSignal }): Promise<void> {
    const prefixes = o?.prefix !== undefined ? options.prefixes.filter((p) => p === o.prefix) : options.prefixes;
    await Promise.all(prefixes.map((prefix) => syncPrefix(prefix, "manual", o?.signal).then(() => undefined)));
  }

  async function clearPending(): Promise<number> {
    const count = await pending.update((s) => clearPendingRecords(s, scheduler.now()));
    emit({ type: "replication.state", space: session.space, state: "pending_cleared", count });
    return count;
  }

  function purge(o?: { timeoutMs?: number }): Promise<{ purged: string[]; failed: Array<{ prefix: string; code: string }> }> {
    purgeStarted = true;
    purgeInProgress = true;
    cancelConsentTimer?.();
    cancelConsentTimer = undefined;
    const hasStatusInspections = statusInspections.size > 0;
    const statusDrain = cancelStatusInspections();
    for (const state of replicas.values()) {
      state.timer?.();
      state.timer = undefined;
      state.renewalTimer?.();
      state.renewalTimer = undefined;
      state.syncContext && (state.syncContext.abortCause ??= "purge");
      state.abort?.abort();
      state.mintAbort?.abort();
    }
    return Promise.resolve().then(async () => {
      const report = { purged: [] as string[], failed: [] as Array<{ prefix: string; code: string }> };
      const timeoutMs = o?.timeoutMs ?? 5_000;
      const withTimeout = async <T>(job: Promise<T>): Promise<T> => {
        let cancel = () => {};
        const timeout = new Promise<never>((_, reject) => {
          cancel = scheduler.setTimeout(() => reject(Object.assign(new Error("Replication cleanup timed out"), { code: "TIMEOUT" })), timeoutMs);
        });
        try { return await Promise.race([job, timeout]); }
        finally { cancel(); }
      };
      const drain = Promise.all([
        ...[...replicas.values()].flatMap((state) => [
          state.opening?.catch(() => undefined),
          state.sync?.catch(() => undefined),
          state.renewing?.catch(() => undefined),
          state.handle?.close().catch(() => undefined),
        ]),
        ...(hasStatusInspections ? [statusDrain] : []),
      ]);
      let drainCode: string | undefined;
      try { await withTimeout(drain); } catch (error) { drainCode = errorCode(error); }
      const jobs = options.prefixes.map(async (prefix) => {
        try {
          if (drainCode) throw Object.assign(new Error("Replica cleanup did not settle before purge"), { code: drainCode });
          const grant = authority.sessionGrant(prefix);
          const sessionDeviceDid = replicas.get(prefix)?.handle?.deviceDid ?? ("refused" in grant ? undefined : grant.device.did);
          await withTimeout(storage.purge({ identity, space: session.space, prefix, ...(sessionDeviceDid ? { sessionDeviceDid } : {}) }));
          await pending.update((s) => clearPrefix(s, prefix));
          replicas.delete(prefix);
          inProcessProof.delete(prefix);
          report.purged.push(prefix);
          emit({ type: "replication.state", space: session.space, replica: prefix, state: "purged" });
        } catch (error) {
          const code = errorCode(error);
          report.failed.push({ prefix, code });
          emit({ type: "replication.state", space: session.space, replica: prefix, state: "purge_failed", code });
        }
      });
      await Promise.all(jobs);
      return report;
    }).finally(() => { purgeInProgress = false; });
  }

  async function close(): Promise<void> {
    if (isClosed) return;
    isClosed = true;
    cancelConsentTimer?.();
    cancelConsentTimer = undefined;
    const hasStatusInspections = statusInspections.size > 0;
    const statusDrain = cancelStatusInspections();
    for (const [prefix, state] of replicas) {
      state.timer?.();
      state.timer = undefined;
      state.renewalTimer?.();
      state.renewalTimer = undefined;
      state.mintAbort?.abort();
      state.syncContext && (state.syncContext.abortCause ??= "close");
      state.abort?.abort();
      emit({ type: "replication.state", space: session.space, replica: prefix, state: "closed" });
    }
    const drain = Promise.all([
      ...[...replicas.values()].map(async (state) => {
        await state.opening?.catch(() => undefined);
        await state.renewing?.catch(() => undefined);
        await state.sync?.catch(() => undefined);
        await state.handle?.close().catch(() => undefined);
      }),
      ...(hasStatusInspections ? [statusDrain] : []),
    ]);
    let cancel = () => {};
    let drained = false;
    void drain.then(
      () => { drained = true; cancel(); },
      () => { drained = true; cancel(); },
    );
    const timeout = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        if (!drained) cancel = scheduler.setTimeout(resolve, CLOSE_TIMEOUT_MS);
      });
    });

    try { await Promise.race([drain, timeout]); }
    finally { cancel(); }
  }

  scheduleConsentDeadline();
  return { get, list, write, observeNetworkRequested, observeConsentExpired, status, sync, purge, clearPending, close };
}

function cancellationCode(signal: AbortSignal): string {
  return wrapError("kv", signal.reason).code === ErrorCodes.TIMEOUT ||
    (typeof signal.reason === "object" && signal.reason !== null && "code" in signal.reason && signal.reason.code === ErrorCodes.TIMEOUT)
    ? ErrorCodes.TIMEOUT
    : ErrorCodes.ABORTED;
}

function abortedResult(signal: AbortSignal): Result<never> {
  const code = cancellationCode(signal);
  return err(serviceError(code, code === ErrorCodes.TIMEOUT ? "KV request timed out" : "KV request was aborted", "kv"));
}
