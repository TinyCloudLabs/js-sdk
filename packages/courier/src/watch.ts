import { defer } from './defer.js';
import { decodeTime, ulid } from 'ulid';
import type { HookSubscription } from '@tinycloud/node-sdk';
import { errInfo, CourierError } from './errors.js';
import { k, PREFIX } from './keys.js';
import type { StoredPeer } from './profile.js';
import { isRecord, messageView, oneLine, taskView } from './a2a.js';
import { commitReceipts, selectUndelivered, type KV, type Receipts } from './inbox.js';
import { del, getJson, listAll, putCreate, putMatch, putOverwrite } from './store.js';
import type { WakeApproval, WakeMessage, Waker, WatchLog } from './wake.js';

/** Spec §8. inform and receipts never wake; a message with no valid intent is delivered but never wakes. */
const WAKE_INTENTS = new Set(['request', 'ask', 'answer', 'update']);
const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
]);
const WAKEN_MEMORY = 500;
const WAKE_RETRY_MS = 60_000;
/** Delay between starting a re-opened subscription and its catch-up list, so the stream is live first. */
const RECONNECT_CATCH_UP_MS = 2000;
/** Spec §7: an approval expires after 24 hours; an older one found at startup wakes nobody. */
const APPROVAL_MAX_AGE_MS = 24 * 3600 * 1000;
/** A wake claim older than this belongs to a crashed watcher (wake runs are capped well below it: `--wake-timeout` <= 30 min). */
const CLAIM_LEASE_MS = 35 * 60_000;
const DAY_MS = 24 * 3600 * 1000;
/** The subject is peer-controlled text that reaches state, prompts and environments: one line, control characters removed, capped. */
const MAX_SUBJECT = 200;
/** Thread and message ids come from key names the peer controls; they reach prompts and argv, so only ULID-like ids pass. */
const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;

