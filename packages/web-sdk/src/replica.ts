import { parsePkhDid, type ReplicationEvent } from "@tinycloud/sdk-core";
import type { TinyCloudNodeConfig } from "@tinycloud/node-sdk/core";
import { assertValidReplicationConfig } from "@tinycloud/node-sdk/replication/authority";
import type { BrowserWalletSigner } from "./adapters/BrowserWalletSigner";
import type { BrowserReplicaPlugin } from "./modules/replica-wiring";

/** Static import cannot serve CJS: @tinycloud/replica/kv-storage exposes only an ESM entry. */
export async function loadIndexedDbReplicaStorage() {
  const { indexedDbReplicaStorage } = await import("@tinycloud/replica/kv-storage");
  return indexedDbReplicaStorage;
}

/** Replica recovery and wallet matching gate only local authority, never network auth. */
async function recoveredBrowserReplication(
  replication: NonNullable<TinyCloudNodeConfig["replication"]>,
  signer?: BrowserWalletSigner,
): Promise<NonNullable<TinyCloudNodeConfig["replication"]>> {
  const storage = replication.storage;
  const lifecycle = storage.kind === "indexeddb" ? storage.lifecycle : undefined;
  if (lifecycle?.kind !== "indexeddb") return replication;

  const unavailable = (code: string, remaining?: number): void => {
    try {
      const event: Extract<ReplicationEvent, { type: "replication.lifecycle" }> = {
        type: "replication.lifecycle", at: new Date().toISOString(), action: "unguarded",
        reason: "startup", gate: "gate_unavailable", code,
      };
      if (remaining !== undefined) event.remaining = remaining;
      replication.onEvent?.(event);
    } catch { /* Observability cannot prevent a network session. */ }
  };
  type Report = Awaited<ReturnType<typeof lifecycle.recover>>;
  const clean = (report: Report | null) => report !== null && report.failed.length === 0 && report.remaining === 0;
  // Every recovery wait has the same 3 s bound. web-sdk's TypeScript lib predates Promise.withResolvers.
  const bounded = (pending: Promise<unknown>, abort?: AbortController): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      pending.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(() => { abort?.abort(); resolve(); }, 3_000); }),
    ]).finally(() => clearTimeout(timer));
  };

  // Keep the real deny/erase/recovery methods: signOut must still shred keys.
  // Only stamp admission and local delivery require a proven current wallet.
  let admitted = false;
  let walletPrincipal: string | undefined;
  let walletSequence = 0;
  let recoveryRetries = 0;
  // No wallet provider is a distinct, typed refusal: restore with replication configured needs one.
  let walletGate: "gate_unavailable" | "principal_mismatch" | "wallet_provider_required" =
    signer === undefined ? "wallet_provider_required" : "gate_unavailable";
  /** The only admit path: a fresh recovery report under the origin gate lock. */
  const recoverAndAdmit = async (input: { signal: AbortSignal }): Promise<Report> => {
    const result = await lifecycle.recover(input);
    admitted = clean(result);
    if (!admitted) {
      walletPrincipal = undefined;
      walletSequence++;
    }
    return result;
  };
  const freshAdmission = (): Promise<void> => {
    const abort = new AbortController();
    return bounded(recoverAndAdmit({ signal: abort.signal }), abort);
  };
  // At most one recovery runs at a time; admission waits for it instead of racing it for the lock.
  let pendingRecovery: Promise<unknown> | undefined;
  const runRecovery = (work: () => Promise<unknown>): Promise<unknown> => {
    const running: Promise<unknown> = work().catch(() => undefined).finally(() => {
      if (pendingRecovery === running) pendingRecovery = undefined;
    });
    pendingRecovery = running;
    return running;
  };

  const abort = new AbortController();
  let timedOut = false;
  let report = undefined as Report | null | undefined;
  const startup = (async () => lifecycle.recover({ signal: abort.signal }))().catch(() => null)
    .then((result) => (report = result));
  // A startup recovery that outlives its bound holds the gate lock. If it later finishes cleanly,
  // one fresh gated recovery decides admission; the late report itself never admits.
  void runRecovery(async () => {
    const result = await startup;
    if (!timedOut) return;
    if (clean(result)) await freshAdmission();
    else unavailable(result?.failed[0]?.code ?? (result ? "RECOVERY_INCOMPLETE" : "STORAGE_ERROR"), result?.remaining);
  });
  await bounded(startup, abort);
  timedOut = report === undefined;
  if (report) admitted = clean(report);
  if (!admitted) unavailable(report?.failed[0]?.code ?? (timedOut ? "RECOVERY_TIMEOUT" : "STORAGE_ERROR"), report?.remaining);

  const gatedError = () => Object.assign(new Error("Replica wallet or startup recovery is unavailable."), {
    code: "REPLICA_GATED" as const, gate: admitted ? walletGate : "gate_unavailable" as const,
  });
  const refuse = () => Promise.reject(gatedError());
  const throwRefusal = () => { throw gatedError(); };
  const matchesWallet = async (principal: string): Promise<boolean> => {
    const address = parsePkhDid(principal)?.address;
    const connected = await signer?.getConnectedAddress().catch(() => undefined);
    walletGate = signer === undefined ? "wallet_provider_required" : connected ? "principal_mismatch" : "gate_unavailable";
    return address !== undefined && connected !== undefined &&
      address.toLowerCase() === connected.toLowerCase();
  };
  const verifyWallet = async (): Promise<void> => {
    const principal = walletPrincipal;
    if (!admitted || !principal) throw gatedError();
    if (!(await matchesWallet(principal)) || walletPrincipal !== principal) {
      walletPrincipal = undefined;
      throw gatedError();
    }
  };
  const admitStamp = async <T>(principal: string, action: () => Promise<T>): Promise<T> => {
    const sequence = ++walletSequence;
    walletPrincipal = undefined;
    // Waiting on a recovery that is still running (including a startup that outlived its bound)
    // spends no retry. Otherwise a failed recovery is re-run, at most twice per page; only a clean
    // fresh report admits, and failure still refuses below.
    if (!admitted && pendingRecovery) await bounded(pendingRecovery);
    if (!admitted && !pendingRecovery && recoveryRetries < 2) {
      recoveryRetries++;
      await runRecovery(freshAdmission);
    }
    if (!admitted || !(await matchesWallet(principal)) || sequence !== walletSequence) throw gatedError();
    const stamp = await action();
    if (sequence !== walletSequence) throw gatedError();
    walletPrincipal = principal;
    await verifyWallet();
    if (sequence !== walletSequence) throw gatedError();
    return stamp;
  };
  const forward = (target: object, property: PropertyKey, cache: Map<PropertyKey, unknown>): unknown => {
    if (cache.has(property)) return cache.get(property);
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    const bound = value.bind(target);
    cache.set(property, bound);
    return bound;
  };
  const lifecycleMethods = new Map<PropertyKey, unknown>();
  const guardedLifecycle = new Proxy(lifecycle, {
    get(target, property) {
      if (property === "recover") return recoverAndAdmit;
      if (property === "establishSessionStamp") return (...args: Parameters<typeof target.establishSessionStamp>) =>
        admitStamp(args[0], () => target.establishSessionStamp(...args));
      if (property === "restoreSessionStamp") return (...args: Parameters<typeof target.restoreSessionStamp>) =>
        admitStamp(args[0], () => target.restoreSessionStamp(...args));
      if (property === "deny") return (...args: Parameters<typeof target.deny>) => {
        walletSequence++;
        walletPrincipal = undefined;
        return target.deny(...args);
      };
      if (!admitted || !walletPrincipal) {
        if (property === "activationAllowed") return () => Promise.resolve(false);
        if (property === "checkDelivery") return () => ({ status: "gated", gate: admitted ? walletGate : "gate_unavailable" });
        if (property === "deliverable") return () => false;
        if (property === "consentDeadline") return () => null;
      }
      return forward(target, property, lifecycleMethods);
    },
  });
  const storageMethods = new Map<PropertyKey, unknown>();
  const guardedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === "lifecycle") return guardedLifecycle;
      if (property === "open") return async (...args: Parameters<typeof target.open>) => {
        await verifyWallet();
        const handle = await target.open(...args);
        try { await verifyWallet(); }
        catch (error) { await handle.close().catch(() => undefined); throw error; }
        const handleMethods = new Map<PropertyKey, unknown>();
        const guardedGet = async (...input: Parameters<typeof handle.get>) => {
          await verifyWallet();
          const result = await handle.get(...input);
          await verifyWallet();
          return result;
        };
        const guardedList = async (...input: Parameters<typeof handle.list>) => {
          await verifyWallet();
          const result = await handle.list(...input);
          await verifyWallet();
          return result;
        };
        return new Proxy(handle, {
          get(current, method) {
            if (method === "get") return guardedGet;
            if (method === "list") return guardedList;
            return forward(current, method, handleMethods);
          },
        });
      };
      if (!admitted || !walletPrincipal) {
        if (property === "inspectStatus") return refuse;
        if (property === "pendingWrites") return throwRefusal;
      }
      return forward(target, property, storageMethods);
    },
  });
  return { ...replication, storage: guardedStorage };
}

/**
 * Runtime loader callbacks let the root-owned registry activate replica only after opt-in. Frozen:
 * a same-realm import cannot swap the recovery guard or a loader.
 */
const validateConfig = assertValidReplicationConfig;
export const browserReplicaPlugin: BrowserReplicaPlugin = Object.freeze({
  validateConfig,
  loaders: Object.freeze({
    validateConfig,
    runtime: () => import("@tinycloud/node-sdk/replication/runtime"),
    authority: () => import("@tinycloud/node-sdk/replication/authority"),
    gatedNetwork: () => import("./replica-gated"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  }),
  recover: recoveredBrowserReplication,
});
