import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { acceptB, fail } from './commands.js';
import { CourierError } from './errors.js';
import { deleteSealed as deleteSealedReal, inviteOrigin } from './invite-link.js';
import { publicHeldReason, readPublicStatus, updatePublicInvite, type HeldReason } from './invite-public.js';
import { inviteFolder, ownerMatches, parseHello, type Hello, type Tier, type Welcome } from './invite-schema.js';
import type { Notice, Notifier } from './notify.js';
import type { WatchLog } from './wake.js';
import { saveProfile, secureSubdir, writeSecure, type Profile } from './profile.js';
import { courierPhrase } from './did-key.js';
import { peersEntryProblem, peersFilesFor, peersMessage, type PeersFile } from './peers-guard.js';
import { GRANT_LIFETIME_MS, newestGrant, possibleGrants, removeExpiredGrants, updateGrantLate, writeGrant, type PossibleGrant } from './grant-record.js';

export { peersEntryProblem, peersFilesFor, peersMessage, PEERS_ENTRY_MESSAGE, PEERS_UNREADABLE_MESSAGE, type PeersFile } from './peers-guard.js';
import { delIfPresent, getJson, listAll, putCreate } from './store.js';
import { verifyEmailProof as verifyReal, type VerifyEmailProofInput, type VerifyEmailProofResult } from './verify-email-proof.js';

export type AcceptedTier = Exclude<Tier, 'rejected'>;
/** Maps the owner's `--tier` flag to the tier the peer requested. `trusted` is recorded as a request; nothing here grants it, and the peer starts strict until the owner confirms trusted status. */
export function requestedTier(flag: string): AcceptedTier {
  if (flag === 'strict') return 'strict';
  if (flag === 'trusted') return 'trusted-requested';
  return fail('usage', '--tier must be strict or trusted.');
}
export type InviteStatus = 'open' | 'consumed' | 'held' | 'completed' | 'failed' | 'denied' | 'revoked' | 'expired';
export type Log = (entry: Record<string, unknown>) => void;
/** Adapts the wake log's `(event, fields)` form to the record-style log the watcher calls. */
export const eventLog = (log: WatchLog): Log => ({ event, ...fields }) => log(String(event), fields);

/** Owner-side invite record. Written 0600 under COURIER_HOME; never holds the one-time private key. */
export interface InviteRecord {
  v: 1;
  inviteId: string;
  handle: string;
  callMe: string;
  email: string;
  tier: AcceptedTier;
  alsoAsk: boolean;
  expiresAt: string;
  store: { id: string; cid: string; deleteToken: string };
  /** SHA-256 of the one-time public key, fixed at create. Verification binds the credential to it. */
  oneTimeKeyHash: string;
  /** Owner DID the peer must match when set. Unset means no owner check. */
  expectOwner?: string;
  status: InviteStatus;
  /** Public record directory, resolved from --invites-public-dir or the env at create. Unset means no public copy. */
  publicDir?: string;
  held?: { reason: string; at: string; owner?: string; courierDid?: string };
  /**
   * Private. Latest end of a read grant that may exist but could not be written down (no courier is known for it). A record-level field, so a fresh `held`
   * cannot erase it: it only ever moves later (max with the previous still-future date), and only the sweep removes it, once the date has passed.
   * Never part of the public copy.
   */
  unrecordedGrantUntil?: string;
  /** Artifact C, persisted before the Welcome write so a retried approve reuses it instead of pairing again. */
  artifactC?: Welcome['artifactC'];
  completedPeer?: { handle: string; courierDid: string; ownerDid: string };
  cleanedAt?: string;
  /** Set when the record moves to consumed. Recovery waits RECOVER_AFTER_MS past it. */
  consumedAt?: string;
  /** Random marker written with every move to consumed. A holder compares it before each state-changing write, so two consumes can be told apart. */
  consumedBy?: string;
}

const RECORD_FILE = /^[a-z2-7]{26}\.json$/;
const RECOVER_AFTER_MS = 10 * 60 * 1000;
/** What every `invite-busy` message ends with: a lock whose holder died blocks for LOCK_STALE_MS, so "a minute" would promise too much. */
export const INVITE_BUSY_WAIT = 'Try again in a few minutes.';

/** A lock whose mtime has not been refreshed for this long belongs to a holder that died; it is taken over. A live holder refreshes it every LOCK_HEARTBEAT_MS. */
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
/** Every node call made while an invite is being decided is abandoned after this long (shorter than LOCK_STALE_MS). */
export const NODE_CALL_TIMEOUT_MS = 60 * 1000;
const lockPath = (id: string) => path.join(secureSubdir('invites'), `${id}.lock`);

/** Test seam: shorter windows than the production constants. */
export interface LockTiming {
  staleMs?: number;
  /** 0 turns the heartbeat off (a holder that cannot beat). */
  heartbeatMs?: number;
  nodeTimeoutMs?: number;
}

/** What a lock holder checks before it writes. */
export interface LockGuard {
  /** Throws `invite-lock-lost` unless the lock file still holds this holder's token. */
  assertHeld(): void;
}

/**
 * Runs `fn` while holding the invite's exclusive lock (`<id>.lock`, created `wx`, 0600, in the 0700 invites dir; it holds a random token of this holder).
 * Approve, deny, recovery, `revoke` and the sweep's expiry close take it so two of them cannot both read `held` and both pair (or one delete what the other writes). A lock that is already held makes the caller fail with
 * `invite-busy` at once (it never waits). While `fn` runs the lock's mtime is refreshed every LOCK_HEARTBEAT_MS, so a live holder is never stale; a lock with
 * no heartbeat for LOCK_STALE_MS is taken over. The lock is removed at the end only if it still holds this holder's token.
 * `fn` gets a guard and must call `assertHeld()` before it writes (a holder whose lock was taken over must stop writing).
 */
