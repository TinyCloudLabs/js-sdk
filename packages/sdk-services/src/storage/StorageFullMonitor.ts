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
 * one `storage.full` event, and remembers that storage is full so read paths
 * can skip their best-effort writes.
 *
 * The event goes through the rejecting context's `emit` (so telemetry and the
 * debug log see it) and then to the handlers registered with {@link on}.
 */
export class StorageFullMonitor {
  private event: StorageFullEvent | undefined;
  private readonly handlers = new Set<StorageFullHandler>();

  /** True once a storage rejection was seen, until {@link clear}. */
  get isFull(): boolean {
    return this.event !== undefined;
  }

  /** The rejection that made storage full, until {@link clear}. */
  get rejection(): StorageFullEvent | undefined {
    return this.event;
  }

  /** Watch a context's service errors. Returns the unsubscribe function. */
  observe(context: IServiceContext): () => void {
    return context.on(TelemetryEvents.SERVICE_ERROR, (data) => {
      const { service, error } = data as Partial<ServiceErrorEvent>;
      if (this.event || !error || !isStorageFullError(error)) return;
      const meta = error.meta ?? {};
      const event: StorageFullEvent = { service: service ?? error.service, error };
      if (typeof meta.usedBytes === "number") event.usedBytes = meta.usedBytes;
      if (typeof meta.limitBytes === "number") event.limitBytes = meta.limitBytes;
      if (typeof meta.account === "object" && meta.account !== null) {
        event.account = meta.account as StorageAccountUsage;
      }
      const spaceId = context.session?.spaceId;
      if (spaceId) event.spaceId = spaceId;
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

  /**
   * Forget that storage is full, e.g. once a status read shows space again.
   * The next storage rejection emits `storage.full` again.
   */
  clear(): void {
    this.event = undefined;
  }
}
