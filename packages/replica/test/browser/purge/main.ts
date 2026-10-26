/**
 * TC-1888 fixture. The page's whole API is `window.__purge`, driven by the Playwright suite the way an
 * app drives `TinyCloudWeb`: real sign-in through a throwaway EIP-1193 wallet, real replica storage and
 * lifecycle, real IndexedDB. The wallet can be absent (`none`) or read-only (`readonly`) to exercise restore.
 */
import { TinyCloudWeb, registerBrowserReplica } from "@tinycloud/web-sdk";
import type { ReplicaPurgeFailedEvent } from "@tinycloud/web-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { testWallet } from "../acceptance/wallet";
import { replicationStorage } from "../acceptance/storage";
import { inspectReplicaKeyPresence } from "../../../src/kv-storage/lifecycle.js";
import { injectDenyFailure } from "@tinycloud/replica/kv-storage/testing";

type Mode = "provider" | "readonly" | "none";
type BootOptions = { host: string; walletKey: string; mode: Mode; prefix: string };

const KV_DATABASE = "tinycloud-replica-kv";
const TOMBSTONE_KEY = "tinycloud-replica:deny-tombstone";
const MARKER_KEY = "tinycloud-replica:logout-pending";

let tcw: TinyCloudWeb | undefined;
let walletKey = "";
let walletAddress: string | undefined;
let pluginRegistered = false;
let clearDeleteFault: (() => void) | undefined;
const purgeFailures: ReplicaPurgeFailedEvent[] = [];

const statusEl = document.getElementById("status");
const setStatus = (text: string) => {
  if (statusEl !== null) statusEl.textContent = text;
};

function requireTcw(): TinyCloudWeb {
  if (tcw === undefined) throw new Error("fixture not booted");
  return tcw;
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Opens the replica database only when it exists; never creates it. */
async function withExistingDatabase<T>(use: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> {
  if (!(await indexedDB.databases()).some((info) => info.name === KV_DATABASE)) return undefined;
  const db = await settle(indexedDB.open(KV_DATABASE));
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

function errorInfo(error: unknown): { code?: string; reason?: string; retryNow?: boolean; gate?: string; message: string } {
  const info: { code?: string; reason?: string; retryNow?: boolean; gate?: string; message: string } = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error === "object" && error !== null) {
    if ("code" in error && typeof error.code === "string") info.code = error.code;
    if ("reason" in error && typeof error.reason === "string") info.reason = error.reason;
    if ("retryNow" in error && typeof error.retryNow === "boolean") info.retryNow = error.retryNow;
    if ("gate" in error && typeof error.gate === "string") info.gate = error.gate;
  }
  return info;
}

const api = {
  async boot(options: BootOptions): Promise<void> {
    walletKey = options.walletKey;
    walletAddress = privateKeyToAccount(options.walletKey as `0x${string}`).address;
    purgeFailures.length = 0;
    // The replica chunk loads on demand, as it does for an app that turns replication on.
    const { browserReplicaPlugin } = await import("@tinycloud/web-sdk/replica");
    if (!pluginRegistered) {
      registerBrowserReplica(browserReplicaPlugin);
      pluginRegistered = true;
    }
    const wallet = { request: (call: { method: string; params?: unknown[] }) => testWallet(walletKey).request(call) };
    const readOnly = {
      request: async (call: { method: string; params?: unknown[] }) => {
        if (call.method === "eth_accounts" || call.method === "eth_chainId") return wallet.request(call);
        throw Object.assign(new Error("The requested method is not authorized."), { code: 4200 });
      },
    };
    const provider = options.mode === "provider" ? wallet : options.mode === "readonly" ? readOnly : undefined;
    tcw = await TinyCloudWeb.create({
      ...(provider === undefined ? {} : { provider }),
      tinycloudHosts: [options.host],
      tinycloudRegistryUrl: null,
      autoDiscoverLocalNode: false,
      autoCreateSpace: true,
      persistSession: true,
      sessionStorageKeyPrefix: "tc1888-purge",
      replication: {
        enabled: true,
        prefixes: [options.prefix],
        storage: await replicationStorage(),
      },
    });
    tcw.on("replica.purge.failed", (event) => { purgeFailures.push(event); });
  },

  /** Another throwaway wallet answers from now on: the next `signIn()` is an account switch. */
  switchWallet(key: string): void {
    walletKey = key;
    walletAddress = privateKeyToAccount(key as `0x${string}`).address;
  },

  async signIn(): Promise<{ address: string }> {
    const session = await requireTcw().signIn();
    return { address: session.address };
  },

  /** A rejection is scenario data, so the suite can assert its typed shape. */
  async signOut(): Promise<{ status: "resolved" } | ({ status: "rejected" } & ReturnType<typeof errorInfo>)> {
    try {
      await requireTcw().signOut();
      return { status: "resolved" };
    } catch (error) {
      return { status: "rejected", ...errorInfo(error) };
    }
  },

  async restoreSession(): Promise<{ status: string }> {
    if (walletAddress === undefined) throw new Error("fixture not booted");
    const restored = await requireTcw().restoreSession(walletAddress);
    return { status: restored.status };
  },

  async sync(): Promise<{ status: "ok" } | ({ status: "error" } & ReturnType<typeof errorInfo>)> {
    try {
      await requireTcw().replication!.sync();
      return { status: "ok" };
    } catch (error) {
      return { status: "error", ...errorInfo(error) };
    }
  },

  async status() {
    return (await requireTcw().replication!.status())[0];
  },

  purgeLocalCopy: () => requireTcw().replication!.purgeLocalCopy(),

  /** Names of every IndexedDB database of this origin, exactly what the user's browser lists. */
  async databases(): Promise<string[]> {
    return (await indexedDB.databases()).map((info) => info.name ?? "");
  },

  /** Rows per store of the replica database; `undefined` when the database is not there. */
  async rows(): Promise<Record<string, number> | undefined> {
    return withExistingDatabase(async (db) => {
      const out: Record<string, number> = {};
      for (const name of Array.from(db.objectStoreNames)) {
        out[name] = (await settle(db.transaction(name).objectStore(name).getAllKeys())).length;
      }
      return out;
    });
  },

  async incarnation(): Promise<string | undefined> {
    return withExistingDatabase(async (db) => {
      const gate = await settle<{ incarnation?: string } | undefined>(db.transaction("gate").objectStore("gate").get("account"));
      return gate?.incarnation;
    });
  },

  keyPresence: () => inspectReplicaKeyPresence(),

  /** localStorage facts that outlive the database: the deny floor and the pending-logout marker. */
  originFlags: () => ({
    tombstone: localStorage.getItem(TOMBSTONE_KEY) !== null,
    marker: localStorage.getItem(MARKER_KEY) !== null,
  }),

  /** Every delete of the replica database fails until `clearDeleteFailure()` (this page load only). */
  failDeleteDatabase(): void {
    clearDeleteFault?.();
    clearDeleteFault = injectDenyFailure("delete_database", { once: false });
  },
  clearDeleteFailure(): void {
    clearDeleteFault?.();
    clearDeleteFault = undefined;
  },

  /** `replica.purge.failed` events received since boot. */
  purgeFailures: (): ReplicaPurgeFailedEvent[] => purgeFailures.slice(),
};

declare global {
  interface Window {
    __purge: typeof api;
  }
}

window.__purge = api;
setStatus("ready");