async function withInviteLock<T>(id: string, timing: LockTiming | undefined, fn: (guard: LockGuard) => Promise<T>, busyMessage?: string): Promise<T> {
  const file = lockPath(id);
  const staleMs = timing?.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = timing?.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const token = randomBytes(16).toString('hex');
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let seen: fs.Stats;
      try {
        seen = fs.statSync(file);
      } catch {
        continue;
      }
      if (Date.now() - seen.mtimeMs < staleMs) break;
      // Only the lock that was judged stale is removed: if it was replaced in between, leave the new one.
      try {
        const again = fs.statSync(file);
        if (again.ino !== seen.ino || again.mtimeMs !== seen.mtimeMs) continue;
      } catch {
        continue;
      }
      fs.rmSync(file, { force: true });
    }
  }
  if (fd === undefined) fail('invite-busy', busyMessage ?? `Another approve, deny or recovery is working on this invite. ${INVITE_BUSY_WAIT}`);
  fs.writeSync(fd, token);
  fs.closeSync(fd);
  const readToken = (): string | undefined => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  const guard: LockGuard = {
    assertHeld() {
      if (readToken() !== token) throw new CourierError('invite-lock-lost', 'The lock on this invite was taken over while it was being worked on; nothing more was written.');
    },
  };
  let beat: ReturnType<typeof setInterval> | undefined;
  if (heartbeatMs > 0) {
    beat = setInterval(() => {
      try {
        if (readToken() === token) {
          const now = new Date();
          fs.utimesSync(file, now, now);
        }
      } catch {
        // A failed beat is caught by the next assertHeld.
      }
    }, heartbeatMs);
    beat.unref?.();
  }
  try {
    return await fn(guard);
  } finally {
    if (beat !== undefined) clearInterval(beat);
    if (readToken() === token) fs.rmSync(file, { force: true });
  }
}

/** What a holder expects the record on disk to still be, right before it writes. */
interface Claim {
  status: InviteStatus;
  consumedBy: string | undefined;
}
const claimOf = (r: InviteRecord): Claim => ({ status: r.status, consumedBy: r.consumedBy });
const consumedClaim = (r: InviteRecord): Claim => ({ status: 'consumed', consumedBy: r.consumedBy });
const newMarker = () => randomBytes(16).toString('hex');
const peerKey = (p: { handle: string; courierDid: string; ownerDid: string } | null | undefined): string => (p ? `${p.handle}|${p.courierDid}|${p.ownerDid}` : '');
const invitesDir = () => secureSubdir('invites');
export const recordPath = (id: string) => path.join(invitesDir(), `${id}.json`);
const heldPath = (id: string) => path.join(invitesDir(), `${id}.held.json`);
const seenPath = () => path.join(invitesDir(), 'seen-credentials.json');

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** A record written while this date lived inside `held` (an earlier build of this branch): lifted to the record-level field, in memory; the next write keeps it. */
function liftUnrecorded(record: InviteRecord): InviteRecord {
  const legacy = (record.held as { unrecordedGrantUntil?: string } | undefined)?.unrecordedGrantUntil;
  if (legacy === undefined) return record;
  delete (record.held as { unrecordedGrantUntil?: string }).unrecordedGrantUntil;
  record.unrecordedGrantUntil = laterDate(record.unrecordedGrantUntil, legacy);
  return record;
}
const laterDate = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : Date.parse(a) >= Date.parse(b) ? a : b);

export const readRecord = (id: string): InviteRecord | undefined => {
  const record = readJson<InviteRecord>(recordPath(id));
  return record ? liftUnrecorded(record) : undefined;
};
export const writeRecord = (record: InviteRecord) => writeSecure(recordPath(record.inviteId), record);

/** Only `<id>.json` records; held hellos and the seen-credential file are excluded by name. */
export function listRecords(): InviteRecord[] {
  const dir = invitesDir();
  return fs.readdirSync(dir).filter((n) => RECORD_FILE.test(n)).flatMap((n) => {
    const record = readJson<InviteRecord>(path.join(dir, n));
    return record ? [liftUnrecorded(record)] : [];
  });
}

export const readHeld = (id: string) => readJson<Hello>(heldPath(id));
const removeHeld = (id: string) => fs.rmSync(heldPath(id), { force: true });

/** Credential ids already used for a completed pairing. A corrupt file throws, so callers hold. */
export function loadSeenCredentials(): Set<string> {
  const value = readJson<{ ids?: unknown }>(seenPath());
  if (value === undefined) return new Set();
  if (!Array.isArray(value.ids) || !value.ids.every((id) => typeof id === 'string')) {
    throw new CourierError('seen-credentials-corrupt', 'seen-credentials.json is not a list of ids.');
  }
  return new Set(value.ids as string[]);
}

/** Replay key of a credential consumed for an invite: `${credentialId}:${inviteId}`, matching the verifier's check. */
function addSeenReplayKey(replayKey: string): void {
  const seen = loadSeenCredentials();
  seen.add(replayKey);
  writeSecure(seenPath(), { ids: [...seen] });
}

/** Stable failure code for logs and notices. Never carries message text, which may echo input. */
export function reasonOf(e: unknown): string {
  if (e instanceof CourierError) return e.code;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'handler-error';
}

/** The held facts the public copy shows: why the invite is held and the owner DID of the hello that actually arrived. Only while held. */
function heldFacts(record: InviteRecord): { heldReason: HeldReason; helloOwner: string } | undefined {
  if (record.status !== 'held') return undefined;
  const owner = record.held?.owner ?? readHeld(record.inviteId)?.artifactB.from.owner;
  if (owner === undefined) return undefined;
  return { heldReason: publicHeldReason(record.held?.reason ?? 'internal-error'), helloOwner: owner };
}

