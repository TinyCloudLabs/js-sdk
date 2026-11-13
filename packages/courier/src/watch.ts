import { isAuthorizationRefusal } from './errors.js';
import { defer } from './defer.js';
import { decodeTime, ulid } from 'ulid';
import type { HookSubscription } from '@tinycloud/node-sdk';
import { errInfo, CourierError } from './errors.js';
import { k, PREFIX, stateKeys, type StateKeys } from './keys.js';
import type { StoredPeer } from './profile.js';
import { isRecord, messageView, oneLine, taskView } from './a2a.js';
import { commitReceipts, selectUndelivered, type KV, type Receipts } from './inbox.js';
import { del, getJson, listAll, putCreate, putMatch, putOverwrite } from './store.js';
import type { WakeApproval, WakeMessage, Waker, WatchLog } from './wake.js';
import { appendNotice, type Notice, type Notifier } from './notify.js';
import { nextNoticeId, writePauseMarker } from './pause.js';
import { HANDLE, ULID } from './request.js';

/** Spec §8. inform and receipts never wake; a message with no valid intent is delivered but never wakes. */
const WAKE_INTENTS = new Set(['request', 'ask', 'answer', 'update']);
const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
]);
const WAKEN_MEMORY = 500;
const WAKE_RETRY_MS = 60_000;
/** Delay between starting a re-opened subscription and its catch-up list, so the stream is live first. */
const RECONNECT_CATCH_UP_MS = 2000;
/** Spec §8: while every hook subscription is healthy, the full catch-up listing runs this often (otherwise every `pollMs`). */
const HEALTHY_RECONCILE_MS = 300_000;
/** The scheduled renewal and authority check (TC-2917): idle revocation detection and sibling cleanup take up to this. */
const AUTHORITY_CHECK_MS = 300_000;
/** A same-agent state conflict: first standby window, doubling to the cap. */
const CONFLICT_STANDBY_MS = 300_000;
const CONFLICT_STANDBY_MAX_MS = 1_800_000;
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
const NOTICES_PER_HOUR = 10;
const NOTICE_RESERVE_PER_PEER = 3;
const MAX_COALESCED_PAUSES = 999999;
const MAX_PEER_CLOCK_SKEW_MS = 10 * 60_000;
const MAX_OUTBOX = 50;
const MAX_OUTBOX_TRIES = 8;
const MAX_NOTICE_ATTEMPTS = 3;
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

interface NoticeRetry {
  /** Six digits while dispatching, otherwise six dashes; independent of the display count. */
  dispatchArrivals: string;
  tries: number;
  nextAttemptAt: number;
  logged: boolean;
}
const emptyNoticeRetry = (): NoticeRetry => ({ dispatchArrivals: '------', tries: 0, nextAttemptAt: 0, logged: false });
const ZERO_ULID = '0'.repeat(26);
const EPOCH = new Date(0).toISOString();
type NeedsKind = 'message' | 'approval';
const needsKind = (kind: Notice['kind']): NeedsKind | undefined =>
  kind === 'new-message' ? 'message' : kind === 'new-approval' ? 'approval' : undefined;
interface NeedsSlot extends NoticeRetry {
  threadId: string;
  eventId: string;
  count: string;
  firstSeenAt: string;
  arrivalFirstSeenAt: string;
}
const emptyNeedsSlot = (): NeedsSlot => ({ threadId: ZERO_ULID, eventId: ZERO_ULID, count: '000000',
  firstSeenAt: EPOCH, arrivalFirstSeenAt: EPOCH, ...emptyNoticeRetry() });
const needsKey = (peer: string, kind: NeedsKind) => `needs:${peer}:${kind}`;

interface PauseEpisode extends NoticeRetry {
  kind: '' | 'paused' | 'peer-paused';
  eventId: string;
  /** Fixed-width saturating count of additional transitions represented by this slot. */
  repeats: string;
}
const emptyEpisode = (): PauseEpisode => ({ kind: '', eventId: ZERO_ULID, repeats: '000000', ...emptyNoticeRetry() });
const incrementCount = (count: string) => String(Math.min(MAX_COALESCED_PAUSES, Number(count) + 1)).padStart(6, '0');
const episodeKey = (key: string, slot: number) => `notice:${key}:${slot}`;

/** Allocated only from our own thread/wake/pause records, never from incoming notice ids. */
interface ThreadNoticeState {
  ourPaused: boolean;
  peerPaused: boolean;
  lastPeerNoticeId: string;
  lastNoticeSentAt: string;
  ourMarkerId: string;
  episodes: [PauseEpisode, PauseEpisode];
  informPending: boolean;
  informText: string;
}

function threadNoticeState(): ThreadNoticeState {
  return { ourPaused: false, peerPaused: false, lastPeerNoticeId: '0'.repeat(26), lastNoticeSentAt: new Date(0).toISOString(),
    ourMarkerId: '', episodes: [emptyEpisode(), emptyEpisode()], informPending: false, informText: '' };
}

export interface WatchState {
  v: 1;
  /** Keyed `<peer>/<threadId>`. */
  pending: Record<string, PendingWake>;
  /** Recently woken message ids, so a receipt write that failed cannot cause a second wake. */
  woken: string[];
  approvalsSeen: string[];
  /** Message wake attempts today (UTC), per `<peer>/<threadId>`, as epoch ms (approval wakes do not count). */
  wakes: Record<string, number[]>;
  /** Threads this watcher has seen paused; a marker that vanishes from this list means the human resumed it. */
  paused: string[];
  /** Failed wake count and completion-based backoff, retained across watcher restarts. */
  wakeRetries: Record<string, { failures: number; nextAttemptAt: number }>;
  approvalRetries: Record<string, { failures: number; nextAttemptAt: number }>;
  /** Posts and notifications that must happen exactly-ish once and survive a restart (retried until they succeed). */
  outbox: OutboxItem[];
  held: Record<string, HeldBacklog>;
  /** One fixed record per locally known thread. Peer ids are values, never keys. */
  threadNotices: Record<string, ThreadNoticeState>;
  /** Two coalescing needs-you slots per locally paired peer, allocated only from local configuration. */
  peerNotices: Record<string, Record<NeedsKind, NeedsSlot>>;
  noticeGlobalLog: number[];
  /** Every dispatch attempt, success or failure, per peer for the shared rolling-hour cap. */
  noticeLog: Record<string, number[]>;
}

