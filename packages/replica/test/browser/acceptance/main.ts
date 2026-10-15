/**
 * TC-858 acceptance fixture. The page's whole API is `window.__tcw`, driven by
 * the Playwright suite the way an app drives `TinyCloudWeb`: sign in through a
 * test EIP-1193 provider backed by a throwaway key, read through the replica,
 * sign out. No grant injection: the SDK's own session and grant flow run.
 */
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import { isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { replicationStorage } from "./storage";

type BootOptions = {
  /** TinyCloud node origin, e.g. http://127.0.0.1:8123. */
  host: string;
  /** Throwaway wallet key; never a real identity. */
  walletKey: string;
  prefix: string;
  /** Replication on by default; off to measure the network-only baseline. */
  replication: boolean;
  allowSecrets?: boolean;
  grantTtlMs?: number;
  maxStalenessMs?: number;
};

const statusEl = document.getElementById("status");
const setStatus = (text: string) => {
  if (statusEl !== null) statusEl.textContent = text;
};

let walletRequests = 0;
let tcw: TinyCloudWeb | null = null;
/** Sink for `ReplicationOptions.onEvent`; cleared on each boot. */
const replicationEventLog: unknown[] = [];

function testWallet(walletKey: string) {
  if (!isHex(walletKey)) throw new Error("test wallet key must be hex");
  const account = privateKeyToAccount(walletKey);
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return "0x1";
        case "personal_sign": {
          walletRequests += 1;
          const hexMessage = Array.isArray(params) ? params[0] : undefined;
          if (typeof hexMessage !== "string" || !isHex(hexMessage)) {
            throw new Error("personal_sign: message is not hex");
          }
          return account.signMessage({ message: { raw: hexMessage } });
        }
        default:
          throw new Error(`test wallet: unsupported method ${method}`);
      }
    },
  };
}

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

function unwired(hook: string): never {
  throw new Error(`fixture hook ${hook} is not wired: needs the S1-S3 storage/worker seams`);
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
    // Replication options are S2's `tcw.replication` surface. Until S2 lands,
    // `replicationPresent` is false and the replication scenarios fail.
    replicationEventLog.length = 0;
    const replicationOptions: Record<string, unknown> = options.replication
      ? {
          replication: {
            enabled: true,
            prefixes: [options.prefix],
            storage: replicationStorage,
            allowSecrets: options.allowSecrets === true,
            ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs }),
            ...(options.maxStalenessMs === undefined ? {} : { maxStalenessMs: options.maxStalenessMs }),
            onEvent: (event: unknown) => {
              replicationEventLog.push(event);
            },
          },
        }
      : {};
    tcw = new TinyCloudWeb({ ...base, ...replicationOptions });
    return { replicationPresent: replicationMethod(tcw, "sync") !== undefined };
  },

  async signIn(): Promise<{ address: string }> {
    const session = await requireTcw().signIn();
    return { address: session.address };
  },

  async signOut(): Promise<void> {
    await requireTcw().signOut();
  },

  walletRequests: () => walletRequests,

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
  replicationSync: () => requireReplication("sync")(),
  /** Every `replication.*` event since the last boot, in emission order. Read source is `replication.read`. */
  replicationEvents: (): unknown[] => replicationEventLog.slice(),
  /**
   * Fault hooks live in the shared test-only entry `@tinycloud/replica/kv-storage/testing`
   * (S1 owns the entry; S3 adds `injectDenyFailure`). Until it exists they fail loudly.
   */
  injectEraseFailure: () => unwired("injectEraseFailure"),
  injectDenyFailure: (plan: { stage: "deny_tx" | "delete_database"; code?: string; once?: boolean }) =>
    unwired(`injectDenyFailure(${plan.stage})`),
  killReplicaWorker: () => unwired("killReplicaWorker"),
};

declare global {
  interface Window {
    __tcw: typeof api;
  }
}

window.__tcw = api;
setStatus("ready");
