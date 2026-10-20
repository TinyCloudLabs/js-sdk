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
import type { Notice, Notifier } from './notify.js';
import { writePauseMarker } from './pause.js';

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
/** Adapter runs are capped at 30 min in total (`--wake-timeout`, one deadline across all its calls). This profile's own claim is respected 35 min unless its holder is provably gone; another profile's or machine's, 45. */
const OWN_CLAIM_LEASE_MS = 35 * 60_000;
/** Another profile or machine: the same plus a margin for clock skew (`at` is the claimer's own clock). */
const FOREIGN_CLAIM_LEASE_MS = 45 * 60_000;
/** A thread another watcher is waking is looked at again after this. */
const CLAIM_SKIP_MS = 30_000;
const DAY_MS = 24 * 3600 * 1000;
/** A peer can make this side's watcher notify its human at most this often per hour, and the outbox never grows past `MAX_OUTBOX`. */
const NOTICES_PER_PEER_PER_HOUR = 10;
const MAX_OUTBOX = 50;
const MAX_OUTBOX_TRIES = 8;
const MAX_HELD_PER_THREAD = 100;
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
  /** Successful message wakes today (UTC), per `<peer>/<threadId>`, as epoch ms (approval wakes do not count). */
  wakes: Record<string, number[]>;
  /** Threads this watcher has seen paused; a marker that vanishes from this list means the human resumed it. */
  paused: string[];
  /** Posts and notifications that must happen exactly-ish once and survive a restart (retried until they succeed). */
  outbox: OutboxItem[];
  held: Record<string, HeldBacklog>;
  /** Day (UTC, since epoch) of the last `peer-paused` notification per `<peer>/<threadId>`: one per thread per day. */
  peerPausedDay: Record<string, number>;
  /** Times of recent `peer-paused` notifications per peer, for the per-hour cap. */
  noticeLog: Record<string, number[]>;
}

/** `tries` counts failed attempts; an item that keeps failing is dropped (see `MAX_OUTBOX_TRIES`). */
export type OutboxItem =
  | { id: string; kind: 'inform'; peer: string; threadId: string; text: string; tries?: number }
  | { id: string; kind: 'notify'; notice: Notice; tries?: number };

/** Messages that arrived while a thread was paused; they wake the agent once, together, after `courier resume`. */
export interface HeldBacklog {
  peer: string;
  threadId: string;
  subject: string;
  messages: WakeMessage[];
}

export interface WatchOptions {
  debounceMs: number;
  pollMs: number;
  ticketSeconds: number;
  /** Spec §8: at most this many wakes per side per thread per 24 h, then the thread pauses. */
  wakeBudget: number;
}

export const WATCH_DEFAULTS: WatchOptions = { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25, wakeBudget: 12 };

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
  /** Posts the `thread-paused` inform to a peer (own space, `to/<peer>/threads/<id>/msg/`). Default: nothing. */
  postInform?(peer: string, threadId: string, text: string): Promise<void>;
  /** Tells this side's human (Paseo attention, desktop notification, …). Default: log only. */
  notify?: Notifier;
  /**
   * Who this watcher is, for wake claims. `profileId` is stable for this profile on this machine (a restart keeps it,
   * a second profile or machine differs); `pid` and `isAlive` tell a restarted watcher its predecessor is dead.
   */
  holder?: { profileId: string; pid?: number; isAlive?(pid: number): boolean };
  now?(): number;
}

type Via = 'startup' | 'hook' | 'poll';

