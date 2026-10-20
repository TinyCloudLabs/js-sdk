/**
 * The network-only baseline for the flag-off byte-identical scenario. It imports
 * `TinyCloudWeb` and nothing from the replica packages, so any request the replication-capable
 * page makes that this page does not make is replica cost paid with replication off.
 */
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import { testWallet } from "./wallet";

let tcw: TinyCloudWeb | null = null;
const need = () => {
  if (tcw === null) throw new Error("baseline not booted");
  return tcw;
};

const api = {
  async boot(options: { host: string; walletKey: string }): Promise<void> {
    tcw = await TinyCloudWeb.create({
      provider: testWallet(options.walletKey),
      tinycloudHosts: [options.host],
      tinycloudRegistryUrl: null,
      autoDiscoverLocalNode: false,
      autoCreateSpace: true,
      persistSession: true,
      sessionStorageKeyPrefix: "tc858-acceptance",
    });
  },
  async signIn(): Promise<{ address: string }> {
    return { address: (await need().signIn()).address };
  },
  async signOut(): Promise<void> {
    await need().signOut();
  },
  async kvGet(key: string) {
    const result = await need().kv.get<string>(key);
    return result.ok ? { status: "present" as const, value: result.data.data } : { status: "error" as const, code: result.error.code };
  },
  async kvList(prefix: string) {
    const result = await need().kv.list({ prefix });
    return result.ok ? { status: "present" as const, keys: result.data.keys } : { status: "error" as const, code: result.error.code };
  },
};

declare global {
  interface Window {
    __baseline: typeof api;
  }
}

window.__baseline = api;
document.getElementById("status")!.textContent = "ready";
