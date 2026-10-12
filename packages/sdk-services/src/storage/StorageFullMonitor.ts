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
 * one `storage.full` event, and remembers whose storage is full so read paths
 * can skip their best-effort writes.
 *
 * Storage is one budget per owner, so fullness is recorded per owner, apart
 * from the event: a rejection on one owner's space never hides a later
 * rejection on another's. The event fires once per episode, which lasts until
 * no owner is known to be full.
 *
 * The event goes through the rejecting context's `emit` (so telemetry and the
 * debug log see it) and then to the handlers registered with {@link on}.
 */
export class StorageFullMonitor {
  /** The emitted event, until the episode ends. */
  private event: StorageFullEvent | undefined;
  /** First rejection per owner key; {@link UNKNOWN_OWNER} when the space was unknown. */
  private readonly full = new Map<string, StorageFullEvent>();
  private readonly handlers = new Set<StorageFullHandler>();

  /**
   * @param ownerOf Owner key of a space id. Spaces with one key share one
   * storage budget. Defaults to the space id itself.
   */
  constructor(private readonly ownerOf: (spaceId: string) => string = (spaceId) => spaceId) {}

  /** True while any owner's storage is known to be full. */
  get isFull(): boolean {
    return this.full.size > 0;
  }

  /** The rejection `storage.full` announced, until the episode ends. */
  get rejection(): StorageFullEvent | undefined {
    return this.event;
  }

  /**
   * True when a write to `spaceId`'s owner was rejected, or a write whose
   * space was unknown was: that one could have been any owner's.
   */
  isFullFor(spaceId: string | undefined): boolean {
    return this.full.has(UNKNOWN_OWNER) || (spaceId !== undefined && this.full.has(this.ownerOf(spaceId)));
  }

  /** Watch a context's service errors. Returns the unsubscribe function. */
  observe(context: IServiceContext): () => void {
    return context.on(TelemetryEvents.SERVICE_ERROR, (data) => {
      const { service, error } = data as Partial<ServiceErrorEvent>;
      if (!error || !isStorageFullError(error)) return;
      const spaceId = context.session?.spaceId;
      const owner = spaceId ? this.ownerOf(spaceId) : UNKNOWN_OWNER;
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
      if (this.event) return;
      this.event = event;
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
  }

  /** Subscribe to the `storage.full` event. Returns the unsubscribe function. */
  on(handler: StorageFullHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Forget that any owner's storage is full; the next rejection emits `storage.full` again. */
  clear(): void {
    this.full.clear();
    this.event = undefined;
  }

  /**
   * Forget that `spaceId`'s owner is full (`undefined`: the rejections whose
   * space was unknown). Once no owner is full, the next rejection emits
   * `storage.full` again.
   */
  clearFor(spaceId: string | undefined): void {
    this.full.delete(spaceId === undefined ? UNKNOWN_OWNER : this.ownerOf(spaceId));
    if (this.full.size === 0) this.event = undefined;
  }
}

/** Owner key for rejections from a context without a space. */
const UNKNOWN_OWNER = "\u0000unknown";