export function emptyWatchState(): WatchState {
  return { v: 1, pending: {}, woken: [], approvalsSeen: [], wakes: {}, paused: [], outbox: [], held: {}, peerPausedDay: {}, noticeLog: {} };
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

/** Signal 0 only probes: ESRCH = gone, EPERM = alive but not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
  /** Thread keys currently paused: markers under me/state/paused/ plus those this watcher just wrote. */
  private pausedKeys = new Set<string>();
  /** Serialises everything that reads or writes pause markers, so a stale listing cannot drop a pause just written. */
  private pausedLock: Promise<unknown> = Promise.resolve();
  private readonly wakeFailures = new Map<string, number>();
  private readonly outboxBusy = new Set<string>();
  private readonly outboxRetryAt = new Map<string, number>();
  private approvalsAgain = false;
  /** Unique to this run: a claim with this id is this process's own. */
  private readonly runId = ulid();
  private readonly profileId: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private lastClaimPrune = 0;
  /** Set when another watcher is writing this profile's state: this one stops and `run` throws it. */
  private fatalError: CourierError | undefined;
  /** Set once `run` is told to stop: nothing new is woken after that. */
  private stopping = false;
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
    this.profileId = deps.holder?.profileId ?? this.runId;
    this.pid = deps.holder?.pid ?? process.pid;
    this.isAlive = deps.holder?.isAlive ?? pidAlive;
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
   * runs while this one's wake is in flight cannot wake the same thing. The marker names its holder
   * (`profile`, `run`, `pid`):
   *   - this run's own marker: reuse it;
   *   - same profile and machine, holder pid gone or equal to ours (restart, crash, reboot, pid 1 in a container): take it over at once;
   *   - same profile and machine, holder pid alive and different: another watcher is running now: skip the thread (the
   *     state etag stops the loser when it writes state), unless the claim outlived the own lease (pid reuse);
   *   - another profile or machine: skip until the lease (plus clock-skew margin) runs out, then take it over.
   * Returns false when the thread must be skipped this tick. Markers are deleted when the adapter fails.
   */
  private async claimWake(peer: string, threadId: string, firstId: string): Promise<boolean> {
    const { selfKv, log } = this.deps;
    const key = k.wakeClaim(peer, threadId, firstId);
    const claim = { v: 1, profile: this.profileId, run: this.runId, pid: this.pid, at: new Date(this.now()).toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await putCreate(selfKv, key, claim);
        return true;
      } catch (error) {
        if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
      }
      const existing = await getJson<{ profile?: unknown; run?: unknown; pid?: unknown; at?: unknown }>(selfKv, key);
      if (!existing) continue; // released between our two calls
      const held = existing.value;
      let takeOver: string | undefined;
      if (held.run === this.runId) return true;
      const age = typeof held.at === 'string' ? this.now() - Date.parse(held.at) : Infinity;
      if (held.profile === this.profileId) {
        // Same profile, same machine, so the same clock. A pid proves liveness only while it is not reused: a live pid
        // that is not a watcher (pid reuse, another user's process), or this very pid number (pid 1 in a container
        // after a restart), would otherwise stall the thread, so the own-profile lease is the backstop.
        if (typeof held.pid !== 'number') takeOver = 'no-pid';
        else if (held.pid === this.pid) takeOver = 'same-pid';
        else if (!this.isAlive(held.pid)) takeOver = 'holder-dead';
        else if (!(age < OWN_CLAIM_LEASE_MS)) takeOver = 'own-lease-expired';
      } else if (!(age < FOREIGN_CLAIM_LEASE_MS)) {
        takeOver = 'lease-expired';
      }
      if (takeOver && existing.etag) {
        try {
          await putMatch(selfKv, key, claim, existing.etag);
          log('claim-taken-over', { peer, threadId, reason: takeOver });
          return true;
        } catch (error) {
          if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
        }
      }
      break;
    }
    log('claimed-elsewhere', { peer, threadId, messageId: firstId });
    return false;
  }

  /** Drops this run's own claim (best effort): a failed wake must not keep the thread from being woken. */
  private async releaseClaim(peer: string, threadId: string, firstId: string): Promise<void> {
    const key = k.wakeClaim(peer, threadId, firstId);
    try {
      const existing = await getJson<{ run?: unknown }>(this.deps.selfKv, key);
      if (existing?.value.run === this.runId) await del(this.deps.selfKv, key);
    } catch (error) {
      this.deps.log('sync-error', { source: 'claim-release', ...errInfo(error) });
    }
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
    // Pause markers are read with every listing, so a `courier resume` or `courier pause` takes effect on the very
    // next message instead of at the next poll (a message delivered while the watcher still thought the thread was
    // paused would never wake anyone).
    const [keys] = await Promise.all([listAll(peerKv, `${PREFIX}/to/${mailbox}/threads/`), this.syncPaused()]);
    const receipts = (await getJson<Receipts>(selfKv, k.receipts(peer.handle)))?.value ?? { v: 1, threads: {} };
    receipts.threads ??= {};

    const delivered: { threadId: string; messageId: string; intent?: string; notice?: string }[] = [];
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
        const view = messageView(value);
        delivered.push({ threadId: selected.threadId, messageId: selected.messageId, intent: view.intent, notice: view.notice });
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
        wakes: Boolean(item.intent && WAKE_INTENTS.has(item.intent)) && !this.pausedKeys.has(`${peer.handle}/${item.threadId}`),
        ...(this.pausedKeys.has(`${peer.handle}/${item.threadId}`) ? { paused: true } : {}),
        sentAt, latencyMs: sentAt ? at - Date.parse(sentAt) : null,
      });
    }
    await this.mutate(() => {
      for (const item of delivered) {
        if (!item.intent || !WAKE_INTENTS.has(item.intent) || this.state.woken.includes(item.messageId)) continue;
        const key = `${peer.handle}/${item.threadId}`;
        if (this.pausedKeys.has(key)) {
          // Delivered and mirrored, but a paused thread never wakes: the message waits for `courier resume`.
          this.hold(key, peer.handle, item.threadId, subjects.get(item.threadId)!, { messageId: item.messageId, intent: item.intent, sentAt: sentAtOf(item.messageId) });
          continue;
        }
        const entry = this.state.pending[key] ??= {
          peer: peer.handle, threadId: item.threadId, subject: subjects.get(item.threadId)!, messages: [], firstSeenAt: at, lastSeenAt: at,
        };
        if (entry.messages.some((m) => m.messageId === item.messageId)) continue;
        entry.messages.push({ messageId: item.messageId, intent: item.intent, sentAt: sentAtOf(item.messageId) });
        entry.lastSeenAt = at;
      }
      // The peer's watcher paused the thread: tell this side's human (their agent is not coming back until resumed).
      // Only a paired peer's `inform` carrying the notice counts, once per thread per UTC day, at most
      // NOTICES_PER_PEER_PER_HOUR per peer: a peer cannot turn this into a stream of notifications or agent runs.
      for (const item of delivered) {
        if (item.notice !== 'thread-paused' || item.intent !== 'inform') continue;
        const key = `${peer.handle}/${item.threadId}`;
        const day = Math.floor(at / DAY_MS);
        if (this.state.peerPausedDay[key] === day) continue;
        const recent = (this.state.noticeLog[peer.handle] ?? []).filter((t) => at - t < 3600_000);
        if (recent.length >= NOTICES_PER_PEER_PER_HOUR) {
          log('notice-dropped', { peer: peer.handle, threadId: item.threadId, reason: 'peer-rate-cap' });
          continue;
        }
        this.state.peerPausedDay[key] = day;
        this.state.noticeLog[peer.handle] = [...recent, at];
        this.enqueue({
          id: `peer-paused:${key}:${day}`, kind: 'notify',
          notice: { kind: 'peer-paused', peer: peer.handle, threadId: item.threadId, detail: "the peer's watcher reported the thread paused" },
        });
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
    if (this.fatalError || this.stopping) return;
    const at = this.now();
    const runs: Promise<void>[] = [];
    for (const [key, pending] of Object.entries(this.state.pending)) {
      if (this.waking.has(key)) continue;
      if (!force && wakeDueAt(pending, this.opts.debounceMs) > at) continue;
      if (!force && (this.retryAt.get(key) ?? 0) > at) continue;
      this.waking.add(key);
      runs.push(this.wakeThread(key, pending, at).finally(() => this.waking.delete(key)));
    }
    runs.push(this.runOutbox());
    await Promise.all(runs);
  }

  /** Spec §8: the budget is per side, per thread, per day. A day is the UTC calendar day, so it is easy to state and to check. */
  private recentWakes(key: string): number[] {
    const today = Math.floor(this.now() / DAY_MS);
    return (this.state.wakes[key] ?? []).filter((at) => Math.floor(at / DAY_MS) === today);
  }

  private async wakeThread(key: string, pending: PendingWake, at: number): Promise<void> {
    if (this.stopping) return; // told to stop: claim nothing, start nothing
    // A `courier pause` written since the last listing must stop a wake that is already queued.
    await this.syncPaused();
    // Messages that land while the wake runs stay pending for the next one, so wake exactly this snapshot.
    let messages = [...pending.messages];
    const approvals = [...(pending.approvals ?? [])];

    // Spec §8: the loop stops here. A paused thread, or one over budget, wakes nobody for messages (approvals are
    // a human decision, not a loop, and always wake).
    if (messages.length) {
      const used = this.recentWakes(key).length;
      if (!this.pausedKeys.has(key) && used >= this.opts.wakeBudget) await this.pauseThread(key, pending, used);
      if (this.pausedKeys.has(key)) {
        // Moved to the held backlog: they wake once, together, after `courier resume`.
        const held = messages;
        const heldIds = held.map((m) => m.messageId);
        messages = [];
        await this.mutate(() => {
          for (const message of held) this.hold(key, pending.peer, pending.threadId, pending.subject, message);
          const current = this.state.pending[key];
          if (!current) return;
          current.messages = current.messages.filter((m) => !heldIds.includes(m.messageId));
          if (!current.messages.length && !(current.approvals ?? []).length) delete this.state.pending[key];
        });
        if (!approvals.length) return;
      }
    }

    const woken = messages.map((m) => m.messageId);
    const approvedIds = approvals.map((a) => a.approvalId);
    const oldestSentAt = messages[0]?.sentAt ?? '';
    // The per-wake claim goes first: a watcher that loses it skips the thread without having written the state, which
    // would otherwise make the watcher that legitimately owns the wake fail its next conditional write. Then the
    // state write: a stale second watcher fails that conditional write and stops before it can wake.
    const claimId = woken[0] ?? approvedIds[0];
    if (!(await this.claimWake(pending.peer, pending.threadId, claimId))) {
      this.retryAt.set(key, at + CLAIM_SKIP_MS);
      return;
    }
    try {
      // The attempt is counted against the budget BEFORE the adapter runs, and whether it then succeeds, fails or
      // times out: an adapter that always throws must not be retried forever. (A crash mid-wake counts too.)
      await this.mutate(() => {
        if (woken.length) this.state.wakes[key] = [...this.recentWakes(key), this.now()];
      });
    } catch (error) {
      await this.releaseClaim(pending.peer, pending.threadId, claimId);
      throw error;
    }
    if (this.stopping) {
      // Told to stop while claiming: start no agent now; the claim is released and the wake stays pending.
      await this.releaseClaim(pending.peer, pending.threadId, claimId);
      return;
    }
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
      // Failures back off: 1, 2, 4, ... minutes, at most 15.
      const failures = (this.wakeFailures.get(key) ?? 0) + 1;
      this.wakeFailures.set(key, failures);
      this.retryAt.set(key, at + Math.min(15 * 60_000, WAKE_RETRY_MS * 2 ** (failures - 1)));
      this.deps.log('wake-error', { peer: pending.peer, threadId: pending.threadId, failures, ...errInfo(error) });
      // The attempt failed, so the thread is not being woken: release the claim (a restart must not wait for it).
      await this.releaseClaim(pending.peer, pending.threadId, claimId);
      return;
    }
    await this.mutate(() => {
      const current = this.state.pending[key];
      if (current) {
        current.messages = current.messages.filter((m) => !woken.includes(m.messageId));
        current.approvals = (current.approvals ?? []).filter((a) => !approvedIds.includes(a.approvalId));
        if (!current.messages.length && !current.approvals.length) delete this.state.pending[key];
      }
      this.state.woken = [...this.state.woken, ...woken].slice(-WAKEN_MEMORY);
    });
    this.wakeFailures.delete(key);
    // Only now, with the wake recorded, is the retry hold-off cleared.
    this.retryAt.delete(key);
    this.deps.log('woke', {
      peer: pending.peer, threadId: pending.threadId, messageIds: woken, approvalIds: approvedIds,
      runMs: this.now() - startedAt,
    });
  }

  /** Budget reached: pause this side's wakes for the thread, tell the peer (inform), tell this side's human. */
  private async pauseThread(key: string, pending: PendingWake, used: number): Promise<void> {
    const reason = `wake budget reached (${used} wakes today, UTC; limit ${this.opts.wakeBudget ?? WATCH_DEFAULTS.wakeBudget} per thread per day)`;
    const at = new Date(this.now()).toISOString();
    const wrote = await this.exclusive(async () => {
      const created = await writePauseMarker(this.deps.selfKv, { v: 1, peer: pending.peer, threadId: pending.threadId, by: 'budget', at, reason });
      this.pausedKeys.add(key);
      return created;
    });
    // The marker already existed (a human pause, or another run): the peer and the human were told then.
    if (!wrote) {
      this.deps.log('paused', { peer: pending.peer, threadId: pending.threadId, by: 'marker-existing' });
      return;
    }
    const text = `Thread paused on this side: ${reason}. Its agent will not be woken for this thread until its owner resumes it. ` +
      'This is an automatic stop for reply loops, not a refusal; messages you send are still stored and mirrored.';
    await this.mutate(() => {
      if (!this.state.paused.includes(key)) this.state.paused.push(key);
      this.enqueue({ id: `inform:${key}:${at}`, kind: 'inform', peer: pending.peer, threadId: pending.threadId, text });
      this.enqueue({ id: `paused:${key}:${at}`, kind: 'notify', notice: { kind: 'paused', peer: pending.peer, threadId: pending.threadId, detail: reason } });
    });
    this.deps.log('paused', { peer: pending.peer, threadId: pending.threadId, by: 'budget', reason });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pausedLock.then(fn, fn);
    this.pausedLock = run.catch(() => undefined);
    return run;
  }

  /** Called inside `mutate`: parks a message that arrived while its thread is paused (bounded). */
  private hold(key: string, peer: string, threadId: string, subject: string, message: WakeMessage): void {
    const entry = this.state.held[key] ??= { peer, threadId, subject, messages: [] };
    if (entry.messages.some((m) => m.messageId === message.messageId)) return;
    entry.messages = [...entry.messages, message].slice(-MAX_HELD_PER_THREAD);
  }

  /** Called inside `mutate`: queues an inform or notification; the outbox is bounded, the oldest item goes first. */
  private enqueue(item: OutboxItem): void {
    this.state.outbox.push(item);
    while (this.state.outbox.length > MAX_OUTBOX) {
      const dropped = this.state.outbox.shift()!;
      this.deps.log('outbox-dropped', { id: dropped.id, reason: 'full' });
    }
  }

  /**
   * Markers under me/state/paused/ are the truth. A marker that disappeared means the human resumed: the budget starts
   * over and what arrived meanwhile wakes the agent once. Serialised, so overlapping calls never apply a stale listing.
   */
  syncPaused(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const keys = await listAll(this.deps.selfKv, k.pausedPrefix);
        const listed = new Set<string>();
        for (const key of keys) {
          const match = /\/paused\/([^/]+)\/([^/]+)\.json$/.exec(key);
          if (match && SAFE_ID.test(match[1]) && SAFE_ID.test(match[2])) listed.add(`${match[1]}/${match[2]}`);
        }
        const before = this.pausedKeys;
        const resumed = this.state.paused.filter((key) => !listed.has(key));
        const added = [...listed].filter((key) => !this.state.paused.includes(key));
        this.pausedKeys = listed;
        for (const key of added) if (!before.has(key)) this.deps.log('paused', { thread: key, by: 'marker' });
        if (resumed.length || added.length) {
          const at = this.now();
          const backlog: Record<string, number> = {};
          await this.mutate(() => {
            for (const key of resumed) {
              delete this.state.wakes[key];
              const held = this.state.held[key];
              if (held?.messages.length) {
                backlog[key] = held.messages.length;
                const entry = this.state.pending[key] ??= { peer: held.peer, threadId: held.threadId, subject: held.subject, messages: [], firstSeenAt: at, lastSeenAt: at };
                for (const message of held.messages) if (!entry.messages.some((m) => m.messageId === message.messageId)) entry.messages.push(message);
                entry.lastSeenAt = at;
              }
              delete this.state.held[key];
            }
            this.state.paused = [...new Set([...this.state.paused.filter((key) => !resumed.includes(key)), ...added])].sort();
          });
          for (const key of resumed) this.deps.log('resumed', { thread: key, backlog: backlog[key] ?? 0 });
        }
      } catch (error) {
        this.deps.log('sync-error', { source: 'paused', ...errInfo(error) });
      }
    });
  }

  /** State that only matters for a day or an hour is dropped, so it cannot grow without bound. */
  private async pruneState(): Promise<void> {
    const at = this.now();
    const today = Math.floor(at / DAY_MS);
    const stale = Object.keys(this.state.wakes).filter((key) => !this.recentWakes(key).length)
      .concat(Object.keys(this.state.peerPausedDay).filter((key) => today - this.state.peerPausedDay[key] > 7))
      .concat(Object.keys(this.state.noticeLog).filter((peer) => !this.state.noticeLog[peer].some((t) => at - t < 3600_000)));
    if (!stale.length) return;
    await this.mutate(() => {
      for (const key of Object.keys(this.state.wakes)) if (!this.recentWakes(key).length) delete this.state.wakes[key];
      for (const key of Object.keys(this.state.peerPausedDay)) if (today - this.state.peerPausedDay[key] > 7) delete this.state.peerPausedDay[key];
      for (const peer of Object.keys(this.state.noticeLog)) if (!this.state.noticeLog[peer].some((t) => at - t < 3600_000)) delete this.state.noticeLog[peer];
    });
  }

  /** Informs and notifications queued in state; failures back off (1, 2, 4 ... 15 minutes) and give up after MAX_OUTBOX_TRIES. */
  private async runOutbox(): Promise<void> {
    const at = this.now();
    const runs: Promise<void>[] = [];
    for (const item of [...this.state.outbox]) {
      if (this.outboxBusy.has(item.id) || (this.outboxRetryAt.get(item.id) ?? 0) > at) continue;
      this.outboxBusy.add(item.id);
      runs.push((async () => {
        try {
          if (item.kind === 'inform') await this.deps.postInform?.(item.peer, item.threadId, item.text);
          else {
            const { notice } = item;
            this.deps.log('notify', { kind: notice.kind, peer: notice.peer, threadId: notice.threadId, detail: notice.detail });
            await this.deps.notify?.(notice);
          }
          this.outboxRetryAt.delete(item.id);
          await this.mutate(() => { this.state.outbox = this.state.outbox.filter((o) => o.id !== item.id); });
        } catch (error) {
          const tries = (item.tries ?? 0) + 1;
          this.deps.log(item.kind === 'inform' ? 'inform-error' : 'notify-error', { id: item.id, tries, ...errInfo(error) });
          if (tries >= MAX_OUTBOX_TRIES) {
            this.outboxRetryAt.delete(item.id);
            this.deps.log('outbox-dropped', { id: item.id, reason: 'too-many-failures' });
            await this.mutate(() => { this.state.outbox = this.state.outbox.filter((o) => o.id !== item.id); });
          } else {
            this.outboxRetryAt.set(item.id, at + Math.min(15 * 60_000, WAKE_RETRY_MS * 2 ** (tries - 1)));
            await this.mutate(() => { const stored = this.state.outbox.find((o) => o.id === item.id); if (stored) stored.tries = tries; });
          }
        } finally {
          this.outboxBusy.delete(item.id);
        }
      })());
    }
    await Promise.all(runs);
  }

  // ---------- run loop ----------

  async pollOnce(via: Via): Promise<void> {
    await this.syncPaused();
    await this.pruneState();
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
    signal.addEventListener('abort', () => { this.stopping = true; }, { once: true });
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