/** `tries`: notification dispatch attempts (max 3), or failed inform attempts (max 8). */
export type OutboxItem =
  | { id: string; kind: 'inform'; peer: string; threadId: string; text: string; pauseId?: string; tries?: number; nextAttemptAt?: number }
  | { id: string; kind: 'notify'; notice: Notice; tries?: number; nextAttemptAt?: number; logged?: boolean };

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
  /** Local owner checks, before startup and every cycle; throws to stop the watcher. */
  beforePoll?(): Promise<void>;
  /**
   * Renewal and authority checks against the node: one peer, or every peer when `handle` is omitted. Runs at startup,
   * every cycle, and before anything is imported from a peer whose last check is older than `pollMs`.
   */
  checkAuthority?(handle?: string): Promise<void>;
  onAuthorityRefusal?(source: string): Promise<void>;
  selfKv: KV;
  /**
   * This side's Courier agent DID. Its watch state, pause markers and wake claims live under its own keys
   * (`stateKeys`), so two agents of one owner in one space never share them. Omitted: the shared `me/state/` keys.
   */
  agent?: string;
  /** Own space id, for the `me/approvals/` subscription. */
  spaceId: string;
  /** The owner's own space. */
  selfHooks: HooksLike;
  /** A peer's space, through the peer delegation (each peer streams independently: one refused scope must not stall the rest). */
  peerHooks(peer: StoredPeer): Promise<HooksLike>;
  /** Fresh peer list each call (pairing and renewals change the profile under a running watcher). */
  loadPeers(): StoredPeer[];
  /** `renew`: also read the peer's renewal marker (on the renewal schedule, a marker hook event, or a refusal). */
  kvFor(peer: StoredPeer, renew?: boolean): Promise<KV>;
  wake: Waker;
  log: WatchLog;
  /** Posts the `thread-paused` inform to a peer (own space, `to/<peer>/threads/<id>/msg/`). Default: nothing. */
  postInform?(peer: string, threadId: string, text: string, pauseId?: string): Promise<void>;
  /** Tells this side's human without a model (desktop notification or operator command). Default: log only. */
  notify?: Notifier;
  /** Local bounded notification log; omitted by library callers that want no disk output. */
  notificationHome?: string;
  /** D mode mirrors and receipts, then notifies without invoking a wake adapter. */
  notifyOnly?: boolean;
  /**
   * Who this watcher is, for wake claims. `profileId` is stable for this profile on this machine (a restart keeps it,
   * a second profile or machine differs); `pid` and `isAlive` tell a restarted watcher its predecessor is dead.
   */
  holder?: { profileId: string; pid?: number; isAlive?(pid: number): boolean };
  now?(): number;
}

type Via = 'startup' | 'hook' | 'poll';

