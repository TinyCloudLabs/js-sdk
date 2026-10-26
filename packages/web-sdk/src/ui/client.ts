import type { IStorageService, PermissionEntry } from "@tinycloud/sdk-core";

import { TAB_PERMISSION, TAB_PERMISSION_EXPIRY_MS } from "./data/authority";
import type { PanelDataFactory, PanelDataSource, PermissionAbility } from "./data";
import type { UiPlatform } from "./config";
import type { AuthorityKind, PanelClient, PurgeLocalCopyResult, RequestLogReader, SyncFacade } from "./slots";

type AuthorityAnswer = { approved: boolean; code?: string };

/**
 * What the UI reads from a TinyCloudWeb instance. The panel never sees
 * TinyCloudWeb itself.
 */
export interface ClientSource {
  signedIn(): boolean;
  /** Resolves when the account registry sync has settled. Absent means already settled. */
  waitForAccountRegistrySync?(): Promise<void>;
  readonly sync?: SyncFacade | undefined;
  readonly storage: Pick<IStorageService, "status">;
  readonly storageEpisode?: PanelClient["storageEpisode"];
  readonly requests?: RequestLogReader | undefined;
  /** Signs out of the TinyCloud session. Undefined when the host cannot sign out. */
  signOut?: (() => Promise<void>) | undefined;
  /** Removes the local copy from this browser; the panel calls it after sign-out settles. Undefined: nothing to purge. */
  purgeLocalCopy?: (() => Promise<PurgeLocalCopyResult>) | undefined;
  /**
   * True when this page can show the SDK's permission prompt: a page signer and a manifest exist. Absent: no.
   * Read on each use, so it turns false after sign-out.
   */
  canRequestPermissions?(): boolean;
  /** Asks the SDK for `entries` as a runtime grant. Resolves `{ approved: false }` on a decline; rejects on an error. */
  requestPermissions?(entries: PermissionEntry[], options: { expiryMs: number }): Promise<{ approved: boolean }>;
}

export interface PanelClientHandle {
  readonly client: PanelClient;
  /** Clears this client's per-account view state and fires onReset listeners. */
  reset(): void;
}

export function createPanelClient(
  id: number,
  source: ClientSource,
  dataFactory?: PanelDataFactory,
  platform: UiPlatform = "web",
): PanelClientHandle {
  // One request at a time: the SDK shows one permission prompt, so a second click gets the open request's answer.
  let pending: { readonly kind: AuthorityKind; readonly answer: Promise<AuthorityAnswer> } | undefined;

  async function ask(kind: AuthorityKind): Promise<AuthorityAnswer> {
    const entry = TAB_PERMISSION[kind as PermissionAbility];
    if (entry === undefined || source.requestPermissions === undefined) return { approved: false, code: "unsupported" };
    try {
      const result = await source.requestPermissions([entry], { expiryMs: TAB_PERMISSION_EXPIRY_MS });
      return result.approved ? { approved: true } : { approved: false, code: "declined" };
    } catch {
      return { approved: false, code: "failed" };
    }
  }

  function askForPermission(kind: AuthorityKind): Promise<AuthorityAnswer> {
    if (pending !== undefined) {
      return pending.kind === kind ? pending.answer : Promise.resolve({ approved: false, code: "busy" });
    }
    const answer = ask(kind).finally(() => {
      pending = undefined;
    });
    pending = { kind, answer };
    return answer;
  }
  const resetListeners = new Set<() => void>();
  // Built on first read and dropped on reset, so a sign-out never keeps the previous account's rows.
  let panelData: PanelDataSource | undefined;

  const client: PanelClient = {
    id,
    signedIn: () => source.signedIn(),
    onReset(cb) {
      resetListeners.add(cb);
      return () => {
        resetListeners.delete(cb);
      };
    },
    get sync() {
      return source.sync;
    },
    get storage() {
      return source.storage;
    },
    get storageEpisode() {
      return source.storageEpisode;
    },
    get data() {
      if (panelData === undefined && dataFactory !== undefined) panelData = dataFactory(client);
      return panelData;
    },
    get requestAuthority() {
      if (platform === "native" || source.requestPermissions === undefined || source.canRequestPermissions?.() !== true) {
        return undefined;
      }
      return askForPermission;
    },
    canRequest: (kind) => TAB_PERMISSION[kind as PermissionAbility] !== undefined,
    platform,
    requests: source.requests,
    signOut: source.signOut,
    purgeLocalCopy: source.purgeLocalCopy,
  };

  return {
    client,
    reset() {
      panelData = undefined;
      for (const cb of [...resetListeners]) {
        try {
          cb();
        } catch {
          // A failing listener must not block the other resets.
        }
      }
    },
  };
}
