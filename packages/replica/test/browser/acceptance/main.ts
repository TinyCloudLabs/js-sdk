/**
 * TC-858 acceptance fixture. The page's whole API is `window.__tcw`, driven by
 * the Playwright suite the way an app drives `TinyCloudWeb`: sign in through a
 * test EIP-1193 provider backed by a throwaway key, read through the replica,
 * sign out. No grant injection: the SDK's own session and grant flow run.
 */
import { TinyCloudWeb, registerBrowserReplica } from "@tinycloud/web-sdk";
import type { PendingWriteStore, ReplicaSessionStamp, ReplicationIdentity } from "@tinycloud/sdk-services/kv/replication";
import { privateKeyToAccount } from "viem/accounts";
import { testWallet, walletCounter } from "./wallet";
import { replicationStorage, replicationHooks } from "./storage";

type BootOptions = {
  /** TinyCloud node origin, e.g. http://127.0.0.1:8123. */
  host: string;
  /** Throwaway wallet key; never a real identity. */
  walletKey: string;
  prefix: string;
  /**
   * "on": replication enabled (the replica plugin is imported on demand).
   * "unset": no `replication` option at all. "disabled": `{ enabled: false }`.
   * Neither off mode imports any replica code.
   */
  replication: "on" | "unset" | "disabled";
  allowSecrets?: boolean;
  grantTtlMs?: number;
  maxStalenessMs?: number;
};

const statusEl = document.getElementById("status");
const setStatus = (text: string) => {
  if (statusEl !== null) statusEl.textContent = text;
};

let tcw: TinyCloudWeb | null = null;
/** Sink for `ReplicationOptions.onEvent`; cleared on each boot. */
const replicationEventLog: unknown[] = [];
/** The actual pending store obtained during this tab's bind, retaining its original session stamp. */
let capturedPending: PendingWriteStore | undefined;
let pluginRegistered = false;
let walletAddress: string | undefined;

/** The replica surface S2 adds as `tcw.replication`. Narrowed at runtime. */
type ReplicationCall = (...args: unknown[]) => Promise<unknown>;

function replicationMethod(instance: TinyCloudWeb, name: string): ReplicationCall | undefined {
  if (!("replication" in instance)) return undefined;
  const surface: unknown = instance.replication;
  if (typeof surface !== "object" || surface === null) return undefined;
  const method: unknown = Reflect.get(surface, name);
  if (typeof method !== "function") return undefined;
  return async (...args: unknown[]) => method.apply(surface, args);
}

function requireTcw(): TinyCloudWeb {
  if (tcw === null) throw new Error("fixture not booted");
  return tcw;
}

function requireReplication(name: string): ReplicationCall {
  const method = replicationMethod(requireTcw(), name);
  if (method === undefined) throw new Error(`tcw.replication.${name} not available`);
  return method;
}

