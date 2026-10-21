import { isStorageFullError, type StorageAccountUsage } from "../errors";
import {
  TelemetryEvents,
  type IServiceContext,
  type ServiceError,
  type ServiceErrorEvent,
} from "../types";

/**
 * The single `storage.full` event: the first write any service saw rejected
 * because the owner's TinyCloud storage is full. Reads keep working, so an app
 * shows a read-only banner from this one listener instead of handling the
 * error at every write site.
 */
export interface StorageFullEvent {
  /** Service that saw the rejection, e.g. `kv` or `sql`. */
  service: string;
  /** The rejection: `STORAGE_QUOTA_EXCEEDED` or `STORAGE_LIMIT_REACHED`. */
  error: ServiceError;
  /** Bytes used by the rejected space, when the node sent them. */
  usedBytes?: number;
  /** The space's share of the account budget, when the node sent it. */
  limitBytes?: number;
  /** Account-wide totals, when the node had them from billing. */
  account?: StorageAccountUsage;
  /**
   * Space the rejected write targeted, when the service context knew it.
   * Storage is one budget per owner, so this says whose storage is full.
   */
  spaceId?: string;
}

export type StorageFullHandler = (event: StorageFullEvent) => void;

/**
 * Turns the storage rejections seen by any number of service contexts into
 * `storage.full` events, and remembers whose storage is full so read paths
 * can skip their best-effort writes.
 *
 * Storage is one budget per owner, so fullness is recorded per owner, apart
 * from the event: a rejection on one owner's space never hides a later
 * rejection on another's.
 *
 * The signed-in account's own storage has an episode. Its first rejection
 * starts the episode and emits `storage.full`; later rejections do not emit
 * again. The episode ends only when a write to that owner's storage succeeds,
 * or on {@link clear}. A status read does not end it. A rejection on another
 * owner's delegated space emits `storage.full` once per owner until a status
 * read or a successful write clears that owner, and starts no episode.
 *
 * The event goes through the rejecting context's `emit` (so telemetry and the
 * debug log see it) and then to the handlers registered with {@link on}.
 */
export class StorageFullMonitor {
  /** The own-storage episode, until a successful write or {@link clear} ends it. */
  private episode: { owner: string; event: StorageFullEvent } | undefined;
  /**
   * First rejection per owner key; {@link UNKNOWN_OWNER} when the space was unknown.
   * A status read or a successful write removes the owner, so best-effort writes resume.
   */
  private readonly full = new Map<string, StorageFullEvent>();
  private readonly handlers = new Set<StorageFullHandler>();
  private readonly episodeListeners = new Set<() => void>();
  private readonly delegatedListeners = new Set<() => void>();

  /**
   * @param ownerOf Owner key of a space id. Spaces with one key share one
   * storage budget. Defaults to the space id itself.
   * @param ownOwner Owner key of the signed-in account, or undefined when
   * there is none. Rejections on that owner's storage, or on a space that was
   * unknown, start the episode.
   */
  constructor(
    private readonly ownerOf: (spaceId: string) => string = (spaceId) => spaceId,
    private readonly ownOwner: () => string | undefined = () => undefined,
  ) {}

  /** True while any owner's storage is known to be full for best-effort writes. */
  get isFull(): boolean {
    return this.full.size > 0;
  }

  /** The rejection that started the own-storage episode, until it ends. */
  get rejection(): StorageFullEvent | undefined {
    return this.episode?.event;
  }

  /**
   * True when a write to `spaceId`'s owner was rejected, or a write whose
   * space was unknown was: that one could have been any owner's.
   */
  isFullFor(spaceId: string | undefined): boolean {
    return this.full.has(UNKNOWN_OWNER) || (spaceId !== undefined && this.full.has(this.ownerOf(spaceId)));
  }

  /** Subscribe to the own-storage episode starting or ending. Returns the unsubscribe function. */
  onEpisode(listener: () => void): () => void {
    this.episodeListeners.add(listener);
    return () => {
      this.episodeListeners.delete(listener);
    };
  }

  /**
   * Subscribe to a delegated owner's storage being found full: once per owner
   * until that owner is cleared. The own-storage episode does not fire it.
   * Returns the unsubscribe function.
   */
  onDelegated(listener: () => void): () => void {
    this.delegatedListeners.add(listener);
    return () => {
      this.delegatedListeners.delete(listener);
    };
  }