/** Public copy update that throws on failure. Only status, completedPeer and the held facts are patched; create-time fields stay as written at create. */
export function writePublicStatus(record: InviteRecord): void {
  if (record.publicDir === undefined) return;
  const facts = heldFacts(record);
  const patch: Parameters<typeof updatePublicInvite>[2] = { status: record.status, heldReason: facts?.heldReason, helloOwner: facts?.helloOwner };
  if (record.completedPeer !== undefined) patch.completedPeer = record.completedPeer;
  updatePublicInvite(record.publicDir, record.inviteId, patch);
}

/** Best-effort public copy update for transitions that do not decide the outcome. Failure is logged by reason code only. */
export function publishStatus(record: InviteRecord, log: Log): void {
  try {
    writePublicStatus(record);
  } catch (e) {
    log({ event: 'public-write-failed', inviteId: record.inviteId, reason: reasonOf(e) });
  }
}

export interface InviteEnv {
  node: TinyCloudNode;
  profile: () => Profile;
  log: Log;
  notify?: Notifier;
  now?: () => Date;
  verify?: (input: VerifyEmailProofInput) => Promise<VerifyEmailProofResult>;
  accept?: typeof acceptB;
  deleteSealed?: typeof deleteSealedReal;
  /** Test seam: runs after acceptB's artifact is persisted and before the Welcome write. */
  fault?: (step: 'before-welcome') => void;
  /** peers.json locations checked before pairing. Defaults to `peersFilesFor()`. */
  peersFiles?: readonly (string | PeersFile)[];
  /** Test seam: shorter lock and node-call windows. */
  timing?: LockTiming;
}

type Check = { ok: true; replayKey: string } | { ok: false; reason: string };

/**
 * Inviter-side state machine. A hello is consumed on disk before any other action. Only a verified,
 * matching, unrestricted hello pairs without a human; everything else is held for a decision.
 */
export class InviteWatcher {
  private readonly now: () => Date;
  private readonly verify: (input: VerifyEmailProofInput) => Promise<VerifyEmailProofResult>;
  private readonly realAccept: typeof acceptB;
  private readonly deleteSealed: typeof deleteSealedReal;
  /** The node's KV with every call bounded by NODE_CALL_TIMEOUT_MS. */
  private readonly kv: TinyCloudNode['kv'];

  constructor(private readonly env: InviteEnv) {
    this.now = env.now ?? (() => new Date());
    this.verify = env.verify ?? verifyReal;
    this.realAccept = env.accept ?? acceptB;
    const realDelete = env.deleteSealed ?? deleteSealedReal;
    this.deleteSealed = (...args: Parameters<typeof deleteSealedReal>) => this.bounded('deleteSealed', async () => realDelete(...args));
    this.kv = new Proxy(env.node.kv, {
      get: (target, prop) => {
        const member = Reflect.get(target, prop, target) as unknown;
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => this.bounded(`kv.${String(prop)}`, async (_signal) => (member as (...a: unknown[]) => unknown).apply(target, args));
      },
    });
  }