const api = {
  async boot(options: BootOptions): Promise<{ replicationPresent: boolean }> {
    const base = {
      provider: testWallet(options.walletKey),
      tinycloudHosts: [options.host],
      tinycloudRegistryUrl: null,
      autoDiscoverLocalNode: false,
      autoCreateSpace: true,
      persistSession: true,
      sessionStorageKeyPrefix: "tc858-acceptance",
    };
    capturedPending = undefined;
    replicationEventLog.length = 0;
    walletAddress = privateKeyToAccount(options.walletKey as `0x${string}`).address;
    let replicationOptions: Record<string, unknown> = {};
    if (options.replication === "on") {
      // Replica code is loaded only when replication is requested, so the off modes
      // fetch no replica chunk and register no plugin.
      const { browserReplicaPlugin } = await import("@tinycloud/web-sdk/replica");
      if (!pluginRegistered) {
        registerBrowserReplica(browserReplicaPlugin);
        pluginRegistered = true;
      }
      const storage = await replicationStorage();
      const observedStorage = new Proxy(storage, {
        get(target, property) {
          if (property === "pendingWrites" && target.pendingWrites !== undefined) {
            return (identity: ReplicationIdentity, options?: { stamp?: ReplicaSessionStamp }) => {
              const pending = target.pendingWrites!(identity, options);
              capturedPending = pending;
              return pending;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      replicationOptions = {
        replication: {
          enabled: true,
          prefixes: [options.prefix],
          storage: observedStorage,
          allowSecrets: options.allowSecrets === true,
          ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs }),
          ...(options.maxStalenessMs === undefined ? {} : { maxStalenessMs: options.maxStalenessMs }),
          onEvent: (event: unknown) => {
            replicationEventLog.push(event);
          },
        },
      };
    } else if (options.replication === "disabled") {
      replicationOptions = { replication: { enabled: false, prefixes: [options.prefix] } };
    }
    tcw = await TinyCloudWeb.create({ ...base, ...replicationOptions });
    return { replicationPresent: replicationMethod(tcw, "sync") !== undefined };
  },

  async signIn(): Promise<{ address: string }> {
    const session = await requireTcw().signIn();
    return { address: session.address };
  },

  async signOut(): Promise<void> {
    await requireTcw().signOut();
  },

  walletRequests: () => walletCounter.requests,

  /**
   * Read through `tcw.kv.get`, exactly as an app would. `source: "network"` is the public
   * bypass (`KVGetOptions.source`). The read source itself is reported by `replication.read`
   * events in `replicationEvents()`, not by the return value.
   */
  async kvGet(
    key: string,
    options: { source?: "network" } = {},
  ): Promise<{ status: "present"; value: string } | { status: "error"; code: string }> {
    const result = await requireTcw().kv.get<string>(key, options);
    if (!result.ok) return { status: "error", code: result.error.code };
    return { status: "present", value: result.data.data };
  },

  replicationStatus: () => requireReplication("status")(),
  /** A failed sync is data for the scenario, not an exception: it reports the error code. */
  async replicationSync(): Promise<{ status: "ok" } | { status: "error"; code: string; message: string }> {
    try {
      await requireReplication("sync")();
      return { status: "ok" };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "ERROR";
      return { status: "error", code, message: error instanceof Error ? error.message : String(error) };
    }
  },
  /** Restore the persisted session (what an app does on load), without a wallet prompt. */
  async restoreSession(): Promise<{ status: string }> {
    if (walletAddress === undefined) throw new Error("fixture not booted");
    const restored = await requireTcw().restoreSession(walletAddress);
    return { status: restored.status };
  },
  /** Which replica keys exist (presence only, never material). */
  keyPresence: () => replicationHooks.keyPresence(),
  /** Row counts per object store of the replica database. */
  replicaRows: () => replicationHooks.rows(),
  /** Every `replication.*` event since the last boot, in emission order. Read source is `replication.read`. */
  replicationEvents: (): unknown[] => replicationEventLog.slice(),
  /** Test-only: wait for deny intents to finish erasing before probing the old store. */
  async pendingPurgeCount(): Promise<number> {
    return (await replicationHooks.pendingPurge()).length;
  },
  /** Test-only: attempt an update through the store captured under this tab's original stamp. */
  async stalePendingUpdate(key: string) {
    if (capturedPending === undefined) throw new Error("no pending store was bound to this tab");
    try {
      await capturedPending.update((state) => {
        const at = new Date().toISOString();
        state.records.push({
          opId: key, seq: ++state.seq, key, op: "put", state: "ambiguous", epoch: null, at, settledAt: at,
        });
      });
      return { status: "updated" as const };
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") throw error;
      return {
        status: "error" as const, code: error.code,
        ...("gate" in error && typeof error.gate === "string" ? { gate: error.gate } : {}),
      };
    }
  },
  /** Every erase transaction fails from now on (this page load only): sign-out leaves a purge intent. */
  injectEraseFailure: () => replicationHooks.failErases(),
  /** Fail one deny step once (`@tinycloud/replica/kv-storage/testing`). */
  injectDenyFailure: (plan: { stage: "deny_tx" | "delete_database"; once?: boolean }) =>
    replicationHooks.failDeny(plan.stage, plan.once ?? true),
  /** Terminate the replica worker as a crash would; the next call respawns it. */
  killReplicaWorker: () => replicationHooks.killWorker(),
  /** Read through `tcw.kv.list`, as an app would. */
  async kvList(prefix: string): Promise<{ status: "present"; keys: string[] } | { status: "error"; code: string }> {
    const result = await requireTcw().kv.list({ prefix });
    if (!result.ok) return { status: "error", code: result.error.code };
    return { status: "present", keys: result.data.keys };
  },
};

declare global {
  interface Window {
    __tcw: typeof api;
  }
}

window.__tcw = api;
setStatus("ready");