  /** Watch a context's service errors and successful writes. Returns the unsubscribe function. */
  observe(context: IServiceContext): () => void {
    const stopErrors = context.on(TelemetryEvents.SERVICE_ERROR, (data) => {
      const { service, error } = data as Partial<ServiceErrorEvent>;
      if (!error || !isStorageFullError(error)) return;
      const spaceId = context.session?.spaceId;
      const owner = this.ownerFor(spaceId);
      if (this.full.has(owner)) return;
      const meta = error.meta ?? {};
      const event: StorageFullEvent = { service: service ?? error.service, error };
      if (typeof meta.usedBytes === "number") event.usedBytes = meta.usedBytes;
      if (typeof meta.limitBytes === "number") event.limitBytes = meta.limitBytes;
      if (typeof meta.account === "object" && meta.account !== null) {
        event.account = meta.account as StorageAccountUsage;
      }
      if (spaceId) event.spaceId = spaceId;
      this.full.set(owner, event);
      if (this.isOwn(owner)) {
        if (this.episode) return;
        this.episode = { owner, event };
        this.notifyEpisode();
      } else {
        this.notifyDelegated();
      }
      context.emit(TelemetryEvents.STORAGE_FULL, event);
      for (const handler of this.handlers) {
        try {
          handler(event);
        } catch (handlerError) {
          // An app's banner code must not break the write that failed.
          console.error(`Error in "${TelemetryEvents.STORAGE_FULL}" handler:`, handlerError);
        }
      }
    });
    const stopWrites = context.on(TelemetryEvents.SERVICE_RESPONSE, (data) => {
      const { service, action, ok } = data as { service?: string; action?: string; ok?: boolean };
      if (ok !== true || !isCommittingWrite(service, action)) return;
      const owner = this.ownerFor(context.session?.spaceId);
      this.full.delete(owner);
      if (this.episode?.owner !== owner) return;
      this.episode = undefined;
      this.notifyEpisode();
    });
    return () => {
      stopErrors();
      stopWrites();
    };
  }

  /** Subscribe to the `storage.full` event. Returns the unsubscribe function. */
  on(handler: StorageFullHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Forget every owner's full state and end the episode; the next rejection starts a new one. */
  clear(): void {
    this.full.clear();
    if (!this.episode) return;
    this.episode = undefined;
    this.notifyEpisode();
  }

  /**
   * Forget that `spaceId`'s owner is full for best-effort writes (`undefined`:
   * the rejections whose space was unknown). Does not end the episode.
   */
  clearFor(spaceId: string | undefined): void {
    this.full.delete(this.ownerFor(spaceId));
  }

  private isOwn(owner: string): boolean {
    return owner === UNKNOWN_OWNER || owner === this.ownOwner();
  }

  private ownerFor(spaceId: string | undefined): string {
    return spaceId ? this.ownerOf(spaceId) : UNKNOWN_OWNER;
  }

  private notifyEpisode(): void {
    for (const listener of this.episodeListeners) {
      try {
        listener();
      } catch (listenerError) {
        // A UI listener must not break the write that ended or started the episode.
        console.error("Error in storage episode listener:", listenerError);
      }
    }
  }

  private notifyDelegated(): void {
    for (const listener of this.delegatedListeners) {
      try {
        listener();
      } catch (listenerError) {
        // A UI listener must not break the write that was rejected.
        console.error("Error in delegated storage listener:", listenerError);
      }
    }
  }
}

/** Owner key for rejections from a context without a space. */
const UNKNOWN_OWNER = "\u0000unknown";

/** Services and actions whose success means the write reached the owner's storage. */
const COMMITTING_ACTIONS = new Map<string, readonly string[]>([
  ["kv", ["put", "batchPut"]],
  ["vault", ["put"]],
  ["sql", ["execute", "batch", "executeStatement", "migrations.apply"]],
  ["duckdb", ["execute", "batch", "executeStatement", "import"]],
]);

function isCommittingWrite(service: string | undefined, action: string | undefined): boolean {
  if (service === undefined || action === undefined) return false;
  return COMMITTING_ACTIONS.get(service)?.includes(action) ?? false;
}
