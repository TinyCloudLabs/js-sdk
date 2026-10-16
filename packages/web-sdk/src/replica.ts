import { parsePkhDid, type ReplicationEvent } from "@tinycloud/sdk-core";
import type { TinyCloudNodeConfig } from "@tinycloud/node-sdk/core";
import { assertValidReplicationConfig } from "@tinycloud/node-sdk/replication/authority";
import type { BrowserWalletSigner } from "./adapters/BrowserWalletSigner";
import type { BrowserReplicaPlugin } from "./modules/tcw";

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

  const abort = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout>;
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
  const recovery = (async () => lifecycle.recover({ signal: abort.signal }))().catch(() => null);
  void recovery.then((result) => {
    if (timedOut && (!result || result.failed.length > 0 || result.remaining > 0)) {
      unavailable(result?.failed[0]?.code ?? (result ? "RECOVERY_INCOMPLETE" : "STORAGE_ERROR"), result?.remaining);
    }
  });
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abort.abort();
      resolve(null);
    }, 3_000);
  });
  const report = await Promise.race([recovery, timeout]);
  clearTimeout(timeoutId!);
  let admitted = report !== null && report.failed.length === 0 && report.remaining === 0;
  if (!admitted) unavailable(report?.failed[0]?.code ?? (timedOut ? "RECOVERY_TIMEOUT" : "STORAGE_ERROR"), report?.remaining);

  // Keep the real deny/erase/recovery methods: signOut must still shred keys.
  // Only stamp admission and local delivery require a proven current wallet.
  let walletPrincipal: string | undefined;
  let walletSequence = 0;
  let walletGate: "gate_unavailable" | "principal_mismatch" = "gate_unavailable";
  const gatedError = () => Object.assign(new Error("Replica wallet or startup recovery is unavailable."), {
    code: "REPLICA_GATED" as const, gate: admitted ? walletGate : "gate_unavailable" as const,
  });
  const refuse = () => Promise.reject(gatedError());
  const throwRefusal = () => { throw gatedError(); };
  const matchesWallet = async (principal: string): Promise<boolean> => {
    const address = parsePkhDid(principal)?.address;
    const connected = await signer?.getConnectedAddress().catch(() => undefined);
    walletGate = connected ? "principal_mismatch" : "gate_unavailable";
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
      if (property === "recover") return async (input: { signal: AbortSignal }) => {
        const result = await target.recover(input);
        admitted = result.failed.length === 0 && result.remaining === 0;
        if (!admitted) {
          walletPrincipal = undefined;
          walletSequence++;
        }
        return result;
      };
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

/** Runtime loader callbacks let the root-owned registry activate replica only after opt-in. */
export const browserReplicaPlugin: BrowserReplicaPlugin = {
  validateConfig: assertValidReplicationConfig,
  loaders: {
    runtime: () => import("@tinycloud/node-sdk/replication/runtime"),
    authority: () => import("@tinycloud/node-sdk/replication/authority"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  },
  recover: recoveredBrowserReplication,
};