  /**
   * Runs one node call with a deadline. At the deadline the caller gets `node-timeout` and moves on (the invite stays recoverable), and the signal given to
   * `run` is aborted: a call that honours it (acceptB does) writes nothing more. The call itself cannot be cancelled, so whatever it returns later is
   * dropped and only logged; `onLate` (when given) hears how it ended.
   */
  private bounded<T>(label: string, run: (signal: AbortSignal) => Promise<T>, onLate?: (outcome: 'ok' | 'failed') => void): Promise<T> {
    const ms = this.env.timing?.nodeTimeoutMs ?? NODE_CALL_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new CourierError('node-timeout', `${label} did not answer within ${Math.round(ms / 1000)} s`));
      }, ms);
      run(controller.signal).then(
        (value) => {
          clearTimeout(timer);
          if (timedOut) {
            this.env.log({ event: 'node-call-late', step: label, outcome: 'ok' });
            onLate?.('ok');
          } else resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (timedOut) {
            this.env.log({ event: 'node-call-late', step: label, outcome: 'failed', reason: reasonOf(error) });
            onLate?.('failed');
          } else reject(error);
        },
      );
    });
  }

  /**
   * Compare-and-set: right before a state-changing write, the record on disk must still be what this holder took (status and consume marker) and the
   * lock must still be this holder's. Otherwise nothing is written and the holder stops with `invite-lock-lost`.
   */
  private cas(id: string, claim: Claim, guard: LockGuard | undefined): void {
    guard?.assertHeld();
    const disk = readRecord(id);
    if (!disk || disk.status !== claim.status || disk.consumedBy !== claim.consumedBy) {
      throw new CourierError('invite-lock-lost', 'This invite was changed by someone else while it was being worked on; nothing more was written.');
    }
  }

  openIds(): string[] {
    return listRecords().filter((r) => r.status === 'open').map((r) => r.inviteId);
  }

  /** Expires open and held invites; removes welcomes of completed or denied invites at expiry. Never throws. */
  async sweep(): Promise<void> {
    try {
      for (const record of listRecords()) {
        try {
          await this.sweepOne(record);
        } catch (e) {
          this.env.log({ event: 'invite-sweep-error', inviteId: record.inviteId, reason: reasonOf(e) });
        }
      }
      // A possible-grant record is kept until the grant can no longer be valid, and only then deleted here.
      removeExpiredGrants(this.now().getTime());
    } catch (e) {
      this.env.log({ event: 'invite-sweep-error', reason: reasonOf(e) });
    }
  }

  private async sweepOne(listed: InviteRecord): Promise<void> {
    await this.recoverConsumed(listed);
    // The listing can be old (the sweep awaits the node for every record): carry on from what is on disk now, and not at all if it is gone.
    let record = readRecord(listed.inviteId);
    if (!record) return;
    if (record.unrecordedGrantUntil !== undefined && Date.parse(record.unrecordedGrantUntil) <= this.now().getTime()) {
      await this.dropUnrecorded(record.inviteId);
      record = readRecord(listed.inviteId);
      if (!record) return;
    }
    await this.reconcilePublic(record);
    if (Date.parse(record.expiresAt) > this.now().getTime()) {
      // A missed hook must not strand a hello: the poll runs the same handler. It consumes the hello first, so a hello seen twice pairs once.
      if (record.status === 'open') await this.onHello(record.inviteId);
      return;
    }
    if (record.status === 'open' || record.status === 'held' || record.status === 'failed') {
      try {
        await withInviteLock(record.inviteId, this.env.timing, (guard) => this.close(record, 'expired', guard));
      } catch (e) {
        // Someone is deciding this invite right now: the next sweep looks again.
        if (!(e instanceof CourierError && e.code === 'invite-busy')) throw e;
      }
      return;
    }
    if ((record.status === 'completed' || record.status === 'denied') && record.cleanedAt === undefined) {
      await delIfPresent(this.kv, `${inviteFolder(record.inviteId)}out/welcome.json`);
      record.cleanedAt = this.now().toISOString();
      writeRecord(record);
    }
  }

  /** The sweep's only removal of `unrecordedGrantUntil`, once the date has passed (checked again under the lock). A busy invite is left for the next sweep. */
  private async dropUnrecorded(id: string): Promise<void> {
    try {
      await withInviteLock(id, this.env.timing, async (guard) => {
        const record = readRecord(id);
        if (!record?.unrecordedGrantUntil || Date.parse(record.unrecordedGrantUntil) > this.now().getTime()) return;
        this.cas(id, claimOf(record), guard);
        delete record.unrecordedGrantUntil;
        writeRecord(record);
      });
    } catch (e) {
      if (!(e instanceof CourierError && (e.code === 'invite-busy' || e.code === 'invite-lock-lost'))) throw e;
    }
  }

  /**
   * Recovers an invite left in consumed by a crash or a failed hold. Waits RECOVER_AFTER_MS past consumedAt so a live handleHello or approve is not disturbed.
   * An expired invite closes. The held copy, else a valid remote hello, is held with internal-error. With neither, the invite fails with hello-lost.
   */
  private async recoverConsumed(snapshot: InviteRecord): Promise<void> {
    if (snapshot.status !== 'consumed') return;
    try {
      await withInviteLock(snapshot.inviteId, this.env.timing, async (guard) => {
        // Re-read under the lock: an approve or deny that held it may have moved the invite on.
        const record = readRecord(snapshot.inviteId);
        if (record) await this.recoverLocked(record, guard);
      });
    } catch (e) {
      if (e instanceof CourierError && e.code === 'invite-busy') return;
      throw e;
    }
  }

  private async recoverLocked(record: InviteRecord, guard: LockGuard): Promise<void> {
    if (record.status !== 'consumed') return;
    if (record.consumedAt !== undefined && this.now().getTime() - Date.parse(record.consumedAt) < RECOVER_AFTER_MS) return;
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.close(record, 'expired', guard);
      return;
    }
    // The held copy wins: a recovery must never let a later writer replace the identity the owner already saw. The remote hello is used only when
    // there is no held copy (a crash between the hello arriving and the hold).
    const hello = readHeld(record.inviteId) ?? (await this.remoteHello(record.inviteId));
    if (hello) {
      await this.hold(record, hello, 'internal-error', guard);
      return;
    }
    this.cas(record.inviteId, consumedClaim(record), guard);
    record.status = 'failed';
    writeRecord(record);
    publishStatus(record, this.env.log);
    await this.finish(record);
    this.env.log({ event: 'invite-failed', inviteId: record.inviteId, reason: 'hello-lost' });
    await this.emit({ kind: 'invite-failed', peer: record.handle, threadId: record.inviteId, detail: 'hello-lost' });
  }

  /** The hello still under in/, or undefined when it is gone or invalid. An invalid hello is logged by reason; finish clears it. */
  private async remoteHello(id: string): Promise<Hello | undefined> {
    const got = await getJson<unknown>(this.kv, `${inviteFolder(id)}in/hello.json`);
    if (!got) return undefined;
    try {
      const text = typeof got.value === 'string' ? got.value : JSON.stringify(got.value);
      const hello = parseHello(text);
      if (hello.inviteId !== id) throw new CourierError('bad-hello', 'hello is for another invite');
      return hello;
    } catch (e) {
      this.env.log({ event: 'invite-bad-hello', inviteId: id, reason: reasonOf(e) });
      return undefined;
    }
  }

  /** Rewrites the public copy's status and completedPeer when they differ from the private record. A failure is logged by reason and retried next sweep. */
  private reconcilePublic(record: InviteRecord): void {
    if (record.publicDir === undefined) return;
    try {
      const pub = readPublicStatus(record.publicDir, record.inviteId);
      if (pub === undefined) {
        this.env.log({ event: 'public-reconcile-failed', inviteId: record.inviteId, reason: 'public-record-missing' });
        return;
      }
      if (pub.status === record.status && peerKey(pub.completedPeer) === peerKey(record.completedPeer) && pub.heldReason === heldFacts(record)?.heldReason && pub.helloOwner === heldFacts(record)?.helloOwner) return;
      writePublicStatus(record);
      this.env.log({ event: 'public-reconciled', inviteId: record.inviteId });
    } catch (e) {
      this.env.log({ event: 'public-reconcile-failed', inviteId: record.inviteId, reason: reasonOf(e) });
    }
  }

  /** Runs on every event under `in/`. An exception before consumption leaves the invite open for the next event or poll. */
  async onHello(id: string): Promise<void> {
    try {
      await this.handleHello(id);
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: id, reason: reasonOf(e) });
    }
  }

  private async handleHello(id: string): Promise<void> {
    const kv = this.kv;
    const folder = inviteFolder(id);
    const helloKey = `${folder}in/hello.json`;
    const record = readRecord(id);
    if (!record || record.status !== 'open') {
      if (record?.status !== 'consumed') await this.clearInbound(folder);
      return;
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.close(record, 'expired');
      return;
    }
    for (const key of await listAll(kv, `${folder}in/`)) {
      if (key !== helloKey) await delIfPresent(kv, key);
    }
    const got = await getJson<unknown>(kv, helloKey);
    if (!got) return;
    let hello: Hello;
    try {
      const text = typeof got.value === 'string' ? got.value : JSON.stringify(got.value);
      hello = parseHello(text);
      if (hello.inviteId !== id) throw new CourierError('bad-hello', 'hello is for another invite');
    } catch (e) {
      await delIfPresent(kv, helloKey);
      this.env.log({ event: 'invite-bad-hello', inviteId: id, reason: reasonOf(e) });
      return;
    }
    // Consume before any other action. No await between this re-check and the write.
    const latest = readRecord(id);
    if (!latest || latest.status !== 'open') {
      // A consumed record means another handler is deciding on this very hello and removes it itself (after the held copy is written).
      if (latest?.status !== 'consumed') await delIfPresent(kv, helloKey);
      return;
    }
    latest.status = 'consumed';
    latest.consumedAt = this.now().toISOString();
    latest.consumedBy = newMarker();
    writeRecord(latest);
    publishStatus(latest, this.env.log);
    await this.decide(latest, hello);
  }

  /**
   * Runs after `consumed` is persisted. Any exception ends HELD with reason internal-error; the specific code is logged as invite-error.
   * A verified credential's replay key is recorded before pairing, so a held invite cannot be re-verified with the same credential.
   */
  private async decide(record: InviteRecord, hello: Hello): Promise<void> {
    let decision: Check;
    try {
      decision = await this.check(record, hello);
      if (decision.ok) addSeenReplayKey(decision.replayKey);
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
      await this.hold(record, hello, 'internal-error');
      return;
    }
    if (!decision.ok) {
      await this.hold(record, hello, decision.reason);
      return;
    }
    await this.complete(record, hello);
  }

  private async check(record: InviteRecord, hello: Hello): Promise<Check> {
    if (hello.credential === undefined) return { ok: false, reason: 'no-credential' };
    if (hello.possession === undefined) return { ok: false, reason: 'no-possession' };
    const verified = await this.verify({
      credential: hello.credential,
      possession: hello.possession,
      expectEmail: record.email,
      holderDid: hello.artifactB.from.courier,
      inviteId: record.inviteId,
      oneTimeKeyHash: record.oneTimeKeyHash,
      now: this.now().getTime(),
      seenCredentials: loadSeenCredentials(),
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };
    if (verified.address !== record.email) return { ok: false, reason: 'address-mismatch' };
    if (record.expectOwner !== undefined && !ownerMatches(record.expectOwner, hello.artifactB.from.owner)) {
      return { ok: false, reason: 'owner-mismatch' };
    }
    const peersProblem = peersEntryProblem(record.handle, this.env.peersFiles ?? peersFilesFor());
    if (peersProblem !== undefined) return { ok: false, reason: peersProblem };
    if (record.alsoAsk) return { ok: false, reason: 'also-ask' };
    return { ok: true, replayKey: `${verified.credentialId}:${record.inviteId}` };
  }

  /** Writes the Welcome once. An identical existing Welcome (a retried approve) is accepted; any other existing Welcome is a conflict. */
  private async writeWelcome(welcome: Welcome): Promise<void> {
    const kv = this.kv;
    const key = `${inviteFolder(welcome.inviteId)}out/welcome.json`;
    try {
      await putCreate(kv, key, welcome);
      return;
    } catch (e) {
      // Production create-only put throws 'conflict' on 412; the record exists, so compare it below.
      if (!(e instanceof CourierError && e.code === 'conflict')) throw e;
    }
    const prior = (await getJson<Welcome>(kv, key))?.value;
    if (!prior || prior.inviteId !== welcome.inviteId || prior.tier !== welcome.tier || JSON.stringify(prior.artifactC) !== JSON.stringify(welcome.artifactC)) {
      throw new CourierError('welcome-exists', 'welcome already written for this invite');
    }
  }

  /**
   * Pairs the peer (acceptB, skipped when artifactC is already persisted), writes the Welcome, then commits the record as completed.
   * Any failure ends HELD with reason internal-error. A retried approve resumes from the persisted artifactC and an identical Welcome.
   * Returns the reason code on failure, undefined on success.
   */
  private async complete(record: InviteRecord, hello: Hello, guard?: LockGuard): Promise<string | undefined> {
    // Before each step that writes (or mints a delegation) the record on disk must still be the consume this holder made, and the lock still ours.
    const claim = consumedClaim(record);
    // Bookkeeping for an outgoing grant that may exist if this attempt is abandoned (see grant-record.ts).
    const attempt = record.consumedBy ?? newMarker();
    const startedAt = this.now().toISOString();
    let requested = false;
    let outgoing: { cid: string; expiresAt: string } | undefined;
    let persisted = record.artifactC !== undefined;
    let grantRecorded = false;
    let unrecordedNow = false;
    let space = '';
    const recordPossibleGrant = (cause: 'timeout' | 'error'): void => {
      // Writing this down must never get in the way of holding the invite: a failure here is logged and the hold goes on.
      try {
        const timedOutAt = this.now().toISOString();
        writeGrant({
          v: 1, inviteId: record.inviteId, handle: record.handle, attempt,
          peerCourierDid: hello.artifactB.from.courier, peerOwnerDid: hello.artifactB.from.owner, space,
          startedAt, timedOutAt,
          notAfter: outgoing?.expiresAt ?? new Date(Date.parse(timedOutAt) + GRANT_LIFETIME_MS).toISOString(),
          cid: outgoing?.cid ?? 'unknown', cause,
        });
        grantRecorded = true;
        this.env.log({ event: 'invite-possible-grant', inviteId: record.inviteId, cid: outgoing?.cid ?? 'unknown' });
      } catch (e) {
        // A grant that may exist but could not be written down: its latest end goes on the record itself (never shortened), and is shown to the owner with no DID.
        const until = outgoing?.expiresAt ?? new Date(this.now().getTime() + GRANT_LIFETIME_MS).toISOString();
        const previous = record.unrecordedGrantUntil !== undefined && Date.parse(record.unrecordedGrantUntil) > this.now().getTime() ? record.unrecordedGrantUntil : undefined;
        record.unrecordedGrantUntil = laterDate(previous, until);
        unrecordedNow = true;
        this.env.log({ event: 'invite-possible-grant-failed', inviteId: record.inviteId, reason: reasonOf(e) });
      }
    };
    try {
      if (record.artifactC === undefined) {
        this.cas(record.inviteId, claim, guard);
        // A Welcome that is already out (a rejected one a deny left behind) must be found BEFORE a grant is minted for it.
        if (await getJson(this.kv, `${inviteFolder(record.inviteId)}out/welcome.json`)) {
          throw new CourierError('welcome-exists', 'a Welcome is already written for this invite');
        }
        this.cas(record.inviteId, claim, guard);
        const profile = this.env.profile();
        space = profile.spaceId ?? '';
        const artifactC = await this.bounded(
          'acceptB',
          (signal) => this.realAccept(profile, this.env.node, hello.artifactB, record.handle, {
            signal,
            onRequest: () => { requested = true; },
            onOutgoing: (grant) => {
              outgoing = grant;
              // The abandoned attempt got its answer after all: this file is the only thing it may update.
              if (grantRecorded) updateGrantLate(record.inviteId, attempt, { cid: grant.cid, notAfter: grant.expiresAt });
            },
          }),
          (outcome) => {
            // `late` says whether the node issued the grant, which is what a later cleanup needs, not whether acceptB finished: an abandoned step that
            // got its grant still ends in an error.
            if (grantRecorded) updateGrantLate(record.inviteId, attempt, { late: outgoing !== undefined ? 'ok' : outcome, lateAt: this.now().toISOString() });
          },
        );
        this.cas(record.inviteId, claim, guard);
        record.artifactC = artifactC;
        writeRecord(record);
        persisted = true;
      }
      this.env.fault?.('before-welcome');
      this.cas(record.inviteId, claim, guard);
      await this.writeWelcome({ v: 1, inviteId: record.inviteId, tier: record.tier, artifactC: record.artifactC, sentAt: this.now().toISOString() });
      this.cas(record.inviteId, claim, guard);
      record.status = 'completed';
      record.completedPeer = { handle: record.handle, courierDid: hello.artifactB.from.courier, ownerDid: hello.artifactB.from.owner };
      delete record.held;
      writeRecord(record);
    } catch (e) {
      const timedOut = e instanceof CourierError && e.code === 'node-timeout';
      // A grant that may exist but that no artifact C carries is written down before anything else, also when the lock was lost.
      if (!persisted && (outgoing !== undefined || (timedOut && requested))) recordPossibleGrant(timedOut ? 'timeout' : 'error');
      // A holder that lost its lock or whose record was changed under it writes nothing more; the invite is left for recovery.
      if (e instanceof CourierError && e.code === 'invite-lock-lost') throw e;
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
      delete record.completedPeer;
      record.status = 'consumed';
      // Written to the record at once, not only with the hold: a hold that fails leaves the invite consumed for the sweep, and the date must survive that.
      if (unrecordedNow) this.saveUnrecorded(record, claim, guard);
      await this.hold(record, hello, timedOut ? 'node-timeout' : 'internal-error', guard);
      if (timedOut) return 'node-timeout';
      return e instanceof CourierError && e.code === 'welcome-exists' ? 'welcome-exists' : 'internal-error';
    }
    // The public copy is best-effort. A failed write is logged by reason and reconciled by the next sweep; it never changes the outcome.
    publishStatus(record, this.env.log);
    await this.finish(record);
    await this.emit({ kind: 'invite-completed', peer: record.handle, threadId: record.inviteId, detail: '', invite: inviteFacts(record, hello, '', this.now().getTime()) });
    return undefined;
  }

  /** Persists the record with its unrecorded-grant date while the invite is still `consumed` by this holder. A lost lock writes nothing; any other failure is logged. */
  private saveUnrecorded(record: InviteRecord, claim: Claim, guard: LockGuard | undefined): void {
    try {
      this.cas(record.inviteId, claim, guard);
      writeRecord(record);
    } catch (e) {
      this.env.log({ event: 'invite-possible-grant-failed', inviteId: record.inviteId, reason: reasonOf(e) });
    }
  }

  /**
   * Stores the hello for a decision, then removes the remote copy. The remote copy goes only after the held copy is written, so a crash
   * in between leaves a hello to recover. A failure here leaves the invite consumed; the next sweep holds it and notifies once.
   */
  private async hold(record: InviteRecord, hello: Hello, reason: string, guard?: LockGuard): Promise<void> {
    const claim = consumedClaim(record);
    try {
      this.cas(record.inviteId, claim, guard);
      writeSecure(heldPath(record.inviteId), hello);
      await delIfPresent(this.kv, `${inviteFolder(record.inviteId)}in/hello.json`);
      this.cas(record.inviteId, claim, guard);
      record.status = 'held';
      record.held = { reason, at: this.now().toISOString(), owner: hello.artifactB.from.owner, courierDid: hello.artifactB.from.courier };
      writeRecord(record);
    } catch (e) {
      if (e instanceof CourierError && e.code === 'invite-lock-lost') throw e;
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
      return;
    }
    publishStatus(record, this.env.log);
    this.env.log({ event: 'invite-held', inviteId: record.inviteId, reason });
    await this.emit({ kind: 'invite-held', peer: record.handle, threadId: record.inviteId, detail: '', invite: inviteFacts(record, hello, reason, this.now().getTime()) });
  }

  /**
   * The approval the owner's command uses: `owner` is the owner the human says they mean to pair, and it must be the owner of the hello that is
   * actually held (`owner-mismatch` otherwise; nothing is paired or changed). The hello that is paired is the one that was checked.
   */
  async approveHeld(id: string, owner: string, tier?: AcceptedTier): Promise<AcceptedTier> {
    return withInviteLock(id, this.env.timing, async (guard) => {
      const record = await this.heldRecord(id, guard);
      const hello = readHeld(id);
      if (!hello) fail('invite-not-held', 'Held hello is missing; nothing to approve.');
      if (!ownerConfirms(owner, hello.artifactB.from.owner)) {
        fail('owner-mismatch', 'The owner you gave is not the owner of the hello that is held; nothing was paired. Run the command again with the owner shown for this invite.');
      }
      return this.pairHeld(record, hello, tier, guard);
    });
  }

  private async pairHeld(record: InviteRecord, hello: Hello, tier: AcceptedTier | undefined, guard: LockGuard): Promise<AcceptedTier> {
    const peersProblem = peersEntryProblem(record.handle, this.env.peersFiles ?? peersFilesFor());
    if (peersProblem !== undefined) fail(peersProblem, `${peersMessage(peersProblem)} The invite stays held.`);
    this.cas(record.inviteId, claimOf(record), guard);
    if (tier !== undefined) record.tier = tier;
    record.status = 'consumed';
    record.consumedAt = this.now().toISOString();
    record.consumedBy = newMarker();
    writeRecord(record);
    publishStatus(record, this.env.log);
    const reason = await this.complete(record, hello, guard);
    if (reason === 'node-timeout') {
      const grant = newestGrant(possibleGrants(record.inviteId, this.now().getTime()), record.consumedBy);
      const unrecorded = unrecordedUntil(record, this.now().getTime());
      fail(reason, grant
        ? `Pairing timed out (node-timeout); the invite is held again. A read grant to courier ${grant.peerCourierDid} may exist until ${grant.notAfter}; see courier invite list.`
        : unrecorded
          ? `Pairing timed out (node-timeout); the invite is held again. A read grant may exist until ${unrecorded}; it could not be written down here, so the courier it is for is not shown.`
          : 'Pairing timed out (node-timeout); the invite is held again.');
    }
    if (reason !== undefined) fail(reason, 'Pairing failed; the invite is held again. Retry approve or deny.');
    return record.tier;
  }

  /** Owner denies a held invite. The invitee gets a rejected Welcome with no artifact. */
  async deny(id: string): Promise<void> {
    return withInviteLock(id, this.env.timing, (guard) => this.denyLocked(id, guard));
  }

  private async denyLocked(id: string, guard: LockGuard): Promise<void> {
    const record = await this.heldRecord(id, guard);
    this.cas(id, claimOf(record), guard);
    record.status = 'consumed';
    record.consumedAt = this.now().toISOString();
    record.consumedBy = newMarker();
    writeRecord(record);
    publishStatus(record, this.env.log);
    const welcome: Welcome = { v: 1, inviteId: id, tier: 'rejected', sentAt: this.now().toISOString() };
    const claim = consumedClaim(record);
    try {
      this.cas(id, claim, guard);
      await putCreate(this.kv, `${inviteFolder(id)}out/welcome.json`, welcome);
    } catch (e) {
      if (e instanceof CourierError && e.code === 'invite-lock-lost') throw e;
      // Any failure leaves the invite held, so approve or a retried deny stays possible.
      this.cas(id, claim, guard);
      record.status = 'held';
      writeRecord(record);
      publishStatus(record, this.env.log);
      if (e instanceof CourierError && e.code === 'conflict') fail('welcome-exists', 'Welcome already written for this invite; it cannot be denied.');
      throw e;
    }
    this.cas(id, claim, guard);
    this.dropPendingPeer(record.handle);
    record.status = 'denied';
    delete record.held;
    writeRecord(record);
    publishStatus(record, this.env.log);
    await this.finish(record);
  }

  /** Revokes an open or held invite. Removes everything, including the welcome. */
  async revoke(record: InviteRecord): Promise<void> {
    if (record.status !== 'open' && record.status !== 'held') {
      fail('invite-not-open', `Invite is ${record.status}; only open or held invites can be revoked.`);
    }
    // Under the invite's lock: an approve or deny working on it makes this fail with invite-busy instead of deleting what they are writing.
    await withInviteLock(record.inviteId, this.env.timing, (guard) => this.close(record, 'revoked', guard), `A pairing for this invite is finishing. ${INVITE_BUSY_WAIT}`);
  }

  private async heldRecord(id: string, guard?: LockGuard): Promise<InviteRecord> {
    const record = readRecord(id);
    if (!record || record.status !== 'held') fail('invite-not-held', 'Invite is not held; only held invites take a decision.');
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.close(record, 'expired', guard);
      fail('invite-expired', 'Invite has expired.');
    }
    return record;
  }

  /** Remote cleanup first, then the local status. A crash leaves the record open or held for the next sweep. */
  private async close(record: InviteRecord, status: 'expired' | 'revoked', guard?: LockGuard): Promise<void> {
    // Whoever closes works from a record it read earlier: it may only close the invite if it is still in that state (not completed or re-consumed since).
    this.cas(record.inviteId, claimOf(record), guard);
    await this.deleteSealedBlob(record);
    const kv = this.kv;
    for (const key of await listAll(kv, inviteFolder(record.inviteId))) await delIfPresent(kv, key);
    this.cas(record.inviteId, claimOf(record), guard);
    this.dropPendingPeer(record.handle);
    removeHeld(record.inviteId);
    record.status = status;
    delete record.held;
    writeRecord(record);
    publishStatus(record, this.env.log);
  }

  /** Post-decision cleanup. The welcome stays until expiry so the invitee can read it. Failures are logged, not thrown. */
  private async finish(record: InviteRecord): Promise<void> {
    try {
      await this.clearInbound(inviteFolder(record.inviteId));
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
    }
    await this.deleteSealedBlob(record);
    removeHeld(record.inviteId);
  }

  private async clearInbound(folder: string): Promise<void> {
    for (const key of await listAll(this.kv, `${folder}in/`)) await delIfPresent(this.kv, key);
  }

  private async deleteSealedBlob(record: InviteRecord): Promise<void> {
    try {
      await this.deleteSealed(inviteOrigin(), record.store.id, record.store.deleteToken);
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, step: 'delete-sealed', reason: reasonOf(e) });
    }
  }

  private dropPendingPeer(handle: string): void {
    const profile = this.env.profile();
    if (profile.peers[handle]?.status !== 'pending-A') return;
    delete profile.peers[handle];
    saveProfile(profile);
  }

  private async emit(notice: Notice): Promise<void> {
    if (!this.env.notify) return;
    try {
      await this.env.notify(notice);
    } catch (e) {
      this.env.log({ event: 'notify-error', inviteId: notice.threadId, reason: reasonOf(e) });
    }
  }
}

