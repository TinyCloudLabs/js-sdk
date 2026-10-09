import {
  canonicalReplicationIdentity,
  createKVReplication,
  createMemoryPendingStore,
  replicationIdentityKey,
  type KVReadThrough,
  type KVReplicaStorage,
  type KVReplicationController,
  type PendingWriteStore,
  type ReplicationAuthority,
  type ReplicationControl,
  type ReplicationEvent,
  type ReplicationIdentity,
  type ReplicationOptions,
  type ReplicationScheduler,
} from "@tinycloud/sdk-services";
import { pkhDid } from "@tinycloud/sdk-core";
import type { FetchFunction, ServiceContext, ServiceSession } from "@tinycloud/sdk-core";

export interface ReplicationRuntimeOptions extends ReplicationOptions {
  storage: KVReplicaStorage;
  mode?: "background" | "foreground";
}

export interface ReplicationRuntimeBinding {
  context: ServiceContext;
  session: ServiceSession;
  address: string;
  chainId: number;
  authority: ReplicationAuthority;
  primaryKV: Array<{ space: string; kv: { setReadThrough(readThrough: KVReadThrough | null): void } }>;
}

const scheduler: ReplicationScheduler = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

function resolvedOptions(options: ReplicationRuntimeOptions) {
  return {
    ...options,
    syncIntervalMs: options.syncIntervalMs ?? 60_000,
    maxStalenessMs: options.maxStalenessMs ?? 120_000,
    staleSyncTimeoutMs: options.staleSyncTimeoutMs ?? 5_000,
    allowSecrets: options.allowSecrets === true,
    verify: options.verify === true,
  };
}
type ReadThroughKV = { setReadThrough(readThrough: KVReadThrough | null): void };

export class ReplicationRuntime {
  readonly control: ReplicationControl;
  private readonly pending = new Map<string, PendingWriteStore>();
  private readonly attached = new Set<ReadThroughKV>();
  private current?: KVReplicationController;
  private lastController?: KVReplicationController;
  private previous: Promise<void> = Promise.resolve();
  private lastIdentity?: ReplicationIdentity;
  private primarySpace?: string;
  private closed = false;
  constructor(
    private readonly options: ReplicationRuntimeOptions,
    private readonly clock: ReplicationScheduler = scheduler,
  ) {
    this.control = {
      status: async () => this.current ? this.current.status() : [],
      sync: async (input) => { if (this.current) await this.current.sync(input); },
      purge: async (input) => {
        const controller = this.current ?? this.lastController;
        if (!controller) return { purged: [], failed: [] };
        return controller.purge(input);
      },
      close: async () => { this.closed = true; this.unbind(); await this.previous; },
    };
  }

  private detachAll(): void {
    for (const kv of this.attached) kv.setReadThrough(null);
    this.attached.clear();
  }

  bind(input: ReplicationRuntimeBinding): void {
    if (this.closed || !this.options.enabled) return;
    const { context, session } = input;
    const emit = (event: ReplicationEvent): void => {
      try { this.options.onEvent?.(event); } catch { /* Observability must not affect KV behavior. */ }
      const { type, ...data } = event;
      context.emit(type, data);
    };
    let identity: ReplicationIdentity;
    try {
      identity = canonicalReplicationIdentity({
        host: context.hosts[0]!,
        space: session.spaceId,
        principal: pkhDid(input.address, input.chainId),
      });
    } catch {
      const previous = this.current;
      this.current = undefined;
      this.detachAll();
      this.previous = previous ? previous.close().catch(() => undefined) : this.previous;
      this.primarySpace = session.spaceId;
      for (const prefix of this.options.prefixes) {
        emit({ type: "replication.state", at: new Date(this.clock.now()).toISOString(), space: session.spaceId, replica: prefix, state: "unavailable", code: "CONFIG_INVALID" });
      }
      return;
    }
    const previous = this.current;
    this.current = undefined;
    this.detachAll();
    this.previous = previous ? previous.close().catch(() => undefined) : this.previous;
    const key = replicationIdentityKey(identity);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.options.storage.pendingWrites?.(identity) ?? createMemoryPendingStore(identity);
      this.pending.set(key, pending);
    }
    const controller = createKVReplication({
      options: resolvedOptions(this.options),
      mode: this.options.mode ?? "background",
      storage: this.options.storage,
      identity,
      session: { id: session.delegationCid, did: session.verificationMethod, space: session.spaceId },
      authority: input.authority,
      pending,
      scheduler: this.clock,
      emit,
      fetch: context.fetch as FetchFunction,
      previous: this.previous,
    });
    this.current = controller;
    this.lastController = controller;
    this.primarySpace = session.spaceId;
    this.lastIdentity = identity;
    for (const scoped of input.primaryKV) {
      this.attach(scoped.space, scoped.kv);
    }
  }

  attach(space: string, kv: ReadThroughKV): void {
    this.attached.add(kv);
    kv.setReadThrough(space === this.primarySpace ? this.current ?? null : null);
  }

  unbind(): void {
    const controller = this.current;
    this.current = undefined;
    this.detachAll();
    if (controller) this.previous = controller.close().catch(() => undefined);
  }

  get boundIdentity(): ReplicationIdentity | undefined {
    return this.lastIdentity;
  }
}
