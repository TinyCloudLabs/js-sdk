import { pkhDid } from "@tinycloud/sdk-core";
import type { FetchFunction, ServiceContext, ServiceSession } from "@tinycloud/sdk-core";
import type {
  KVReadThrough,
  KVReplicaStorage,
  KVReplicationController,
  PendingWriteStore,
  ReplicationAuthority,
  ReplicationControl,
  ReplicationEvent,
  ReplicationIdentity,
  ReplicationOptions,
  ReplicationScheduler,
} from "@tinycloud/sdk-services";
type ReplicationServices = typeof import("@tinycloud/sdk-services/kv/replication");

export interface ReplicationRuntimeOptions extends ReplicationOptions {
  storage: KVReplicaStorage;
  mode?: "background" | "foreground";
}

export interface ReplicationRuntimeBinding {
  context: ServiceContext;
  session: ServiceSession;
  address?: string;
  chainId?: number;
  principal?: string;
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
type ReadThroughKV = {
  setReadThrough(readThrough: KVReadThrough | null): void;
  setReadThroughReady?(ready: Promise<unknown>): void;
};

export class ReplicationRuntime {
  readonly control: ReplicationControl;
  private readonly pending = new Map<string, PendingWriteStore>();
  private readonly attached = new Map<ReadThroughKV, string>();
  private current?: KVReplicationController;
  private lastController?: KVReplicationController;
  private previous: Promise<void> = Promise.resolve();
  private binding: Promise<void> = Promise.resolve();
  private services?: Promise<ReplicationServices>;
  private generation = 0;
  private lastIdentity?: ReplicationIdentity;
  private lastPending?: PendingWriteStore;
  private primarySpace?: string;
  private pendingPurge?: Parameters<KVReplicationController["purge"]>[0];
  private pendingPurgeResult?: ReturnType<KVReplicationController["purge"]>;
  private bindingActive = false;
  private pendingPurgeSet = false;
  private purgedGeneration?: number;
  private closed = false;
  constructor(
    private readonly options: ReplicationRuntimeOptions,
    private readonly clock: ReplicationScheduler = scheduler,
  ) {
    this.control = {
      status: async () => {
        await this.binding;
        return this.current ? this.current.status() : [];
      },
      sync: async (input) => {
        await this.binding;
        if (this.purgedGeneration === this.generation) return;
        if (this.current) await this.current.sync(input);
      },
      purge: (input) => {
        if (this.bindingActive) {
          this.pendingPurge = input;
          this.pendingPurgeSet = true;
          const existing = this.current ?? this.lastController;
          if (existing) {
            this.pendingPurgeResult = existing.purge(input);
            this.purgedGeneration = this.generation;
          }
          return this.binding.then(() => this.pendingPurgeResult ?? { purged: [], failed: [] });
        }
        const controller = this.current ?? this.lastController;
        if (!controller) return Promise.resolve({ purged: [], failed: [] });
        this.purgedGeneration = this.generation;
        return controller.purge(input);
      },
      clearPending: async () => {
        await this.binding;
        if (this.current) return this.current.clearPending();
        const pending = this.lastPending;
        if (!pending) return 0;
        return pending.update((state) => {
          const before = state.records.length;
          state.records = state.records.filter((record) =>
            record.state === "committed" ||
            (record.state === "in_flight" && this.clock.now() - Date.parse(record.at) <= 10 * 60_000),
          );
          return before - state.records.length;
        });
      },
      close: async () => {
        this.closed = true;
        this.unbind();
        await this.binding.catch(() => undefined);
        await this.previous;
      },
    };
  }

  private loadServices(): Promise<ReplicationServices> {
    return (this.services ??= import("@tinycloud/sdk-services/kv/replication"));
  }

  private detachAll(): void {
    for (const kv of this.attached.keys()) kv.setReadThrough(null);
    this.attached.clear();
  }

  bind(input: ReplicationRuntimeBinding): Promise<void> {
    if (this.closed || !this.options.enabled) return Promise.resolve();
    this.bindingActive = true;
    const generation = ++this.generation;
    this.purgedGeneration = undefined;
    const { context, session } = input;
    const emit = (event: ReplicationEvent): void => {
      try { this.options.onEvent?.(event); } catch { /* Observability must not affect KV behavior. */ }
      const { type, ...data } = event;
      context.emit(type, data);
    };
    const previous = this.current;
    this.current = undefined;
    for (const kv of this.attached.keys()) kv.setReadThrough(null);
    this.primarySpace = session.spaceId;
    const close = previous ? previous.close().catch(() => undefined) : Promise.resolve();
    this.previous = this.previous.then(() => close);
    const previousClose = this.previous;
    this.binding = this.loadServices().then((services) => {
      if (generation !== this.generation || this.closed) return;
      let identity: ReplicationIdentity;
      try {
        identity = services.canonicalReplicationIdentity({
          host: context.hosts[0]!,
          space: session.spaceId,
          principal: input.principal ?? pkhDid(input.address!, input.chainId!),
        });
      } catch {
        for (const prefix of this.options.prefixes) {
          emit({ type: "replication.state", at: new Date(this.clock.now()).toISOString(), space: session.spaceId, replica: prefix, state: "unavailable", code: "CONFIG_INVALID" });
        }
        return;
      }
      const key = services.replicationIdentityKey(identity);
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.options.storage.pendingWrites?.(identity) ?? services.createMemoryPendingStore(identity);
        this.pending.set(key, pending);
      }
      this.lastPending = pending;
      const controller = services.createKVReplication({
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
        previous: previousClose,
      });
      this.current = controller;
      this.lastController = controller;
      this.lastIdentity = identity;
      for (const [kv, space] of this.attached) {
        kv.setReadThrough(space === this.primarySpace ? controller : null);
      }
      for (const scoped of input.primaryKV) this.attach(scoped.space, scoped.kv);
      if (this.pendingPurgeSet) {
        this.pendingPurgeResult = controller.purge(this.pendingPurge);
        this.purgedGeneration = generation;
        this.pendingPurge = undefined;
        this.pendingPurgeSet = false;
      }
    }).finally(() => {
      if (generation === this.generation) this.bindingActive = false;
    });
    for (const kv of this.attached.keys()) kv.setReadThroughReady?.(this.binding);
    return this.binding;
  }

  attach(space: string, kv: ReadThroughKV): Promise<void> {
    this.attached.set(kv, space);
    kv.setReadThrough(space === this.primarySpace ? this.current ?? null : null);
    return this.binding.then(() => {
      kv.setReadThrough(space === this.primarySpace ? this.current ?? null : null);
    });
  }

  unbind(): Promise<void> {
    this.generation++;
    this.bindingActive = false;
    this.pendingPurgeSet = false;
    const controller = this.current;
    this.current = undefined;
    this.primarySpace = undefined;
    this.detachAll();
    const binding = this.binding;
    const close = binding.then(() => controller?.close()).catch(() => undefined);
    this.previous = this.previous.then(() => close);
    return this.previous;
  }

  get boundIdentity(): ReplicationIdentity | undefined {
    return this.lastIdentity;
  }
}