function inviteFacts(record: InviteRecord, hello: Hello, reason: string, nowMs: number): NonNullable<Notice['invite']> {
  const until = [...possibleGrants(record.inviteId, nowMs).map((g) => g.notAfter), ...(unrecordedUntil(record, nowMs) ? [unrecordedUntil(record, nowMs)!] : [])].sort().at(-1);
  return { id: record.inviteId, handle: record.handle, label: hello.claimedLabel, owner: hello.artifactB.from.owner, courierDid: hello.artifactB.from.courier, reason, tier: record.tier, ...(until ? { possibleGrantUntil: until } : {}) };
}

const BARE_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const OWNER_DID_ADDRESS = /^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/;

/** True when `given` (an owner DID, or a bare 0x address) names the owner `helloOwner` of the hello that is held. Nothing else matches. */
export function ownerConfirms(given: string, helloOwner: string): boolean {
  if (BARE_ADDRESS.test(given)) return OWNER_DID_ADDRESS.exec(helloOwner)?.[1]?.toLowerCase() === given.toLowerCase();
  return ownerMatches(given, helloOwner);
}

/** What the owner must see before a held invite is paired: who actually knocked, why it was held, and who was expected. */
export interface HeldFacts {
  inviteId: string;
  handle: string;
  reason: string;
  expectOwner: string | null;
  owner: string;
  courierDid: string;
  claimedLabel: string;
  /** Read grants an earlier, abandoned attempt may have left (still within their validity). */
  possibleGrants: PossibleGrant[];
  /** Latest end of a read grant that may exist but could not be written down (so no courier is shown for it), while still possible. */
  unrecordedGrantUntil?: string;
}