export function emptyWatchState(): WatchState {
  return { v: 1, pending: {}, woken: [], approvalsSeen: [], wakes: {}, paused: [], wakeRetries: {}, approvalRetries: {}, outbox: [], held: {}, threadNotices: {}, peerNotices: {}, noticeGlobalLog: [], noticeLog: {} };
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
  /** Thread keys currently paused: this agent's pause markers plus those this watcher just wrote. */
  private pausedKeys = new Set<string>();
  /** Serialises everything that reads or writes pause markers, so a stale listing cannot drop a pause just written. */
  private pausedLock: Promise<unknown> = Promise.resolve();
  private readonly outboxBusy = new Set<string>();
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
  /** Etag of this agent's watch.json as this watcher last saw it: null = absent, undefined = unknown (fetch before writing). */
  private stateEtag: string | null | undefined;
  private readonly taskCache = new Map<string, { etag: string | null; terminal: boolean }>();
  private readonly metaMirrored = new Set<string>();
  private readonly syncing = new Map<string, { again: boolean; via: Via; listPaused: boolean }>();
  /** Peers whose last sync did not finish: a cycle between full catch-ups lists only these again. */
  private readonly dirtyPeers = new Set<string>();
  private approvalsDirty = false;
  /** Peers whose next sync also reads their renewal marker. */
  private readonly renewalDue = new Set<string>();
  /** Peers whose delegation changed (a marker hook event): their next sync checks authority before anything else. */
  private readonly authorityDue = new Set<string>();
  /** When each peer's authority was last checked against the node. */
  private readonly authorityAt = new Map<string, number>();
  /** Open hook streams by subscription id; absent while one is failed, ended or not yet opened. */
  private readonly hookStreams = new Map<string, { openedAt: number; proven: boolean }>();
  /** Message keys each peer's receipts already list; receipts only grow, so a listing within this set has nothing new. */
  private readonly receipted = new Map<string, Set<string>>();
  private stateQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly keys: StateKeys;

  constructor(private readonly deps: WatchDeps, private readonly opts: WatchOptions = WATCH_DEFAULTS) {
    this.now = deps.now ?? Date.now;
    this.profileId = deps.holder?.profileId ?? this.runId;
    this.pid = deps.holder?.pid ?? process.pid;
    this.isAlive = deps.holder?.isAlive ?? pidAlive;
    this.keys = stateKeys(deps.agent);
  }

  /**
   * Before TC-2917 every agent of the owner shared `me/state/`. On an agent's first start its own keys get a copy of
   * what concerns its own peers: pause markers first, then watch.json, whose existence marks the move done. Every
   * write is create-only, so a crash or a second process repeats it harmlessly; the shared keys are left in place.
   */
  private async migrateLegacyState(): Promise<void> {
    const { selfKv, log } = this.deps;
    if (!this.deps.agent || await getJson(selfKv, this.keys.watch)) return;
    const mine = new Set(this.deps.loadPeers().map(peer => peer.handle));
    const ownKey = (key: string) => mine.has(key.split('/')[0]);
    let markers = 0;
    for (const key of await listAll(selfKv, k.pausedPrefix)) {
      const match = /\/paused\/([^/]+)\/([^/]+)\.json$/.exec(key);
      if (!match || !SAFE_ID.test(match[1]) || !SAFE_ID.test(match[2]) || !mine.has(match[1])) continue;
      const marker = await getJson<unknown>(selfKv, key);
      if (!marker) continue;
      await this.mirrorCreate(this.keys.paused(match[1], match[2]), marker.value);
      markers++;
    }
    const legacy = (await getJson<WatchState>(selfKv, k.watchState))?.value;
    const state: WatchState = isRecord(legacy) && legacy.v === 1 ? { ...emptyWatchState(), ...(legacy as Partial<WatchState>) } : emptyWatchState();
    const byThread = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => ownKey(key)));
    const byPeer = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record ?? {}).filter(([peer]) => mine.has(peer)));
    const copy: WatchState = {
      ...state,
      pending: byThread(state.pending), wakes: byThread(state.wakes), wakeRetries: byThread(state.wakeRetries),
      approvalRetries: byThread(state.approvalRetries), held: byThread(state.held), threadNotices: byThread(state.threadNotices),
      paused: (state.paused ?? []).filter(ownKey), peerNotices: byPeer(state.peerNotices), noticeLog: byPeer(state.noticeLog),
      outbox: (state.outbox ?? []).filter(item => mine.has(item.kind === 'inform' ? item.peer : item.notice.peer)),
    };
    await this.mirrorCreate(this.keys.watch, copy);
    log('state-migrated', { pending: Object.keys(copy.pending).length, paused: markers });
  }

  // ---------- state ----------

  async loadState(): Promise<void> {
    const got = await getJson<WatchState>(this.deps.selfKv, this.keys.watch);
    const value = got?.value;
    this.stateEtag = got?.etag ?? null;
    this.state = isRecord(value) && value.v === 1
      ? { ...emptyWatchState(), ...(value as Partial<WatchState>) }
      : emptyWatchState();
    // Discard the old per-peer-generation map; it was sized by untrusted ids.
    delete (this.state as WatchState & { peerPausedDay?: unknown }).peerPausedDay;
    for (const key of [...Object.keys(this.state.wakes), ...this.state.paused]) {
      const [peer, threadId] = key.split('/');
      if (peer && threadId && SAFE_ID.test(peer) && SAFE_ID.test(threadId)) {
        const record = this.state.threadNotices[key] ??= threadNoticeState();
        record.ourPaused = this.state.paused.includes(key);
      }
    }
    this.syncNoticePeers();
    for (const record of Object.values(this.state.peerNotices)) for (const slot of Object.values(record)) slot.dispatchArrivals = '------';
    // Upgrade the previous single-pending record while retaining its attempt/deadline metadata.
    for (const [key, record] of Object.entries(this.state.threadNotices)) {
      const old = record as ThreadNoticeState & { ourNoticePending?: boolean; peerNoticePending?: boolean; peerNoticeId?: string };
      if (!record.episodes) {
        record.episodes = [emptyEpisode(), emptyEpisode()];
        for (const item of this.state.outbox) {
          if (item.kind !== 'notify' || `${item.notice.peer}/${item.notice.threadId}` !== key
            || (item.notice.kind !== 'paused' && item.notice.kind !== 'peer-paused')
            || item.id !== `${item.notice.kind}:${key}` || !item.notice.eventId) continue;
          this.queueEpisode(record, item.notice.kind, item.notice.eventId);
        }
        if (old.ourNoticePending) this.queueEpisode(record, 'paused', record.ourMarkerId);
        if (old.peerNoticePending && old.peerNoticeId) this.queueEpisode(record, 'peer-paused', old.peerNoticeId);
      }
      record.episodes = record.episodes.map(episode =>
        ({ ...emptyEpisode(), ...episode, dispatchArrivals: '------' })) as [PauseEpisode, PauseEpisode];
      delete old.ourNoticePending; delete old.peerNoticePending; delete old.peerNoticeId;
    }
    this.state.outbox = this.state.outbox.filter(item => {
      if (item.kind === 'inform') return true;
      const kind = needsKind(item.notice.kind);
      if (kind) {
        const slot = this.noticeSlot(item);
        if (!slot || item.id !== needsKey(item.notice.peer, kind)) return false;
        this.rememberNotice(item);
        return true;
      }
      const key = `${item.notice.peer}/${item.notice.threadId}`;
      const record = this.state.threadNotices[key];
      const slot = record?.episodes.findIndex(episode => episode.kind === item.notice.kind && episode.eventId === item.notice.eventId) ?? -1;
      if (slot < 0 || (item.id !== `${item.notice.kind}:${key}` && item.id !== episodeKey(key, slot))) return false;
      item.id = episodeKey(key, slot);
      item.notice.repeats ??= record.episodes[slot].repeats;
      this.rememberNotice(item);
      return true;
    });
    for (const item of [...this.state.outbox]) {
      if ((item.tries ?? 0) >= (item.kind === 'notify' ? MAX_NOTICE_ATTEMPTS : MAX_OUTBOX_TRIES)) this.finishOutbox(item);
    }
    this.state.outbox = this.state.outbox.slice(-MAX_OUTBOX);
  }

  snapshot(): WatchState {
    return structuredClone(this.state);
  }

  /**
   * Serialised: callers mutate `this.state` inside `fn`, then it is written with if-match against the etag this
   * watcher last saw. A second `watch` for the same agent therefore fails with `state-conflict` instead of
   * silently overwriting (last writer wins) the other's pending wakes.
   */
  private mutate<T>(fn: () => T): Promise<T> {
    const run = this.stateQueue.then(async () => {
      const result = fn();
      const { selfKv } = this.deps;
      if (this.stateEtag === undefined) this.stateEtag = (await getJson<WatchState>(selfKv, this.keys.watch))?.etag ?? null;
      try {
        const written = this.stateEtag
          ? await putMatch(selfKv, this.keys.watch, this.state, this.stateEtag)
          : await putCreate(selfKv, this.keys.watch, this.state);
        this.stateEtag = written ?? undefined;
      } catch (error) {
        if (error instanceof CourierError && error.code === 'conflict') {
          throw this.stateConflict('watch.json was changed by another process: a second `watch` is running for this Courier agent.');
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
    const key = this.keys.wakeClaim(peer, threadId, firstId);
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
    const key = this.keys.wakeClaim(peer, threadId, firstId);
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
      for (const key of await listAll(this.deps.selfKv, this.keys.wakeClaimsPrefix)) {
        const id = /\/([^/]+)\.json$/.exec(key)?.[1];
        const sentAt = id ? Date.parse(sentAtOf(id)) : NaN;
        if (Number.isFinite(sentAt) && this.now() - sentAt > 2 * DAY_MS) await del(this.deps.selfKv, key);
      }
    } catch (error) {
      this.deps.log('sync-error', { source: 'claims', ...errInfo(error) });
    }
  }

  // ---------- catch-up and delivery ----------

  /**
   * Serialises syncs per peer; a request that arrives mid-sync reruns once after it. `pausedListed`: the caller has
   * just listed the pause markers for this cycle, so the sync shares that listing instead of making its own.
   */
  async sync(peer: StoredPeer, via: Via, pausedListed = false): Promise<void> {
    const running = this.syncing.get(peer.handle);
    if (running) {
      running.again = true;
      running.listPaused ||= !pausedListed;
      return;
    }
    const entry = { again: false, via, listPaused: !pausedListed };
    this.syncing.set(peer.handle, entry);
    try {
      do {
        entry.again = false;
        const listPaused = entry.listPaused;
        entry.listPaused = false;
        const renew = this.renewalDue.has(peer.handle);
        this.dirtyPeers.delete(peer.handle);
        try {
          await this.syncPeer(peer, entry.via, listPaused, renew);
        } catch (error) {
          if (!isAuthorizationRefusal(error)) {
            this.dirtyPeers.add(peer.handle);
            this.deps.log('sync-error', { peer: peer.handle, ...errInfo(error) });
            continue;
          }
          let renewed: StoredPeer | undefined;
          try {
            renewed = await this.afterRefusal(peer, renew);
          } catch (failure) {
            // Neither renewed nor refused for certain: retried by the next cycle, nothing recorded.
            this.dirtyPeers.add(peer.handle);
            this.deps.log('sync-error', { peer: peer.handle, ...errInfo(failure) });
            continue;
          }
          if (!renewed) {
            await this.deps.onAuthorityRefusal?.(`peer:${peer.handle}`);
            return;
          }
          peer = renewed;
          entry.again = true;
        }
      } while (entry.again);
    } finally {
      this.syncing.delete(peer.handle);
    }
  }

  /**
   * A refusal may mean the peer moved to a new grant or revoked ours. Re-read its renewal marker (unless this sync just
   * did) and check its authority at once. Returns the peer to retry only under a different grant, never the refused one.
   */
  private async afterRefusal(peer: StoredPeer, markerRead: boolean): Promise<StoredPeer | undefined> {
    const refused = peer.inbound?.cid;
    try {
      if (!markerRead) {
        await this.deps.kvFor(peer, true);
        this.renewalDue.delete(peer.handle);
      }
      await this.checkPeerAuthority(peer.handle);
    } catch (error) {
      if (isAuthorizationRefusal(error)) return undefined;
      throw error;
    }
    const current = this.deps.loadPeers().find(candidate => candidate.handle === peer.handle);
    return current?.inbound && current.inbound.cid !== refused ? current : undefined;
  }

  private async checkPeerAuthority(handle: string): Promise<void> {
    if (!this.deps.checkAuthority) return;
    const at = this.now();
    await this.deps.checkAuthority(handle);
    this.authorityAt.set(handle, at);
  }

  /** What a peer sent is imported only under authority checked within the last `pollMs`; false once the peer is gone. */
  private async authorized(peer: StoredPeer): Promise<boolean> {
    if (!this.deps.checkAuthority) return true;
    if (!(this.now() - (this.authorityAt.get(peer.handle) ?? -Infinity) < this.opts.pollMs)) await this.checkPeerAuthority(peer.handle);
    return this.deps.loadPeers().some(current => current.handle === peer.handle);
  }

  /** The scheduled renewal and authority check for every peer; each peer's next sync also reads its renewal marker. */
  private async checkAuthority(): Promise<void> {
    const at = this.now();
    const peers = this.deps.loadPeers();
    if (this.deps.checkAuthority) {
      await this.deps.checkAuthority();
      for (const peer of peers) this.authorityAt.set(peer.handle, at);
    }
    for (const peer of peers) this.renewalDue.add(peer.handle);
  }

  private async syncPeer(peer: StoredPeer, via: Via, listPaused: boolean, renew: boolean): Promise<void> {
    if (peer.status !== 'paired' || !peer.inbound || !peer.theirHandleForMe) return;
    const { selfKv, log } = this.deps;
    const mailbox = peer.theirHandleForMe;
    const peerKv = await this.deps.kvFor(peer, renew);
    if (renew) this.renewalDue.delete(peer.handle);
    if (this.authorityDue.delete(peer.handle)) {
      try { await this.checkPeerAuthority(peer.handle); } catch (error) { this.authorityDue.add(peer.handle); throw error; }
    }
    let allowed: Promise<boolean> | undefined;
    const authorized = () => allowed ??= this.authorized(peer);
    // Pause markers are read with every listing (a cycle lists them once for all its peers just before), so a
    // `courier resume` or `courier pause` takes effect on the very next message instead of at the next poll (a
    // message delivered while the watcher still thought the thread was paused would never wake anyone).
    const prefix = peer.sessionId ? `${k.threadRoot(mailbox, peer.sessionId)}/` : `${PREFIX}/to/${mailbox}/threads/`;
    const [keys] = await Promise.all([listAll(peerKv, prefix), listPaused ? this.syncPaused() : undefined]);
    // Receipts are read only when the listing holds a message they were not already known to cover.
    const seen = this.receipted.get(peer.handle) ?? new Set<string>();
    const unseen = selectUndelivered(keys, { v: 1, threads: {} }).filter(item => !seen.has(`${item.threadId}/${item.messageId}`));
    let receipts: Receipts = { v: 1, threads: {} };
    if (unseen.length) {
      receipts = (await getJson<Receipts>(selfKv, k.receipts(peer.handle)))?.value ?? receipts;
      receipts.threads ??= {};
      for (const [threadId, thread] of Object.entries(receipts.threads)) for (const id of thread.delivered ?? []) seen.add(`${threadId}/${id}`);
      this.receipted.set(peer.handle, seen);
    }

    const delivered: { threadId: string; messageId: string; intent?: string; notice?: string }[] = [];
    for (const selected of unseen.filter(item => !seen.has(`${item.threadId}/${item.messageId}`))) {
      if (!SAFE_ID.test(selected.threadId) || !SAFE_ID.test(selected.messageId)) {
        log('ignored', { peer: peer.handle, reason: 'unsafe-id' });
        continue;
      }
      if (!(await authorized())) return;
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
        this.dirtyPeers.add(peer.handle);
        log('sync-error', { peer: peer.handle, messageId: selected.messageId, ...errInfo(error) });
      }
    }
    if (!delivered.length) {
      await this.mirrorThreads(peer, peerKv, keys, authorized);
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
        wakes: !this.deps.notifyOnly && Boolean(item.intent && WAKE_INTENTS.has(item.intent)) && !this.pausedKeys.has(`${peer.handle}/${item.threadId}`),
        ...(this.pausedKeys.has(`${peer.handle}/${item.threadId}`) ? { paused: true } : {}),
        sentAt, latencyMs: sentAt ? at - Date.parse(sentAt) : null,
      });
    }
    // Only our local listing establishes a known thread, and only a peer's pause notice needs one.
    if (delivered.some(item => item.intent === 'inform' && (item.notice === 'thread-paused' || item.notice === 'thread-resumed'))) {
      await this.syncKnownThreads(peer);
    }
    await this.mutate(() => {
      if (this.deps.notifyOnly) {
        this.syncNoticePeers();
        for (const item of [...delivered].sort((a, b) => a.messageId.localeCompare(b.messageId))) {
          if (item.intent && item.notice !== 'thread-paused' && item.notice !== 'thread-resumed') {
            this.queueNeeds(peer.handle, 'message', item.threadId);
          }
        }
      }
      for (const item of delivered) {
        if (this.deps.notifyOnly || !item.intent || !WAKE_INTENTS.has(item.intent) || this.state.woken.includes(item.messageId)) continue;
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
      // Only our local listing establishes a known thread. The peer controls its own state, not allocation.
      for (const item of delivered) {
        if (item.intent !== 'inform' || (item.notice !== 'thread-paused' && item.notice !== 'thread-resumed')) continue;
        const record = this.state.threadNotices[`${peer.handle}/${item.threadId}`];
        if (!record || !ULID.test(item.messageId) || item.messageId <= record.lastPeerNoticeId) continue;
        let sentAt: number;
        try { sentAt = decodeTime(item.messageId); } catch { continue; } // ULID's high bits must fit 128 bits
        if (sentAt > at + MAX_PEER_CLOCK_SKEW_MS) continue;
        record.lastPeerNoticeId = item.messageId;
        const paused = item.notice === 'thread-paused';
        if (paused && !record.peerPaused) this.queueEpisode(record, 'peer-paused', item.messageId);
        record.peerPaused = paused;
      }
      this.fillOutbox();
    });
    await commitReceipts(selfKv, new Map([[peer.handle, delivered.map(({ threadId, messageId }) => ({ threadId, messageId }))]]));
    for (const item of delivered) seen.add(`${item.threadId}/${item.messageId}`);
    await this.mirrorThreads(peer, peerKv, keys, authorized);
  }

  /** Only locally authored meta/messages/tasks, or a local wake/pause witness, establish a known thread. */
  private async syncKnownThreads(peer: StoredPeer): Promise<void> {
    const prefix = `${PREFIX}/to/${peer.handle}/threads/`;
    const keys = await listAll(this.deps.selfKv, prefix);
    const known = new Set<string>();
    for (const path of keys) {
      const match = /^([^/]+)\/(?:meta\.json|(?:msg|task)\/[^/]+\.json)$/.exec(path.slice(prefix.length));
      if (match && SAFE_ID.test(match[1])) known.add(`${peer.handle}/${match[1]}`);
    }
    for (const key of Object.keys(this.state.wakes)) if (key.startsWith(`${peer.handle}/`)) known.add(key);
    const missing = [...known].filter(key => !this.state.threadNotices[key]);
    if (missing.length) await this.mutate(() => {
      for (const key of missing) this.state.threadNotices[key] ??= threadNoticeState();
    });
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
  private async mirrorThreads(peer: StoredPeer, peerKv: KV, keys: string[], authorized: () => Promise<boolean>): Promise<void> {
    for (const key of keys) {
      try {
        await this.mirrorThreadItem(peer, peerKv, key, authorized);
      } catch (error) {
        this.dirtyPeers.add(peer.handle);
        this.deps.log('mirror-error', { peer: peer.handle, ...errInfo(error) });
      }
    }
  }

  private async mirrorThreadItem(peer: StoredPeer, peerKv: KV, key: string, authorized: () => Promise<boolean>): Promise<void> {
    const meta = /\/threads\/([^/]+)\/meta\.json$/.exec(key);
    if (meta) {
      if (!SAFE_ID.test(meta[1])) return;
      if (this.metaMirrored.has(key)) return;
      const got = await getJson<unknown>(peerKv, key);
      if (!got) return;
      if (!(await authorized())) return;
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
    if (!(await authorized())) return;
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
        this.approvalsDirty = false;
        try {
          await this.syncApprovalsOnce(via);
        } catch (error) {
          this.approvalsDirty = true;
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
          log('approval-seen', { via, approvalId: id, wakes: !this.deps.notifyOnly, notifies: Boolean(this.deps.notifyOnly), decision: found.wake.approval.decision });
        } else {
          log('approval-seen', { via, approvalId: id, wakes: false, reason: found.skip });
        }
        handled.push(id);
      } catch (error) {
        // Unread (transient failure): left unseen so the next sync retries it.
        this.approvalsDirty = true;
        log('sync-error', { source: 'approvals', approvalId: id, ...errInfo(error) });
      }
    }
    if (!handled.length) return;
    const at = this.now();
    await this.mutate(() => {
      this.state.approvalsSeen = [...new Set([...this.state.approvalsSeen, ...handled])].sort();
      if (this.deps.notifyOnly) this.syncNoticePeers();
      for (const { approval, peer, threadId, subject } of wakes) {
        if (this.deps.notifyOnly) { this.queueNeeds(peer, 'approval', threadId); continue; }
        const key = `${peer}/${threadId}`;
        const entry = this.state.pending[key] ??= { peer, threadId, subject, messages: [], firstSeenAt: at, lastSeenAt: at };
        entry.approvals ??= [];
        if (!entry.approvals.some((a) => a.approvalId === approval.approvalId)) entry.approvals.push(approval);
        entry.lastSeenAt = at;
      }
      if (this.deps.notifyOnly) this.fillOutbox();
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
    if (this.deps.notifyOnly) {
      // Switching to D mode converts the prior local backlog into the same fixed peer slots.
      if (Object.keys(this.state.pending).length) await this.mutate(() => {
        this.syncNoticePeers();
        for (const pending of Object.values(this.state.pending)) {
          for (const _message of pending.messages) this.queueNeeds(pending.peer, 'message', pending.threadId);
          for (const _approval of pending.approvals ?? []) this.queueNeeds(pending.peer, 'approval', pending.threadId);
        }
        this.state.pending = {};
        this.fillOutbox();
      });
      await this.runOutbox();
      return;
    }
    const at = this.now();
    const runs: Promise<void>[] = [];
    for (const [key, pending] of Object.entries(this.state.pending)) {
      if (this.waking.has(key)) continue;
      if (!force && wakeDueAt(pending, this.opts.debounceMs) > at) continue;
      if (!force && !pending.approvals?.length && (this.retryAt.get(key) ?? 0) > at) continue;
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
    let approvals = [...(pending.approvals ?? [])];

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

    // Owner decisions have their own retry clock. A failed message adapter cannot delay an approval.
    if ((this.state.wakeRetries[key]?.nextAttemptAt ?? 0) > at) messages = [];
    if ((this.state.approvalRetries[key]?.nextAttemptAt ?? 0) > at) approvals = [];
    if (!messages.length && !approvals.length) return;

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
        this.state.threadNotices[key] ??= threadNoticeState();
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
      let failures = 0;
      await this.mutate(() => {
        for (const retries of [ ...(woken.length ? [this.state.wakeRetries] : []), ...(approvedIds.length ? [this.state.approvalRetries] : []) ]) {
          const count = (retries[key]?.failures ?? 0) + 1;
          retries[key] = { failures: count, nextAttemptAt: this.now() + Math.min(15 * 60_000, WAKE_RETRY_MS * 2 ** (count - 1)) };
          failures = Math.max(failures, count);
        }
      });
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
      if (woken.length) delete this.state.wakeRetries[key];
      if (approvedIds.length) delete this.state.approvalRetries[key];
    });
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
    const pauseId = await nextNoticeId(this.deps.selfKv, pending.peer, pending.threadId, this.now());
    const wrote = await this.exclusive(async () => {
      const created = await writePauseMarker(this.deps.selfKv, { v: 1, peer: pending.peer, threadId: pending.threadId, by: 'budget', at, reason, informId: pauseId }, this.keys.paused(pending.peer, pending.threadId));
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
      const record = this.state.threadNotices[key] ??= threadNoticeState();
      Object.assign(record, { ourPaused: true, ourMarkerId: pauseId, informPending: true, informText: text });
      this.queueEpisode(record, 'paused', pauseId);
      this.fillOutbox();
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

  /** Two episode values per known thread. Additional transitions coalesce, without allocating another slot. */
  private queueEpisode(record: ThreadNoticeState, kind: 'paused' | 'peer-paused', eventId: string): void {
    if (!ULID.test(eventId) || record.episodes.some(episode => episode.kind === kind && episode.eventId === eventId)) return;
    const slot = record.episodes.find(episode => !episode.kind);
    if (slot) Object.assign(slot, emptyEpisode(), { kind, eventId });
    else {
      const last = record.episodes[1];
      last.repeats = incrementCount(last.repeats);
      if (last.dispatchArrivals !== '------') last.dispatchArrivals = incrementCount(last.dispatchArrivals);
    }
  }

  /** Only the paired handles in our local configuration allocate needs-you state. */
  private syncNoticePeers(): void {
    const paired = new Set(this.deps.loadPeers().filter(peer => peer.status === 'paired' && HANDLE.test(peer.handle)).map(peer => peer.handle));
    for (const peer of Object.keys(this.state.peerNotices)) if (!paired.has(peer)) delete this.state.peerNotices[peer];
    if (this.deps.notifyOnly) for (const peer of paired) {
      if (!Object.hasOwn(this.state.peerNotices, peer)) this.state.peerNotices[peer] = { message: emptyNeedsSlot(), approval: emptyNeedsSlot() };
    }
    for (const record of Object.values(this.state.peerNotices)) for (const kind of ['message', 'approval'] as const) {
      record[kind] = { ...emptyNeedsSlot(), ...record[kind] };
    }
  }

  /** Bounded values only: a later delivery updates the same paired-peer slot. Called inside mutate. */
  private queueNeeds(peer: string, kind: NeedsKind, threadId: string): void {
    const slot = this.state.peerNotices[peer]?.[kind];
    if (!slot || !ULID.test(threadId)) return;
    try { decodeTime(threadId); } catch { return; }
    const at = new Date(this.now()).toISOString();
    if (slot.count === '000000') { slot.eventId = ulid(this.now()); slot.firstSeenAt = at; }
    slot.threadId = threadId;
    slot.count = incrementCount(slot.count);
    if (slot.dispatchArrivals !== '------') {
      if (slot.dispatchArrivals === '000000') slot.arrivalFirstSeenAt = at;
      slot.dispatchArrivals = incrementCount(slot.dispatchArrivals);
    }
  }

  private noticeSlot(item: Extract<OutboxItem, { kind: 'notify' }>): PauseEpisode | NeedsSlot | undefined {
    const kind = needsKind(item.notice.kind);
    if (kind) {
      const slot = this.state.peerNotices[item.notice.peer]?.[kind];
      return slot?.count !== '000000' && slot?.eventId === item.notice.eventId ? slot : undefined;
    }
    return this.state.threadNotices[`${item.notice.peer}/${item.notice.threadId}`]?.episodes.find(episode =>
      episode.kind === item.notice.kind && episode.eventId === item.notice.eventId);
  }

  private rememberNotice(item: Extract<OutboxItem, { kind: 'notify' }>): void {
    const episode = this.noticeSlot(item);
    if (episode) Object.assign(episode, { tries: item.tries ?? 0, nextAttemptAt: item.nextAttemptAt ?? 0, logged: item.logged ?? false });
  }

  /** Earliest rolling-hour retry under the global allowance and each paired peer's share. */
  private noticeRateDeadline(peer: string, now = this.now()): number {
    const recent = (this.state.noticeLog[peer] ?? []).filter(t => now - t < 3600_000);
    const global = this.state.noticeGlobalLog.filter(t => now - t < 3600_000);
    const peers = [...new Set([...this.deps.loadPeers().filter(peer => peer.status === 'paired').map(peer => peer.handle), peer])];
    const share = Math.min(NOTICE_RESERVE_PER_PEER, Math.floor(NOTICES_PER_HOUR / peers.length));
    const reservedForOthers = peers.filter(other => other !== peer).reduce((reserved, other) =>
      reserved + Math.max(0, share - (this.state.noticeLog[other] ?? []).filter(t => now - t < 3600_000).length), 0);
    if (recent.length < NOTICES_PER_PEER_PER_HOUR && global.length + reservedForOthers < NOTICES_PER_HOUR) return 0;
    return Math.max(recent.length >= NOTICES_PER_PEER_PER_HOUR ? Math.min(...recent) + 3600_000 : 0,
      global.length ? Math.min(...global) + 3600_000 : now + 3600_000);
  }

  /** -1 appends; a nonnegative index yields that place; undefined leaves the pending slot alone. */
  private admissionIndex(item: OutboxItem): number | undefined {
    if (this.state.outbox.some(existing => existing.id === item.id)) return undefined;
    if (this.state.outbox.length < MAX_OUTBOX) return -1;
    const now = this.now();
    const eligible = item.kind === 'inform' || ((item.nextAttemptAt ?? 0) <= now && !this.noticeRateDeadline(item.notice.peer, now));
    if (!eligible) return undefined;
    const deferred = this.state.outbox.findIndex(existing => existing.kind === 'notify' && !this.outboxBusy.has(existing.id)
      && ((existing.nextAttemptAt ?? 0) > now || this.noticeRateDeadline(existing.notice.peer, now) > now));
    if (deferred >= 0) return deferred;
    if (item.kind === 'notify') {
      const counts = new Map<string, number>();
      for (const existing of this.state.outbox) if (existing.kind === 'notify') counts.set(existing.notice.peer, (counts.get(existing.notice.peer) ?? 0) + 1);
      const own = counts.get(item.notice.peer) ?? 0;
      const overrepresented = this.state.outbox.findIndex(existing => existing.kind === 'notify'
        && existing.notice.peer !== item.notice.peer && (counts.get(existing.notice.peer) ?? 0) > own + 1
        && existing.notice.kind !== 'paused' && !existing.tries && !this.outboxBusy.has(existing.id));
      if (overrepresented >= 0) return overrepresented;
    }
    if (item.kind === 'inform' || item.notice.kind === 'paused') {
      const unattempted = this.state.outbox.findIndex(existing => existing.kind === 'notify' && existing.notice.kind === 'peer-paused'
        && !existing.tries && !this.outboxBusy.has(existing.id));
      if (unattempted >= 0) return unattempted;
    }
    return undefined;
  }

  /** Queue places can yield; the two fixed episode records retain all retry metadata. */
  private enqueue(item: OutboxItem): void {
    const index = this.admissionIndex(item);
    if (index === undefined) return;
    if (index >= 0) this.state.outbox.splice(index, 1);
    this.state.outbox.push(item);
  }

  private *outboxCandidates(): Generator<OutboxItem> {
    for (const [key, record] of Object.entries(this.state.threadNotices)) {
      const [peer, threadId] = key.split('/');
      if (record.informPending) yield { id: `inform:${key}`, kind: 'inform', peer, threadId, pauseId: record.ourMarkerId, text: record.informText };
    }
    for (const kind of ['paused', 'peer-paused'] as const) {
      for (const [key, record] of Object.entries(this.state.threadNotices)) {
        const [peer, threadId] = key.split('/');
        for (const [slot, episode] of record.episodes.entries()) {
          if (episode.kind === kind) yield { id: episodeKey(key, slot), kind: 'notify',
            tries: episode.tries, nextAttemptAt: episode.nextAttemptAt, logged: episode.logged, notice: {
              kind, peer, threadId, eventId: episode.eventId, repeats: episode.repeats,
              detail: kind === 'paused' ? 'thread paused on this side' : "the peer's watcher reported the thread paused",
            } };
        }
      }
    }
    for (const [peer, record] of Object.entries(this.state.peerNotices)) {
      for (const kind of ['approval', 'message'] as const) {
        const slot = record[kind];
        if (slot.count !== '000000') yield { id: needsKey(peer, kind), kind: 'notify',
          tries: slot.tries, nextAttemptAt: slot.nextAttemptAt, logged: slot.logged, notice: {
            kind: kind === 'message' ? 'new-message' : 'new-approval', peer, threadId: slot.threadId,
            eventId: slot.eventId, count: slot.count, detail: '',
          } };
      }
    }
  }

  /** Admit local work first, allowing eligible peers to pass deferred entries in a full queue. */
  private fillOutbox(): void {
    for (const item of this.fairOutbox([...this.outboxCandidates()])) this.enqueue(item);
  }

  private fairOutbox(items: OutboxItem[]): OutboxItem[] {
    const ordered: OutboxItem[] = [];
    for (const priority of ['inform', 'paused', 'other']) {
      const peers = new Map<string, OutboxItem[]>();
      for (const item of items) {
        const group = item.kind === 'inform' ? 'inform' : item.notice.kind === 'paused' ? 'paused' : 'other';
        if (group !== priority) continue;
        const peer = item.kind === 'inform' ? item.peer : item.notice.peer;
        if (!peers.has(peer)) peers.set(peer, []);
        peers.get(peer)!.push(item);
      }
      while (peers.size) for (const [peer, queue] of peers) {
        ordered.push(queue.shift()!);
        if (!queue.length) peers.delete(peer);
      }
    }
    return ordered;
  }

  /** Completion matches both the fixed slot and episode ULID; another queued episode is independent. */
  private finishOutbox(item: OutboxItem, delivered = false): void {
    const peer = item.kind === 'inform' ? item.peer : item.notice.peer;
    const threadId = item.kind === 'inform' ? item.threadId : item.notice.threadId;
    const record = this.state.threadNotices[`${peer}/${threadId}`];
    if (item.kind === 'notify' && needsKind(item.notice.kind)) {
      const slot = this.noticeSlot(item) as NeedsSlot | undefined;
      if (slot) {
        const arrivals = slot.dispatchArrivals === '------' ? '000000' : slot.dispatchArrivals;
        if (delivered && arrivals !== '000000') Object.assign(slot, emptyNeedsSlot(), {
          threadId: slot.threadId, eventId: ulid(this.now()), count: arrivals, firstSeenAt: slot.arrivalFirstSeenAt,
        });
        else Object.assign(slot, emptyNeedsSlot());
      }
    } else if (record) {
      if (item.kind === 'inform' && item.pauseId === record.ourMarkerId) record.informPending = false;
      if (item.kind === 'notify') {
        record.lastNoticeSentAt = new Date(this.now()).toISOString();
        const slot = record.episodes.find(episode => episode.kind === item.notice.kind && episode.eventId === item.notice.eventId);
        if (slot) {
          const arrivedDuringDelivery = slot.dispatchArrivals === '------' ? 0 : Number(slot.dispatchArrivals);
          if (delivered && arrivedDuringDelivery > 0) Object.assign(slot, emptyEpisode(), {
            kind: slot.kind, eventId: slot.eventId, repeats: String(arrivedDuringDelivery - 1).padStart(6, '0'),
          });
          else Object.assign(slot, emptyEpisode());
        }
      }
    }
    this.state.outbox = this.state.outbox.filter(o => o.id !== item.id);
  }

  /**
   * This agent's pause markers are the truth. A marker that disappeared means the human resumed: the budget starts
   * over and what arrived meanwhile wakes the agent once. Serialised, so overlapping calls never apply a stale listing.
   */
  syncPaused(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const keys = await listAll(this.deps.selfKv, this.keys.pausedPrefix);
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
              if (this.state.threadNotices[key]) this.state.threadNotices[key].ourPaused = false;
              delete this.state.wakes[key];
              delete this.state.wakeRetries[key];
              const held = this.state.held[key];
              if (held?.messages.length) {
                backlog[key] = held.messages.length;
                const entry = this.state.pending[key] ??= { peer: held.peer, threadId: held.threadId, subject: held.subject, messages: [], firstSeenAt: at, lastSeenAt: at };
                for (const message of held.messages) if (!entry.messages.some((m) => m.messageId === message.messageId)) entry.messages.push(message);
                entry.lastSeenAt = at;
              }
              delete this.state.held[key];
            }
            for (const key of added) {
              const record = this.state.threadNotices[key] ??= threadNoticeState();
              record.ourPaused = true;
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
    const stale = Object.keys(this.state.wakes).filter((key) => !this.recentWakes(key).length)
      .concat(Object.keys(this.state.approvalRetries).filter(key => !this.state.pending[key]?.approvals?.length))
      .concat(Object.keys(this.state.wakeRetries).filter(key => !this.state.pending[key]))
      .concat(Object.keys(this.state.noticeLog).filter((peer) => !this.state.noticeLog[peer].some((t) => at - t < 3600_000)));
    if (!stale.length && !this.state.noticeGlobalLog.some(t => at - t >= 3600_000)) return;
    await this.mutate(() => {
      for (const key of Object.keys(this.state.wakeRetries)) if (!this.state.pending[key]) delete this.state.wakeRetries[key];
      for (const key of Object.keys(this.state.wakes)) if (!this.recentWakes(key).length) delete this.state.wakes[key];
      for (const key of Object.keys(this.state.approvalRetries)) if (!this.state.pending[key]?.approvals?.length) delete this.state.approvalRetries[key];
      this.state.noticeGlobalLog = this.state.noticeGlobalLog.filter(t => at - t < 3600_000);
      for (const peer of Object.keys(this.state.noticeLog)) if (!this.state.noticeLog[peer].some((t) => at - t < 3600_000)) delete this.state.noticeLog[peer];
    });
  }

  /** Informs and notifications queued in state; failures back off (1, 2, 4 ... 15 minutes) and give up after 3 notification attempts or 8 inform failures. */
  private async runOutbox(): Promise<void> {
    const at = this.now();
    const refill = [...this.outboxCandidates()].some(item => this.admissionIndex(item) !== undefined);
    if (refill) await this.mutate(() => this.fillOutbox());
    const runs: Promise<void>[] = [];
    const items = this.fairOutbox([...this.state.outbox]);
    for (const item of items) {
      if (this.outboxBusy.has(item.id) || (item.nextAttemptAt ?? 0) > at) continue;
      this.outboxBusy.add(item.id);
      runs.push((async () => {
        try {
          if (item.kind === 'inform') await this.deps.postInform?.(item.peer, item.threadId, item.text, item.pauseId);
          else {
            const { notice } = item;
            let reserved = false;
            await this.mutate(() => {
              const stored = this.state.outbox.find(o => o.id === item.id);
              if (stored?.kind !== 'notify') return;
              const now = this.now();
              const recent = (this.state.noticeLog[notice.peer] ?? []).filter(t => now - t < 3600_000);
              if ((stored.tries ?? 0) >= MAX_NOTICE_ATTEMPTS) {
                this.finishOutbox(item);
                return;
              }
              const deadline = this.noticeRateDeadline(notice.peer, now);
              if (deadline) {
                stored.nextAttemptAt = deadline;
                this.rememberNotice(stored);
                this.deps.log('notice-rate-cap', { peer: notice.peer, id: item.id });
                return;
              }
              const episode = this.noticeSlot(stored);
              if (episode) {
                if ('repeats' in episode) item.notice.repeats = stored.notice.repeats = episode.repeats;
                else {
                  item.notice.threadId = stored.notice.threadId = episode.threadId;
                  item.notice.count = stored.notice.count = episode.count;
                  episode.arrivalFirstSeenAt = EPOCH;
                }
                episode.dispatchArrivals = '000000';
              }
              this.state.noticeGlobalLog = [...this.state.noticeGlobalLog.filter(t => now - t < 3600_000), now];
              item.tries = stored.tries = (stored.tries ?? 0) + 1;
              this.rememberNotice(stored);
              this.state.noticeLog[notice.peer] = [...recent, now];
              reserved = true; // persisted BEFORE any channel operation, even one that delivers then fails
            });
            if (!reserved) return;
            this.deps.log('notify', { kind: notice.kind, peer: notice.peer, threadId: notice.threadId, detail: notice.detail });
            if (!item.logged && this.deps.notificationHome) {
              appendNotice(this.deps.notificationHome, notice);
              await this.mutate(() => {
                const stored = this.state.outbox.find(o => o.id === item.id);
                if (stored?.kind === 'notify') { stored.logged = true; this.rememberNotice(stored); }
              });
            }
            await this.deps.notify?.(notice);
          }
          await this.mutate(() => this.finishOutbox(item, true));
        } catch (error) {
          const tries = item.kind === 'notify' ? (item.tries ?? 1) : (item.tries ?? 0) + 1;
          this.deps.log(item.kind === 'inform' ? 'inform-error' : 'notify-error', { id: item.id, tries, ...errInfo(error) });
          if (tries >= (item.kind === 'notify' ? MAX_NOTICE_ATTEMPTS : MAX_OUTBOX_TRIES)) {
            this.deps.log('outbox-dropped', { id: item.id, reason: 'too-many-failures' });
            await this.mutate(() => this.finishOutbox(item));
          } else {
            await this.mutate(() => {
              const stored = this.state.outbox.find(o => o.id === item.id);
              if (!stored) return;
              stored.tries = tries;
              stored.nextAttemptAt = this.now() + Math.min(15 * 60_000, WAKE_RETRY_MS * 2 ** (tries - 1));
              if (stored.kind === 'notify') {
                this.rememberNotice(stored);
                const episode = this.noticeSlot(stored);
                if (episode) episode.dispatchArrivals = '------';
              }
            });
          }
        } finally {
          this.outboxBusy.delete(item.id);
        }
      })());
    }
    await Promise.all(runs);
  }

  // ---------- run loop ----------

  /** One full catch-up: every peer and approvals, under one pause-marker listing. */
  async pollOnce(via: Via, preflight = true): Promise<void> {
    if (preflight) {
      await this.deps.beforePoll?.();
      await this.checkAuthority();
    }
    if (this.deps.notifyOnly) {
      const paired = this.deps.loadPeers().filter(peer => peer.status === 'paired' && HANDLE.test(peer.handle)).map(peer => peer.handle);
      if (paired.some(peer => !Object.hasOwn(this.state.peerNotices, peer))
        || Object.keys(this.state.peerNotices).some(peer => !paired.includes(peer))) {
        await this.mutate(() => {
          this.syncNoticePeers();
          this.state.outbox = this.state.outbox.filter(item => item.kind !== 'notify' || !needsKind(item.notice.kind) || paired.includes(item.notice.peer));
        });
      }
    }
    await this.syncPaused();
    await this.pruneState();
    await Promise.all(this.deps.loadPeers().map((peer) => this.sync(peer, via, true)));
    await this.syncApprovals(via);
  }

  /** Between full catch-ups, a cycle lists again only what is dirty: a peer or approvals whose last sync did not finish. */
  private async syncDirty(): Promise<void> {
    const peers = this.deps.loadPeers().filter(peer => this.dirtyPeers.has(peer.handle));
    for (const handle of this.dirtyPeers) if (!peers.some(peer => peer.handle === handle)) this.dirtyPeers.delete(handle);
    if (peers.length) {
      await this.syncPaused();
      await Promise.all(peers.map(peer => this.sync(peer, 'poll', true)));
    }
    if (this.approvalsDirty) await this.syncApprovals('poll');
  }

  /** Healthy: every subscription has an open stream that delivered an event or has lasted one ticket without failing. */
  private hooksHealthy(ids: Iterable<string>): boolean {
    const at = this.now();
    for (const id of ids) {
      const stream = this.hookStreams.get(id);
      if (!stream || !(stream.proven || at - stream.openedAt >= this.opts.ticketSeconds * 1000)) return false;
    }
    return true;
  }

  /**
   * Runs until `signal` aborts. With `once`, does one catch-up and wakes everything immediately, and throws
   * `state-conflict` (after stopping everything) if another watcher is writing this agent's state.
   *
   * Without `once` (a service, which systemd restarts whatever it exits with), a conflict never ends the process: the
   * watcher stops subscribing, waking and writing, and stands by. It reads watch.json once per window (5 minutes,
   * doubling to 30) and takes over, with one catch-up, only after a whole window in which the other writer wrote nothing.
   * The other watcher is the same agent's, so its messages stay watched meanwhile.
   */
  async run(external: AbortSignal, options: { once?: boolean } = {}): Promise<void> {
    if (options.once) return this.session(external, options);
    const { log, selfKv } = this.deps;
    let windowMs = CONFLICT_STANDBY_MS;
    for (;;) {
      const started = this.now();
      try {
        return await this.session(external, options);
      } catch (error) {
        if (!(error instanceof CourierError && error.code === 'state-conflict') || external.aborted) throw error;
      }
      if (this.now() - started >= CONFLICT_STANDBY_MAX_MS) windowMs = CONFLICT_STANDBY_MS;
      log('standby', {
        reason: 'state-conflict', retryInMs: windowMs,
        message: `Another \`watch\` is writing this Courier agent's watch.json. This watcher has stopped waking and checks again in ${Math.round(windowMs / 60_000)} min; stop one of the two.`,
      });
      let seen = (await getJson(selfKv, this.keys.watch).catch(() => undefined))?.etag;
      for (;;) {
        await sleep(windowMs, external);
        if (external.aborted) return;
        windowMs = Math.min(windowMs * 2, CONFLICT_STANDBY_MAX_MS);
        const etag = (await getJson(selfKv, this.keys.watch).catch(() => undefined))?.etag;
        if (etag === seen) break;
        seen = etag;
      }
      log('standby-over', { reason: 'other-writer-quiet' });
    }
  }

  private async session(external: AbortSignal, options: { once?: boolean }): Promise<void> {
    const { log } = this.deps;
    const stop = new AbortController();
    const signal = stop.signal;
    const onExternalAbort = () => stop.abort();
    this.fatalError = undefined;
    this.stopping = false;
    signal.addEventListener('abort', () => { this.stopping = true; }, { once: true });
    external.addEventListener('abort', onExternalAbort, { once: true });
    if (external.aborted) stop.abort();
    this.onFatal = () => stop.abort();
    const supervisors = new Map<string, AbortController>();
    let ticker: NodeJS.Timeout | undefined;
    try {
      await this.deps.beforePoll?.();
      await this.checkAuthority();
      let authorityAt = this.now();
      await this.migrateLegacyState();
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
            sub: { space: peer.spaceId, service: 'kv', pathPrefix: peer.sessionId ? k.threadRoot(peer.theirHandleForMe, peer.sessionId) : `${PREFIX}/to/${peer.theirHandleForMe}` },
            hooks: () => this.deps.peerHooks(peer),
            onEvent: (event) => {
              // A peer renewing or replacing its delegation to us writes this marker (a path-less event may be it):
              // read the marker and check the peer's authority now, not at the next scheduled check.
              if (event && (event.path === undefined || event.path.endsWith('/pairing/delegation.json'))) {
                this.renewalDue.add(peer.handle);
                this.authorityDue.add(peer.handle);
              }
              void this.sync(peer, 'hook');
            },
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
            this.hookStreams.delete(id);
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
        await this.pollOnce('startup', false);
        await this.tick(true);
      } else {
        // Open the subscriptions first, then catch up: a write between the two is seen by one or the other.
        reconcile();
        await sleep(RECONNECT_CATCH_UP_MS, signal);
        let fullAt = this.now();
        if (!signal.aborted) await this.pollOnce('startup', false);
        ticker = setInterval(() => void this.tick().catch((e) => log('wake-error', errInfo(e))), 1000);
        while (!signal.aborted) {
          await sleep(this.opts.pollMs, signal);
          if (signal.aborted) break;
          await this.deps.beforePoll?.();
          if (this.now() - authorityAt >= AUTHORITY_CHECK_MS) {
            authorityAt = this.now();
            await this.checkAuthority();
          }
          reconcile();
          // Healthy hooks deliver at once, so the full listing is only the fallback for an event they missed.
          if (!this.hooksHealthy(supervisors.keys()) || this.now() - fullAt >= HEALTHY_RECONCILE_MS) {
            fullAt = this.now();
            await this.pollOnce('poll', false);
          } else {
            await this.syncDirty();
          }
          if (this.now() - this.lastClaimPrune > 3600_000) {
            this.lastClaimPrune = this.now();
            await this.pruneClaims();
          }
        }
      }
    } catch (error) {
      if (isAuthorizationRefusal(error)) await this.deps.onAuthorityRefusal?.('self');
      throw error;
    } finally {
      clearInterval(ticker);
      for (const controller of supervisors.values()) controller.abort();
      external.removeEventListener('abort', onExternalAbort);
      this.onFatal = undefined;
      log('stop');
    }
    if (this.fatalError) throw this.fatalError;
  }

  /**
   * One hook subscription. Authorization refusals stop this subscription; transient failures back off. A failed or
   * ended stream catches up at once, and the watcher lists everything every `pollMs` until a new stream is healthy.
   */
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
        const stream = { openedAt: this.now(), proven: false };
        this.hookStreams.set(id, stream);
        for await (const event of service.subscribe([sub], { ttlSeconds: this.opts.ticketSeconds, signal })) {
          failures = 0;
          stream.proven = true;
          this.deps.log('hook-event', { source: id.split(':').slice(0, 2).join(':'), path: event.path ?? null });
          onEvent(event);
        }
        this.hookStreams.delete(id);
        if (!signal.aborted) {
          onEvent();
          await sleep(5_000, signal);
        }
      } catch (error) {
        this.hookStreams.delete(id);
        if (isAuthorizationRefusal(error)) { await this.deps.onAuthorityRefusal?.(id); return; }
        failures++;
        this.deps.log('hook-error', { source: id.split(':').slice(0, 2).join(':'), ...errInfo(error) });
        if (!signal.aborted) onEvent();
        await sleep(Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
  }
}