export interface PendingWake {
  peer: string;
  threadId: string;
  subject: string;
  messages: WakeMessage[];
  /** Owner decisions on this thread's requests, waiting to wake the agent (they do not wait out the debounce). */
  approvals?: WakeApproval[];
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ApprovalWake {
  approval: WakeApproval;
  peer: string;
  threadId: string;
  subject: string;
}

export interface WatchState {
  v: 1;
  /** Keyed `<peer>/<threadId>`. */
  pending: Record<string, PendingWake>;
  /** Recently woken message ids, so a receipt write that failed cannot cause a second wake. */
  woken: string[];
  approvalsSeen: string[];
}

export interface WatchOptions {
  debounceMs: number;
  pollMs: number;
  ticketSeconds: number;
}

export const WATCH_DEFAULTS: WatchOptions = { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25 };

interface HookEventLike {
  path?: string;
}

interface HooksLike {
  subscribe(
    subscriptions: HookSubscription[],
    options: { ttlSeconds: number; signal: AbortSignal },
  ): AsyncIterable<HookEventLike>;
}

export interface WatchDeps {
  selfKv: KV;
  /** Own space id, for the `me/approvals/` subscription. */
  spaceId: string;
  /** The owner's own space. */
  selfHooks: HooksLike;
  /** A peer's space, through the peer delegation (each peer streams independently: one refused scope must not stall the rest). */
  peerHooks(peer: StoredPeer): Promise<HooksLike>;
  /** Fresh peer list each call (pairing and renewals change the profile under a running watcher). */
  loadPeers(): StoredPeer[];
  kvFor(peer: StoredPeer): Promise<KV>;
  wake: Waker;
  log: WatchLog;
  now?(): number;
}

type Via = 'startup' | 'hook' | 'poll';

export function emptyWatchState(): WatchState {
  return { v: 1, pending: {}, woken: [], approvalsSeen: [] };
}

/** Wake time: `debounce` after the latest message, but never later than twice `debounce` after the first. */
export function wakeDueAt(pending: PendingWake, debounceMs: number): number {
  // A human is waiting on an approval: wake as soon as it is seen.
  if (pending.approvals?.length) return pending.firstSeenAt;
  return Math.min(pending.lastSeenAt + debounceMs, pending.firstSeenAt + 2 * debounceMs);
}

export function sentAtOf(messageId: string): string {
  try {
    return new Date(decodeTime(messageId)).toISOString();
  } catch {
    return '';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = defer<void>();
  if (signal.aborted) return Promise.resolve();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
  return promise;
}

export class Watcher {
  private state: WatchState = emptyWatchState();
  private readonly retryAt = new Map<string, number>();
  private readonly waking = new Set<string>();
  private approvalsRunning = false;
  private approvalsAgain = false;
  private readonly holderId = ulid();
  private lastClaimPrune = 0;
  /** Set when another watcher is writing this profile's state: this one stops and `run` throws it. */
  private fatalError: CourierError | undefined;
  private onFatal: (() => void) | undefined;
  /** Etag of me/state/watch.json as this watcher last saw it: null = absent, undefined = unknown (fetch before writing). */
  private stateEtag: string | null | undefined;
  private readonly taskCache = new Map<string, { etag: string | null; terminal: boolean }>();
  private readonly metaMirrored = new Set<string>();
  private readonly syncing = new Map<string, { again: boolean; via: Via }>();
  private stateQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: WatchDeps, private readonly opts: WatchOptions = WATCH_DEFAULTS) {
    this.now = deps.now ?? Date.now;
  }

  // ---------- state ----------

  async loadState(): Promise<void> {
    const got = await getJson<WatchState>(this.deps.selfKv, k.watchState);
    const value = got?.value;
    this.stateEtag = got?.etag ?? null;
    this.state = isRecord(value) && value.v === 1
      ? { ...emptyWatchState(), ...(value as Partial<WatchState>) }
      : emptyWatchState();
  }

  snapshot(): WatchState {
    return structuredClone(this.state);
  }

  /**
   * Serialised: callers mutate `this.state` inside `fn`, then it is written with if-match against the etag this
   * watcher last saw. A second `watch` on the same profile therefore fails with `state-conflict` instead of
   * silently overwriting (last writer wins) the other's pending wakes.
   */
  private mutate<T>(fn: () => T): Promise<T> {
    const run = this.stateQueue.then(async () => {
      const result = fn();
      const { selfKv } = this.deps;
      if (this.stateEtag === undefined) this.stateEtag = (await getJson<WatchState>(selfKv, k.watchState))?.etag ?? null;
      try {
        const written = this.stateEtag
          ? await putMatch(selfKv, k.watchState, this.state, this.stateEtag)
          : await putCreate(selfKv, k.watchState, this.state);
        this.stateEtag = written ?? undefined;
      } catch (error) {
        if (error instanceof CourierError && error.code === 'conflict') {
          throw this.stateConflict('me/state/watch.json was changed by another process; a second `watch` is running for this profile. This watcher is stopping.');
        }
        throw error;
      }
      return result;
    });
    this.stateQueue = run.catch(() => undefined);
    return run;
  }

  /** Another watcher owns this profile's state. Carrying on would double-wake and overwrite its pending wakes: stop. */
  private stateConflict(message: string): CourierError {
    const conflict = new CourierError('state-conflict', message);
    this.fatalError ??= conflict;
    this.onFatal?.();
    return conflict;
  }

  /**
   * One create-only marker per wake (keyed by the first message or approval it carries), so a second watcher that
   * starts while this one's wake is in flight cannot wake the same thing: the stale-etag check alone only catches a
   * watcher that loaded state before the other one wrote. A marker held by another process within the lease means
   * two watchers are running: stop. After the lease the holder is presumed crashed and the claim is taken over.
   */
  private async claimWake(peer: string, threadId: string, firstId: string): Promise<void> {
    const { selfKv } = this.deps;
    const key = k.wakeClaim(peer, threadId, firstId);
    const claim = { v: 1, holder: this.holderId, at: new Date(this.now()).toISOString() };
    try {
      await putCreate(selfKv, key, claim);
      return;
    } catch (error) {
      if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
    }
    const existing = await getJson<{ holder?: unknown; at?: unknown }>(selfKv, key);
    if (existing?.value.holder === this.holderId) return; // this watcher's own retry after a failed wake
    const age = existing && typeof existing.value.at === 'string' ? this.now() - Date.parse(existing.value.at) : Infinity;
    if (existing?.etag && age >= CLAIM_LEASE_MS) {
      try {
        await putMatch(selfKv, key, claim, existing.etag);
        return;
      } catch (error) {
        if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
      }
    }
    throw this.stateConflict(`Another watcher is already waking thread ${threadId} (${firstId}); a second \`watch\` is running for this profile. This watcher is stopping.`);
  }

  /** Claim markers are only needed while a double wake is possible; drop those older than two days. */
  private async pruneClaims(): Promise<void> {
    try {
      for (const key of await listAll(this.deps.selfKv, k.wakeClaimsPrefix)) {
        const id = /\/([^/]+)\.json$/.exec(key)?.[1];
        const sentAt = id ? Date.parse(sentAtOf(id)) : NaN;
        if (Number.isFinite(sentAt) && this.now() - sentAt > 2 * DAY_MS) await del(this.deps.selfKv, key);
      }
    } catch (error) {
      this.deps.log('sync-error', { source: 'claims', ...errInfo(error) });
    }
  }

  // ---------- catch-up and delivery ----------

  /** Serialises syncs per peer; a request that arrives mid-sync reruns once after it. */
  async sync(peer: StoredPeer, via: Via): Promise<void> {
    const running = this.syncing.get(peer.handle);
    if (running) {
      running.again = true;
      return;
    }
    const entry = { again: false, via };
    this.syncing.set(peer.handle, entry);
    try {
      do {
        entry.again = false;
        try {
          await this.syncPeer(peer, entry.via);
        } catch (error) {
          this.deps.log('sync-error', { peer: peer.handle, ...errInfo(error) });
        }
      } while (entry.again);
    } finally {
      this.syncing.delete(peer.handle);
    }
  }

  private async syncPeer(peer: StoredPeer, via: Via): Promise<void> {
    if (peer.status !== 'paired' || !peer.inbound || !peer.theirHandleForMe) return;
    const { selfKv, log } = this.deps;
    const mailbox = peer.theirHandleForMe;
    const peerKv = await this.deps.kvFor(peer);
    const keys = await listAll(peerKv, `${PREFIX}/to/${mailbox}/threads/`);
    const receipts = (await getJson<Receipts>(selfKv, k.receipts(peer.handle)))?.value ?? { v: 1, threads: {} };
    receipts.threads ??= {};

    const delivered: { threadId: string; messageId: string; intent?: string }[] = [];
    for (const selected of selectUndelivered(keys, receipts)) {
      if (!SAFE_ID.test(selected.threadId) || !SAFE_ID.test(selected.messageId)) {
        log('ignored', { peer: peer.handle, reason: 'unsafe-id' });
        continue;
      }
      try {
        const got = await getJson<unknown>(peerKv, selected.key);
        if (!got) continue;
        const value = got.value;
        if (!isRecord(value) || value.messageId !== selected.messageId || value.contextId !== selected.threadId) continue;
        await this.mirrorCreate(k.mirrorMsg(peer.handle, selected.threadId, selected.messageId), value);
        delivered.push({ threadId: selected.threadId, messageId: selected.messageId, intent: messageView(value).intent });
      } catch (error) {
        // Not delivered, so no receipt: this message is retried on the next sync; the others go ahead.
        log('sync-error', { peer: peer.handle, messageId: selected.messageId, ...errInfo(error) });
      }
    }
    if (!delivered.length) {
      await this.mirrorThreads(peer, peerKv, keys);
      return;
    }

    const subjects = new Map<string, string>();
    for (const threadId of new Set(delivered.map((d) => d.threadId))) {
      const meta = await getJson<unknown>(peerKv, `${PREFIX}/to/${mailbox}/threads/${threadId}/meta.json`).catch(() => undefined);
      subjects.set(threadId, isRecord(meta?.value) && typeof meta.value.subject === 'string' ? oneLine(meta.value.subject, MAX_SUBJECT) : '(no subject)');
    }
    const at = this.now();
    for (const item of delivered) {
      const sentAt = sentAtOf(item.messageId);
      log('delivered', {
        via, peer: peer.handle, threadId: item.threadId, messageId: item.messageId, intent: item.intent ?? null,
        wakes: Boolean(item.intent && WAKE_INTENTS.has(item.intent)),
        sentAt, latencyMs: sentAt ? at - Date.parse(sentAt) : null,
      });
    }
    await this.mutate(() => {
      for (const item of delivered) {
        if (!item.intent || !WAKE_INTENTS.has(item.intent) || this.state.woken.includes(item.messageId)) continue;
        const key = `${peer.handle}/${item.threadId}`;
        const entry = this.state.pending[key] ??= {
          peer: peer.handle, threadId: item.threadId, subject: subjects.get(item.threadId)!, messages: [], firstSeenAt: at, lastSeenAt: at,
        };
        if (entry.messages.some((m) => m.messageId === item.messageId)) continue;
        entry.messages.push({ messageId: item.messageId, intent: item.intent, sentAt: sentAtOf(item.messageId) });
        entry.lastSeenAt = at;
      }
    });
    await commitReceipts(selfKv, new Map([[peer.handle, delivered.map(({ threadId, messageId }) => ({ threadId, messageId }))]]));
    await this.mirrorThreads(peer, peerKv, keys);
  }

  private async mirrorCreate(key: string, value: unknown): Promise<void> {
    try {
      await putCreate(this.deps.selfKv, key, value);
    } catch (error) {
      if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
    }
  }

  /**
   * meta.json is immutable (create-only); tasks are mutable, so copy the latest until they are terminal. Runs after
   * message delivery and each item is isolated: a bad or unwritable peer task never blocks receipts or wakes.
   */
  private async mirrorThreads(peer: StoredPeer, peerKv: KV, keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.mirrorThreadItem(peer, peerKv, key);
      } catch (error) {
        this.deps.log('mirror-error', { peer: peer.handle, ...errInfo(error) });
      }
    }
  }

  private async mirrorThreadItem(peer: StoredPeer, peerKv: KV, key: string): Promise<void> {
    const meta = /\/threads\/([^/]+)\/meta\.json$/.exec(key);
    if (meta) {
      if (!SAFE_ID.test(meta[1])) return;
      if (this.metaMirrored.has(key)) return;
      const got = await getJson<unknown>(peerKv, key);
      if (!got) return;
      await this.mirrorCreate(k.mirrorMeta(peer.handle, meta[1]), got.value);
      this.metaMirrored.add(key);
      return;
    }
    const task = /\/threads\/([^/]+)\/task\/([^/]+)\.json$/.exec(key);
    if (!task || !SAFE_ID.test(task[1]) || !SAFE_ID.test(task[2])) return;
    const cached = this.taskCache.get(key);
    if (cached?.terminal) return;
    const got = await getJson<unknown>(peerKv, key);
    if (!got) return;
    if (cached && got.etag && cached.etag === got.etag) return;
    await putOverwrite(this.deps.selfKv, k.mirrorTask(peer.handle, task[1], task[2]), got.value);
    const state = taskView(got.value).state;
    this.taskCache.set(key, { etag: got.etag, terminal: Boolean(state && TERMINAL_TASK_STATES.has(state)) });
  }

  /**
   * Own `me/approvals/` (only the owner's view session can write there). A new decision on a request this agent
   * filed wakes that thread's agent at once; it checks the decision itself with `courier approval`.
   */
  async syncApprovals(via: Via): Promise<void> {
    if (this.approvalsRunning) {
      this.approvalsAgain = true;
      return;
    }
    this.approvalsRunning = true;
    try {
      do {
        this.approvalsAgain = false;
        try {
          await this.syncApprovalsOnce(via);
        } catch (error) {
          this.deps.log('sync-error', { source: 'approvals', ...errInfo(error) });
        }
      } while (this.approvalsAgain);
    } finally {
      this.approvalsRunning = false;
    }
  }

  private async syncApprovalsOnce(via: Via): Promise<void> {
    const { selfKv, log } = this.deps;
    const keys = await listAll(selfKv, k.approvalsPrefix);
    const ids = keys.map((key) => /\/([^/]+)\.json$/.exec(key)?.[1]).filter((id): id is string => Boolean(id));
    const fresh = ids.filter((id) => !this.state.approvalsSeen.includes(id));
    if (!fresh.length) return;

    const handled: string[] = [];
    const wakes: ApprovalWake[] = [];
    for (const id of fresh) {
      try {
        const found = await this.approvalWake(id);
        if ('wake' in found) {
          wakes.push(found.wake);
          log('approval-seen', { via, approvalId: id, wakes: true, decision: found.wake.approval.decision });
        } else {
          log('approval-seen', { via, approvalId: id, wakes: false, reason: found.skip });
        }
        handled.push(id);
      } catch (error) {
        // Unread (transient failure): left unseen so the next sync retries it.
        log('sync-error', { source: 'approvals', approvalId: id, ...errInfo(error) });
      }
    }
    if (!handled.length) return;
    const at = this.now();
    await this.mutate(() => {
      this.state.approvalsSeen = [...new Set([...this.state.approvalsSeen, ...handled])].sort();
      for (const { approval, peer, threadId, subject } of wakes) {
        const key = `${peer}/${threadId}`;
        const entry = this.state.pending[key] ??= { peer, threadId, subject, messages: [], firstSeenAt: at, lastSeenAt: at };
        entry.approvals ??= [];
        if (!entry.approvals.some((a) => a.approvalId === approval.approvalId)) entry.approvals.push(approval);
        entry.lastSeenAt = at;
      }
    });
  }

  /** Reads one new approval and its request; `skip` says why it should not wake anyone. */
  private async approvalWake(id: string): Promise<{ skip: string } | { wake: ApprovalWake }> {
    const { selfKv } = this.deps;
    if (!SAFE_ID.test(id)) return { skip: 'unsafe-id' };
    const approval = (await getJson<unknown>(selfKv, k.approval(id)))?.value;
    if (!isRecord(approval) || approval.requestId !== id || (approval.decision !== 'approved' && approval.decision !== 'denied')) {
      return { skip: 'malformed' };
    }
    const decidedAt = typeof approval.decidedAt === 'string' ? Date.parse(approval.decidedAt) : NaN;
    if (!Number.isFinite(decidedAt) || this.now() - decidedAt >= APPROVAL_MAX_AGE_MS) return { skip: 'stale' };
    const request = (await getJson<unknown>(selfKv, k.request(id)))?.value;
    if (!isRecord(request) || typeof request.peer !== 'string' || typeof request.threadId !== 'string'
      || !SAFE_ID.test(request.peer) || !SAFE_ID.test(request.threadId)) {
      return { skip: 'no-request' };
    }
    if (await getJson<unknown>(selfKv, k.approvalUsed(id))) return { skip: 'used' };
    const own = (await getJson<unknown>(selfKv, k.threadMeta(request.peer, request.threadId)))?.value
      ?? (await getJson<unknown>(selfKv, k.mirrorMeta(request.peer, request.threadId)))?.value;
    const subject = isRecord(own) && typeof own.subject === 'string' ? oneLine(own.subject, MAX_SUBJECT) : '(no subject)';
    return { wake: { approval: { approvalId: id, requestId: id, decision: approval.decision }, peer: request.peer, threadId: request.threadId, subject } };
  }

  // ---------- wake ----------

  /** Wake every thread whose debounce has elapsed (`force`: all of them now). Threads wake in parallel, one wake per thread at a time. */
  async tick(force = false): Promise<void> {
    if (this.fatalError) return;
    const at = this.now();
    const runs: Promise<void>[] = [];
    for (const [key, pending] of Object.entries(this.state.pending)) {
      if (this.waking.has(key)) continue;
      if (!force && wakeDueAt(pending, this.opts.debounceMs) > at) continue;
      if (!force && (this.retryAt.get(key) ?? 0) > at) continue;
      this.waking.add(key);
      runs.push(this.wakeThread(key, pending, at).finally(() => this.waking.delete(key)));
    }
    await Promise.all(runs);
  }

  private async wakeThread(key: string, pending: PendingWake, at: number): Promise<void> {
    // Messages that land while the wake runs stay pending for the next one, so wake exactly this snapshot.
    const messages = [...pending.messages];
    const approvals = [...(pending.approvals ?? [])];
    const woken = messages.map((m) => m.messageId);
    const approvedIds = approvals.map((a) => a.approvalId);
    const oldestSentAt = messages[0]?.sentAt ?? '';
    // Claim the state first: a stale second watcher fails this conditional write and stops before it can wake.
    // The per-wake claim goes first: a newcomer whose claim fails must stop without having written the state, which
    // would otherwise make the watcher that legitimately owns the wake fail its next conditional write.
    await this.claimWake(pending.peer, pending.threadId, woken[0] ?? approvedIds[0]);
    await this.mutate(() => {});
    const startedAt = this.now();
    // `waking` is when the adapter is invoked: the send-to-wake latency. `woke` follows when the adapter returns.
    this.deps.log('waking', {
      peer: pending.peer, threadId: pending.threadId, messageIds: woken, approvalIds: approvedIds,
      oldestSentAt: oldestSentAt || null,
      wakeLatencyMs: oldestSentAt ? startedAt - Date.parse(oldestSentAt) : null,
    });
    try {
      await this.deps.wake({ peer: pending.peer, threadId: pending.threadId, subject: pending.subject, messages, approvals });
    } catch (error) {
      this.retryAt.set(key, at + WAKE_RETRY_MS);
      this.deps.log('wake-error', { peer: pending.peer, threadId: pending.threadId, ...errInfo(error) });
      return;
    }
    this.retryAt.delete(key);
    await this.mutate(() => {
      const current = this.state.pending[key];
      if (current) {
        current.messages = current.messages.filter((m) => !woken.includes(m.messageId));
        current.approvals = (current.approvals ?? []).filter((a) => !approvedIds.includes(a.approvalId));
        if (!current.messages.length && !current.approvals.length) delete this.state.pending[key];
      }
      this.state.woken = [...this.state.woken, ...woken].slice(-WAKEN_MEMORY);
    });
    this.deps.log('woke', {
      peer: pending.peer, threadId: pending.threadId, messageIds: woken, approvalIds: approvedIds,
      runMs: this.now() - startedAt,
    });
  }

  // ---------- run loop ----------

  async pollOnce(via: Via): Promise<void> {
    await Promise.all(this.deps.loadPeers().map((peer) => this.sync(peer, via)));
    await this.syncApprovals(via);
  }

  /**
   * Runs until `signal` aborts. With `once`, does one catch-up and wakes everything immediately. Throws
   * `state-conflict` (after stopping everything) if another watcher is writing this profile's state.
   */
  async run(external: AbortSignal, options: { once?: boolean } = {}): Promise<void> {
    const { log } = this.deps;
    const stop = new AbortController();
    const signal = stop.signal;
    const onExternalAbort = () => stop.abort();
    external.addEventListener('abort', onExternalAbort, { once: true });
    if (external.aborted) stop.abort();
    this.onFatal = () => stop.abort();
    const supervisors = new Map<string, AbortController>();
    let ticker: NodeJS.Timeout | undefined;
    try {
      await this.loadState();
      log('start', { debounceMs: this.opts.debounceMs, pollMs: this.opts.pollMs, ticketSeconds: this.opts.ticketSeconds, once: Boolean(options.once) });
      await this.pruneClaims();
      this.lastClaimPrune = this.now();
      const reconcile = () => {
        const desired = new Map<string, { sub: HookSubscription; hooks: () => Promise<HooksLike>; onEvent: (event?: HookEventLike) => void }>();
        for (const peer of this.deps.loadPeers()) {
          if (peer.status !== 'paired' || !peer.inbound || !peer.theirHandleForMe) continue;
          // The id carries the delegation CID: a renewed delegation restarts the subscription.
          desired.set(`peer:${peer.handle}:${peer.inbound.cid}`, {
            sub: { space: peer.spaceId, service: 'kv', pathPrefix: `${PREFIX}/to/${peer.theirHandleForMe}` },
            hooks: () => this.deps.peerHooks(peer),
            onEvent: () => void this.sync(peer, 'hook'),
          });
        }
        desired.set('approvals', {
          sub: { space: this.deps.spaceId, service: 'kv', pathPrefix: k.approvalsPrefix },
          hooks: async () => this.deps.selfHooks,
          onEvent: () => void this.syncApprovals('hook'),
        });
        for (const [id, controller] of supervisors) {
          if (!desired.has(id)) {
            controller.abort();
            supervisors.delete(id);
          }
        }
        for (const [id, source] of desired) {
          if (supervisors.has(id)) continue;
          const controller = new AbortController();
          supervisors.set(id, controller);
          void this.supervise(id, source.sub, source.hooks, source.onEvent, controller.signal);
        }
      };
      if (options.once) {
        await this.pollOnce('startup');
        await this.tick(true);
      } else {
        // Open the subscriptions first, then catch up: a write between the two is seen by one or the other.
        reconcile();
        await sleep(RECONNECT_CATCH_UP_MS, signal);
        if (!signal.aborted) await this.pollOnce('startup');
        ticker = setInterval(() => void this.tick().catch((e) => log('wake-error', errInfo(e))), 1000);
        while (!signal.aborted) {
          await sleep(this.opts.pollMs, signal);
          if (signal.aborted) break;
          reconcile();
          await this.pollOnce('poll');
          if (this.now() - this.lastClaimPrune > 3600_000) {
            this.lastClaimPrune = this.now();
            await this.pruneClaims();
          }
        }
      }
    } finally {
      clearInterval(ticker);
      for (const controller of supervisors.values()) controller.abort();
      external.removeEventListener('abort', onExternalAbort);
      this.onFatal = undefined;
      log('stop');
    }
    if (this.fatalError) throw this.fatalError;
  }

  /** One hook subscription. A refused ticket (revoked or expired delegation) backs off; the poll covers meanwhile. */
  private async supervise(
    id: string,
    sub: HookSubscription,
    hooks: () => Promise<HooksLike>,
    onEvent: (event?: HookEventLike) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0;
    let opened = false;
    while (!signal.aborted) {
      try {
        this.deps.log('hook-subscribe', { source: id.split(':').slice(0, 2).join(':'), ttlSeconds: this.opts.ticketSeconds });
        // Spec §8.2: catch up on every (re)connect, since hooks have no replay. The catch-up runs after the
        // subscription below has been started, so a write in between is seen by one or the other. (The SDK's own
        // ticket reopen is invisible here; the poll covers those gaps.)
        if (opened) void sleep(RECONNECT_CATCH_UP_MS, signal).then(() => { if (!signal.aborted) onEvent(); });
        opened = true;
        const service = await hooks();
        for await (const event of service.subscribe([sub], { ttlSeconds: this.opts.ticketSeconds, signal })) {
          failures = 0;
          this.deps.log('hook-event', { source: id.split(':').slice(0, 2).join(':'), path: event.path ?? null });
          onEvent(event);
        }
        if (!signal.aborted) await sleep(5_000, signal);
      } catch (error) {
        failures++;
        this.deps.log('hook-error', { source: id.split(':').slice(0, 2).join(':'), ...errInfo(error) });
        await sleep(Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
  }
}