/** The end of a read grant that may exist but is not on file (`unrecordedGrantUntil` on the record), while it can still be valid. */
function unrecordedUntil(record: InviteRecord, nowMs: number): string | undefined {
  const until = record.unrecordedGrantUntil;
  return until !== undefined && Date.parse(until) > nowMs ? until : undefined;
}

/** Reads the held invite and its hello from local files (no network). `invite-not-held` when the invite is not held or its hello is gone. */
export function describeHeld(id: string): HeldFacts {
  const record = readRecord(id);
  if (!record || record.status !== 'held') fail('invite-not-held', 'Invite is not held; only held invites take a decision.');
  const hello = readHeld(id);
  if (!hello) fail('invite-not-held', 'Held hello is missing; nothing to approve.');
  return {
    inviteId: id,
    handle: record.handle,
    reason: record.held?.reason ?? 'unknown',
    expectOwner: record.expectOwner ?? null,
    owner: hello.artifactB.from.owner,
    courierDid: hello.artifactB.from.courier,
    claimedLabel: hello.claimedLabel,
    possibleGrants: possibleGrants(id, Date.now()),
    ...(unrecordedUntil(record, Date.now()) ? { unrecordedGrantUntil: unrecordedUntil(record, Date.now()) } : {}),
  };
}

export function heldFactsText(facts: HeldFacts): string {
  return [
    `Invite ${facts.inviteId} for handle "${facts.handle}" is held (${facts.reason}).`,
    `  The hello that arrived is from owner ${facts.owner}, ${courierPhrase(facts.courierDid)}.`,
    `  Name it claims (not verified): ${facts.claimedLabel}`,
    `  Owner this invite expected: ${facts.expectOwner ?? 'any (no --expect-owner was set)'}`,
    ...facts.possibleGrants.map((g) => `  An earlier pairing attempt ${g.cause === 'error' ? 'failed' : 'timed out'} at ${g.timedOutAt} after asking the node for a read grant to courier ${g.peerCourierDid}. That grant may exist until ${g.notAfter} (cid ${g.cid}). It was not sent to the invitee and is not revoked automatically yet.`),
    ...(facts.unrecordedGrantUntil ? [`  An earlier pairing attempt may have asked the node for a read grant that could not be written down here, so the courier it is for is not shown. That grant may exist until ${facts.unrecordedGrantUntil}. It was not sent to the invitee and is not revoked automatically yet.`] : []),
  ].join('\n');
}
