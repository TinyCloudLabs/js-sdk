import { wrapError } from "../../errors";
import { ErrorCodes, err, ok, serviceError, type Result } from "../../types";
import type { KVGetOptions, KVListOptions, KVResponse } from "../types";
import { kvPrefixCovers, requiresSecretsOptIn } from "./scope";
import { classifyWriteOutcome } from "./outcome";
import { afterSync, begin, clearPending as clearPendingRecords, clearPrefix, pinnedKeys, settle } from "./pendingWrites";
import { localGet, type LocalGetResponse } from "./localResponse";
import { cursorRestart, decodeTcr1, listPathCovered, localList, utf8Compare } from "./listLocal";
import { emitEvent, type ReplicationEventInput } from "./events";
import type { KVListPage, KVReplicaHandle, KVReplicationController, LocalGetResult, LocalReplicaStatus, PendingWriteState, ReplicaDevice, ReplicationEvent, ReplicationReason, ReplicaStatusEntry, KVReplicationDeps, LocalSyncResult } from "./types";

const CLOSE_TIMEOUT_MS = 3_000;
interface Opened { handle?: KVReplicaHandle; opening?: Promise<KVReplicaHandle>; sync?: Promise<LocalSyncResult>; abort?: AbortController; mintAbort?: AbortController; timer?: () => void; lastError?: string; reason?: ReplicationReason; strategy?: "session" | "minted" | "installed"; retryAt?: number; failures?: number; unsupported?: boolean }
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
  const replicas = new Map<string, Opened>();
  let isClosed = false;
  let purgeStarted = false;
  let previous = deps.previous;
  let pinnedStateReported = false;
  const inProcessProof = new Set<string>();
  const emit = (event: ReplicationEventInput) => emitEvent(deps.emit, scheduler, event);
  const configuredPrefix = (path: string) => options.prefixes.find((prefix) => kvPrefixCovers(prefix, path));

  async function open(prefix: string): Promise<KVReplicaHandle> {
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
      const sessionGrant = authority.sessionGrant(prefix);
      const delegated = "refused" in sessionGrant ? undefined : sessionGrant;
      const plan = authority.sessionOnly ? undefined : authority.plan(prefix);
      let refusalCode: string | undefined;
      if ("refused" in sessionGrant) refusalCode = sessionGrant.refused;
      if (plan && "refused" in plan) refusalCode ??= plan.refused;
      let device: ReplicaDevice | undefined;
      if (delegated) { device = delegated.device; state!.strategy = "session"; }
      const spec = { identity, space: session.space, prefix, allowSecrets: options.allowSecrets, ...(device ? { device } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) };
      const handle = await storage.open(spec);
      state!.handle = handle;
      emit({ type: "replication.state", space: session.space, replica: prefix, state: "opened" });
      const runtimePlan = !authority.sessionOnly && plan && !("refused" in plan) ? plan : undefined;
      let installed = runtimePlan ? await handle.grant() : undefined;
      if (delegated) installed = await handle.installGrant(delegated.ucan);
      else if (runtimePlan) {
        if (!installed || !installed.unconstrained || installed.parentCid !== runtimePlan.parentCid || (installed.expiresAt !== null && runtimePlan.expiresAt > installed.expiresAt + 300_000)) {
          try {
            const mintAbort = new AbortController();
            state!.mintAbort = mintAbort;
            const minted = await authority.mint(handle.deviceDid, prefix, mintAbort.signal);
            installed = await handle.installGrant(minted.ucan);
            state!.strategy = "minted";
          } catch (error) { if (!installed?.unconstrained) throw error; }
          finally { state!.mintAbort = undefined; }
        }
        if (installed?.unconstrained) { state!.strategy ??= "installed"; state!.reason = undefined; }
      }
      if (!installed?.unconstrained) {
        state!.reason = "grant_missing";
        state!.lastError = refusalCode ?? "SESSION_LACKS_SYNC";
        emit({ type: "replication.state", space: session.space, replica: prefix, state: "grant_missing", code: state!.lastError });
      } else emit({ type: "replication.state", space: session.space, replica: prefix, state: "grant_installed", strategy: state!.strategy });
      if (isClosed || purgeStarted) {
        await handle.close();
        throw Object.assign(new Error("Replication controller is closed"), { code: "REPLICA_CLOSED" });
      }
      if (mode === "background" && state!.reason !== "grant_missing") {
        void syncPrefix(prefix, "start").catch(() => undefined);
        schedule(prefix);
      }
      return handle;
    })();
    try { return await state.opening; } catch (error) {
      const code = errorCode(error);
      state.reason = "replica_unavailable";
      state.lastError = code;
      state.failures = (state.failures ?? 0) + 1;
      if (code === "RUNTIME_UNSUPPORTED") state.unsupported = true;
      else if (code !== "REPLICA_CLOSED") state.retryAt = scheduler.now() + Math.min(300_000, 5_000 * 2 ** Math.min(state.failures - 1, 6));
      state.handle?.close().catch(() => undefined);
      state.handle = undefined;
      throw error;
    } finally { state.opening = undefined; }
  }

  function schedule(prefix: string): void {
    const state = replicas.get(prefix);
    if (!state || mode !== "background" || isClosed || purgeStarted) return;
    state.timer = scheduler.setTimeout(() => {
      state.timer = undefined;
      void syncPrefix(prefix, "interval").catch(() => undefined).finally(() => schedule(prefix));
    }, options.syncIntervalMs);
  }

  async function syncPrefix(prefix: string, trigger: "start" | "interval" | "stale_read" | "manual", signal?: AbortSignal): Promise<LocalSyncResult> {
    const handle = await open(prefix);
    const state = replicas.get(prefix)!;
    if (state.sync) return state.sync;
    const abort = new AbortController();
    state.abort = abort;
    const abortFromCaller = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const started = scheduler.now();
    let job!: Promise<LocalSyncResult>;
    job = (async () => {
      try {
        const syncStartEpoch = (await pending.read()).committedEpoch;
        const result = await handle.sync({ signal: abort.signal, syncStartEpoch });
        if (result.status === "busy") {
          emit({ type: "replication.sync", space: session.space, replica: prefix, trigger, outcome: "busy", durationMs: scheduler.now() - started, lagMs: null });
          return result;
        }
        inProcessProof.add(prefix);
        const snapshot = await pending.read();
        const clearedCandidates = snapshot.records.some((r) => r.state === "committed" && r.epoch !== null && r.epoch <= syncStartEpoch && kvPrefixCovers(prefix, r.key));
        const cleared = clearedCandidates ? await pending.update((s) => afterSync(s, prefix, syncStartEpoch)) : 0;
        emit({ type: "replication.sync", space: session.space, replica: prefix, trigger, outcome: "ok", durationMs: scheduler.now() - started, lagMs: null, pendingCleared: cleared, pages: result.pages, changes: result.changes, deleted: result.deleted, fetched: result.fetched, contentMissing: result.contentMissing, coverage: result.coverage });
        return result;
      } catch (error) {
        const code = errorCode(error); state.lastError = code;
        emit({ type: "replication.sync", space: session.space, replica: prefix, trigger, outcome: abort.signal.aborted ? "aborted" : "error", class: code === "NETWORK_ERROR" || code === "TIMEOUT" ? "offline" : "node", code, durationMs: scheduler.now() - started, lagMs: null });
        throw error;
      } finally { signal?.removeEventListener("abort", abortFromCaller); state.abort = undefined; }
    })();
    state.sync = job;
    try { return await job; } finally { if (state.sync === job) state.sync = undefined; }
  }
  async function drainForegroundSync(prefix: string, sync: Promise<LocalSyncResult>): Promise<void> {
    let cancel = () => {};
    const timeout = new Promise<"timeout">((resolve) => {
      cancel = scheduler.setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS);
    });
    try {
      if (await Promise.race([sync.then(() => "settled" as const, () => "settled" as const), timeout]) === "timeout") {
        emit({ type: "replication.sync", space: session.space, replica: prefix, trigger: "stale_read", outcome: "aborted", code: "DRAIN_TIMEOUT", durationMs: CLOSE_TIMEOUT_MS, lagMs: null });
      }
    } finally { cancel(); }
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
      const abortFromCaller = () => syncController?.abort(signal.reason);
      if (syncController) signal.addEventListener("abort", abortFromCaller, { once: true });
      let timedOut = false;
      let cancelTimeout = () => {};
      const timeout = new Promise<{ timeout: true }>((resolve) => {
        cancelTimeout = scheduler.setTimeout(() => {
          timedOut = true;
          syncController?.abort(Object.assign(new Error("Stale-read sync timed out"), { code: "TIMEOUT" }));
          resolve({ timeout: true });
        }, options.staleSyncTimeoutMs);
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
      const sync = syncPrefix(prefix, "stale_read", syncController?.signal);
      const outcome = await Promise.race([
        sync.then((result) => ({ result }), (error: unknown) => ({ error })),
        timeout,
        callerAbort,
      ]);
      cancelTimeout();
      cancelAbort();
      signal.removeEventListener("abort", abortFromCaller);
      if ("callerAborted" in outcome) {
        if (syncController) {
          syncController.abort(signal.reason);
          await drainForegroundSync(prefix, sync);
        }
        return { status: currentStatus, syncedBeforeRead: false, syncError: cancellationCode(signal) };
      }
      if ("timeout" in outcome) {
        if (syncController) await drainForegroundSync(prefix, sync);
        return { status: currentStatus, syncedBeforeRead: false, syncError: "TIMEOUT" };
      }
      if ("error" in outcome) {
        const code = errorCode(outcome.error);
        if (code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "ABORTED") return { status: currentStatus, syncedBeforeRead: false, syncError: timedOut ? "TIMEOUT" : code };
        return { status: currentStatus, syncedBeforeRead: false, syncError: code, failure: "error" };
      }
      if (outcome.result.status === "busy") return { status: currentStatus, syncedBeforeRead: false, failure: "busy" };
      currentStatus = await handle.status();
      return { status: currentStatus, syncedBeforeRead: true };
    }
    return { status: currentStatus, syncedBeforeRead: false };
  }

  function readEvent(op: "get" | "list", path: string, prefix: string | null, source: "replica" | "network" | "none", reason: ReplicationReason, outcome: "found" | "not_found" | "error", started: number, extra: Partial<Extract<ReplicationEvent, { type: "replication.read" }>> = {}): void {
    emit({ type: "replication.read", op, space: session.space, key: path, replica: prefix, source, reason, outcome, latencyMs: scheduler.now() - started, stalenessMs: null, coverage: null, authority: null, ...extra });
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
    if (!prefix) { const value = await r.network(); readEvent("get", r.path, null, "network", "not_covered", value.ok ? "found" : value.error.code === ErrorCodes.KV_NOT_FOUND ? "not_found" : "error", started); return value; }
    try { await raceSignal(reportExistingPins(), r.signal); } catch { if (r.signal.aborted) return abortedResult(r.signal); }
    let handle: KVReplicaHandle;
    try { handle = await raceSignal(open(prefix), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      const value = await r.network(); readEvent("get", r.path, prefix, "network", errorCode(error) === "RUNTIME_UNSUPPORTED" ? "runtime_unsupported" : "replica_unavailable", value.ok ? "found" : "error", started, { code: errorCode(error) }); return value;
    }
    if (replicas.get(prefix)?.reason === "grant_missing") { const value = await r.network(); readEvent("get", r.path, prefix, "network", "grant_missing", value.ok ? "found" : "error", started, { code: replicas.get(prefix)?.lastError }); return value; }

    let fresh: Awaited<ReturnType<typeof freshness>>;
    try { fresh = await freshness(prefix, handle, r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      const value = await r.network();
      readEvent("get", r.path, prefix, "network", "replica_error", value.ok ? "found" : "error", started, { code: errorCode(error) });
      return value;
    }
    if (r.signal.aborted) return abortedResult(r.signal);
    if (fresh.syncError === ErrorCodes.TIMEOUT) return err(serviceError(ErrorCodes.TIMEOUT, "KV request timed out", "kv"));
    if (fresh.failure) { const value = await r.network(); readEvent("get", r.path, prefix, "network", fresh.failure === "busy" ? "stale" : "stale", value.ok ? "found" : "error", started, { code: fresh.failure === "busy" ? "REPLICA_BUSY" : fresh.syncError, syncedBeforeRead: fresh.syncedBeforeRead }); return value; }
    let pendingState: PendingWriteState;
    try { pendingState = await raceSignal(pending.read(), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      const value = await r.network();
      readEvent("get", r.path, prefix, "network", "replica_unavailable", value.ok ? "found" : "error", started, { code: errorCode(error) });
      return value;
    }
    const record = pendingState.records.find((x) => x.key === r.path);
    if (record) { const value = await r.network(); readEvent("get", r.path, prefix, "network", "pending_write", value.ok ? "found" : value.error.code === ErrorCodes.KV_NOT_FOUND ? "not_found" : "error", started, { pendingState: record.state, syncedBeforeRead: fresh.syncedBeforeRead }); return value; }
    if (!pending.durable && !inProcessProof.has(prefix)) { const value = await r.network(); readEvent("get", r.path, prefix, "network", "REPLICA_UNPROVEN_SINCE_START", value.ok ? "found" : "error", started); return value; }
    if (fresh.status.syncedThroughEpoch < pendingState.committedEpoch) { const value = await r.network(); readEvent("get", r.path, prefix, "network", "REPLICA_BEHIND_OWN_WRITES", value.ok ? "found" : "error", started); return value; }
    if (fresh.status.authority.state !== "valid") { const value = await r.network(); readEvent("get", r.path, prefix, "network", fresh.status.authority.state === "expired" ? "grant_expired" : fresh.status.authority.state === "revoked" ? "grant_revoked" : "grant_not_yet_valid", value.ok ? "found" : "error", started); return value; }
    if (fresh.status.coverage !== "complete") { const value = await r.network(); readEvent("get", r.path, prefix, "network", "coverage_incomplete", value.ok ? "found" : "error", started); return value; }
    try {
      const local = await raceSignal(handle.get(r.path), r.signal);
      if (local.status === "coverage_incomplete" || local.status === "not_covered" || local.status === "content_missing") { const value = await r.network(); readEvent("get", r.path, prefix, "network", local.status === "content_missing" ? "content_missing" : local.status === "coverage_incomplete" ? "coverage_incomplete" : "not_covered", value.ok ? "found" : "error", started); return value; }
      if (local.status === "present" && r.options?.maxResponseBytes !== undefined && local.value.byteLength > r.options.maxResponseBytes) {
        const value = await r.network();
        readEvent("get", r.path, prefix, "network", "unsupported_option", value.ok ? "found" : "error", started);
        return value;
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
      if (r.signal.aborted) return abortedResult(r.signal);
      const value = await r.network();
      readEvent("get", r.path, prefix, "network", "replica_error", value.ok ? "found" : "error", started, { code: errorCode(error) });
      return value;
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
    if (cursor && !cursor.startsWith("tcr1.")) { const result = await r.network(); readEvent("list", r.listPath, null, "network", "network_cursor", result.ok ? "found" : "error", started); return result; }
    try { await raceSignal(reportExistingPins(), r.signal); } catch { if (r.signal.aborted) return abortedResult(r.signal); }
    const prefix = listPathCovered(options.prefixes, r.listPath);
    const restart = () => { readEvent("list", r.listPath, prefix ?? null, "none", "cursor_restart", "error", started); return cursorRestart(); };
    if (cursor && decoded && (decoded.space !== r.space || decoded.path !== r.listPath)) return restart();
    if (!prefix || !r.listPath || r.options?.raw) { if (cursor && decoded) return restart(); const result = await r.network(); readEvent("list", r.listPath, prefix ?? null, "network", prefix ? "unsupported_option" : "not_covered", result.ok ? "found" : "error", started); return result; }
    let handle: KVReplicaHandle;
    try { handle = await raceSignal(open(prefix), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      if (cursor && decoded) return restart();
      const result = await r.network();
      readEvent("list", r.listPath, prefix, "network", errorCode(error) === "RUNTIME_UNSUPPORTED" ? "runtime_unsupported" : "replica_unavailable", result.ok ? "found" : "error", started, { code: errorCode(error) });
      return result;
    }
    if (replicas.get(prefix)?.reason === "grant_missing") { if (cursor && decoded) return restart(); const result = await r.network(); readEvent("list", r.listPath, prefix, "network", "grant_missing", result.ok ? "found" : "error", started); return result; }
    let fresh: Awaited<ReturnType<typeof freshness>>;
    try { fresh = await freshness(prefix, handle, r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      if (cursor && decoded) return restart();
      const result = await r.network();
      readEvent("list", r.listPath, prefix, "network", "replica_error", result.ok ? "found" : "error", started, { code: errorCode(error) });
      return result;
    }
    if (r.signal.aborted) return abortedResult(r.signal);
    if (fresh.syncError === ErrorCodes.TIMEOUT) return err(serviceError(ErrorCodes.TIMEOUT, "KV request timed out", "kv"));
    let state: PendingWriteState;
    try { state = await raceSignal(pending.read(), r.signal); }
    catch (error) {
      if (r.signal.aborted) return abortedResult(r.signal);
      if (cursor && decoded) return restart();
      const result = await r.network();
      readEvent("list", r.listPath, prefix, "network", "replica_unavailable", result.ok ? "found" : "error", started, { code: errorCode(error) });
      return result;
    }
    const pendingRange = state.records.find((record) => kvPrefixCovers(r.listPath, record.key) && (!decoded || utf8Compare(record.key, decoded.last) > 0));
    const behind = fresh.status.syncedThroughEpoch < state.committedEpoch;
    if (cursor && decoded && (fresh.failure || pendingRange || behind || fresh.status.coverage !== "complete" || fresh.status.authority.state !== "valid" || (!pending.durable && !inProcessProof.has(prefix)))) return restart();
    if (fresh.failure) { const result = await r.network(); readEvent("list", r.listPath, prefix, "network", "stale", result.ok ? "found" : "error", started, { code: fresh.failure === "busy" ? "REPLICA_BUSY" : fresh.syncError }); return result; }
    if (pendingRange) { const result = await r.network(); readEvent("list", r.listPath, prefix, "network", "pending_write", result.ok ? "found" : "error", started, { pendingState: pendingRange.state }); return result; }
    if (!pending.durable && !inProcessProof.has(prefix)) { const result = await r.network(); readEvent("list", r.listPath, prefix, "network", "REPLICA_UNPROVEN_SINCE_START", result.ok ? "found" : "error", started); return result; }
    if (behind) { const result = await r.network(); readEvent("list", r.listPath, prefix, "network", "REPLICA_BEHIND_OWN_WRITES", result.ok ? "found" : "error", started); return result; }
    if (fresh.status.coverage !== "complete" || fresh.status.authority.state !== "valid") { const result = await r.network(); readEvent("list", r.listPath, prefix, "network", "coverage_incomplete", result.ok ? "found" : "error", started); return result; }
    try {
      const signalHandle = { list: (o: { prefix: string; after?: string; limit?: number }) => raceSignal(handle.list(o), r.signal) };
      const page = await raceSignal(localList(signalHandle, r.space, r.listPath, r.options?.limit, cursor), r.signal);
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
      if (r.signal.aborted) return abortedResult(r.signal);
      if (cursor && decoded) return restart();
      const result = await r.network();
      readEvent("list", r.listPath, prefix, "network", "replica_error", result.ok ? "found" : "error", started, { code: errorCode(error) });
      return result;
    }
  }

  async function write<T>(r: { op: "put" | "delete" | "batchPut"; space: string; entries: ReadonlyArray<{ path: string; body?: Blob | string }>; signal: AbortSignal; network: () => Promise<Result<T>> }): Promise<Result<T>> {
    const covered = r.entries.flatMap((entry) => {
      const prefix = configuredPrefix(entry.path);
      return prefix ? [{ key: entry.path, op: r.op === "delete" ? "delete" as const : "put" as const }] : [];
    });
    if (covered.length === 0) return r.network();
    await reportExistingPins();
    const opId = globalThis.crypto?.randomUUID?.() ?? `${scheduler.now()}-${Math.random()}`;
    try { await pending.update((s) => begin(s, opId, covered, nowDate(scheduler.now()))); }
    catch (error) { return err(serviceError(ErrorCodes.KV_WRITE_FAILED, "Unable to persist pending KV write; request was not dispatched", "kv", { cause: error instanceof Error ? error : undefined, meta: { replication: "pending_store_unavailable", requestDispatched: false } })); }
    const started = scheduler.now();
    let result: Result<T>;
    try { result = await r.network(); }
    catch (error) {
      result = err(serviceError(ErrorCodes.NETWORK_ERROR, "KV write request failed after dispatch status became unknown", "kv", {
        cause: error instanceof Error ? error : undefined,
        meta: { requestMayHaveDispatched: true },
      }));
    }
    const outcome = classifyWriteOutcome(r.op, result);
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

  async function status(): Promise<ReplicaStatusEntry[]> {
    const snapshot = await pending.read();
    return Promise.all(options.prefixes.map(async (prefix) => {
      const state = replicas.get(prefix);
      const records = snapshot.records.filter((r) => kvPrefixCovers(prefix, r.key));
      let local;
      if (state?.handle) { try { local = await state.handle.status(); } catch { /* status is best-effort */ } }
      return { prefix, state: isClosed ? "closed" as const : local?.authority.state === "revoked" ? "revoked" as const : state?.reason === "grant_missing" ? "grant_missing" as const : local?.authority.state === "valid" ? "ready" as const : state?.reason ? "unavailable" as const : "idle" as const, ...(state?.reason ? { reason: state.reason } : {}), ...(local ?? {}), pending: { inFlight: records.filter((r) => r.state === "in_flight").length, committed: records.filter((r) => r.state === "committed").length, ambiguous: records.filter((r) => r.state === "ambiguous").length }, pinned: pinnedKeys(snapshot, prefix, scheduler.now()), lagMs: local?.lastSyncAt ? scheduler.now() - Date.parse(local.lastSyncAt) : null };
    }));
  }

  async function sync(o?: { prefix?: string; signal?: AbortSignal }): Promise<void> {
    const prefixes = o?.prefix ? options.prefixes.filter((p) => p === o.prefix) : options.prefixes;
    await Promise.all(prefixes.map((prefix) => syncPrefix(prefix, "manual", o?.signal).then(() => undefined)));
  }

  async function clearPending(): Promise<number> {
    const count = await pending.update((s) => clearPendingRecords(s, scheduler.now()));
    emit({ type: "replication.state", space: session.space, state: "pending_cleared", count });
    return count;
  }

  function purge(o?: { timeoutMs?: number }): Promise<{ purged: string[]; failed: Array<{ prefix: string; code: string }> }> {
    purgeStarted = true;
    for (const state of replicas.values()) {
      state.timer?.();
      state.timer = undefined;
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
      const drain = Promise.all([...replicas.values()].flatMap((state) => [
        state.opening?.catch(() => undefined),
        state.sync?.catch(() => undefined),
        state.handle?.close().catch(() => undefined),
      ]));
      let drainCode: string | undefined;
      try { await withTimeout(drain); } catch (error) { drainCode = errorCode(error); }
      const jobs = options.prefixes.map(async (prefix) => {
        try {
          if (drainCode) throw Object.assign(new Error("Replica cleanup did not settle before purge"), { code: drainCode });
          const grant = authority.sessionGrant(prefix);
          const sessionDeviceDid = replicas.get(prefix)?.handle?.deviceDid ?? ("refused" in grant ? undefined : grant.device.did);
          await withTimeout(storage.purge({ identity, space: session.space, prefix, ...(sessionDeviceDid ? { sessionDeviceDid } : {}) }));
          await pending.update((s) => clearPrefix(s, prefix));
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
    });
  }

  async function close(): Promise<void> {
    if (isClosed) return;
    isClosed = true;
    for (const [prefix, state] of replicas) {
      state.timer?.();
      state.timer = undefined;
      state.mintAbort?.abort();
      state.abort?.abort();
      emit({ type: "replication.state", space: session.space, replica: prefix, state: "closed" });
    }
    const drain = Promise.all([...replicas.values()].map(async (state) => {
      await state.opening?.catch(() => undefined);
      await state.sync?.catch(() => undefined);
      await state.handle?.close().catch(() => undefined);
    }));
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

  return { get, list, write, observeNetworkRequested, status, sync, purge, clearPending, close };
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
