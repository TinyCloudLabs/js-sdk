import fs from 'node:fs';
import path from 'node:path';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { acceptB, fail } from './commands.js';
import { CourierError } from './errors.js';
import { deleteSealed as deleteSealedReal, inviteOrigin } from './invite-link.js';
import { publicHeldReason, readPublicStatus, updatePublicInvite, type HeldReason } from './invite-public.js';
import { inviteFolder, ownerMatches, parseHello, type Hello, type Tier, type Welcome } from './invite-schema.js';
import type { Notice, Notifier } from './notify.js';
import type { WatchLog } from './wake.js';
import { saveProfile, secureSubdir, writeSecure, type Profile } from './profile.js';
import { peersEntryProblem, peersFilesFor, peersMessage, type PeersFile } from './peers-guard.js';

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
  /** Artifact C, persisted before the Welcome write so a retried approve reuses it instead of pairing again. */
  artifactC?: Welcome['artifactC'];
  completedPeer?: { handle: string; courierDid: string; ownerDid: string };
  cleanedAt?: string;
  /** Set when the record moves to consumed. Recovery waits RECOVER_AFTER_MS past it. */
  consumedAt?: string;
}

const RECORD_FILE = /^[a-z2-7]{26}\.json$/;
const RECOVER_AFTER_MS = 10 * 60 * 1000;
/** A lock older than this belongs to a process that died; it is removed so a crash cannot wedge an invite. */
const LOCK_STALE_MS = 2 * 60 * 1000;
const lockPath = (id: string) => path.join(secureSubdir('invites'), `${id}.lock`);

/**
 * Runs `fn` while holding the invite's exclusive lock (`<id>.lock`, created `wx`, 0600, in the 0700 invites dir). Approve, deny and recovery take it so two
 * of them cannot both read `held` and both pair. A lock that is already held makes the caller fail with `invite-busy` at once (it never waits); a lock
 * older than LOCK_STALE_MS is taken over. Released in `finally`. `revoke` never takes it.
 */
async function withInviteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const file = lockPath(id);
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs < LOCK_STALE_MS) break;
      fs.rmSync(file, { force: true });
    }
  }
  if (fd === undefined) fail('invite-busy', 'Another approve, deny or recovery is working on this invite. Try again in a minute.');
  fs.closeSync(fd);
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}
const peerKey = (p: { handle: string; courierDid: string; ownerDid: string } | null | undefined): string => (p ? `${p.handle}|${p.courierDid}|${p.ownerDid}` : '');
const invitesDir = () => secureSubdir('invites');
export const recordPath = (id: string) => path.join(invitesDir(), `${id}.json`);
const heldPath = (id: string) => path.join(invitesDir(), `${id}.held.json`);
const seenPath = () => path.join(invitesDir(), 'seen-credentials.json');

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export const readRecord = (id: string) => readJson<InviteRecord>(recordPath(id));
export const writeRecord = (record: InviteRecord) => writeSecure(recordPath(record.inviteId), record);

/** Only `<id>.json` records; held hellos and the seen-credential file are excluded by name. */
export function listRecords(): InviteRecord[] {
  const dir = invitesDir();
  return fs.readdirSync(dir).filter((n) => RECORD_FILE.test(n)).flatMap((n) => {
    const record = readJson<InviteRecord>(path.join(dir, n));
    return record ? [record] : [];
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
}

type Check = { ok: true; replayKey: string } | { ok: false; reason: string };

/**
 * Inviter-side state machine. A hello is consumed on disk before any other action. Only a verified,
 * matching, unrestricted hello pairs without a human; everything else is held for a decision.
 */
export class InviteWatcher {
  private readonly now: () => Date;
  private readonly verify: (input: VerifyEmailProofInput) => Promise<VerifyEmailProofResult>;
  private readonly accept: typeof acceptB;
  private readonly deleteSealed: typeof deleteSealedReal;

  constructor(private readonly env: InviteEnv) {
    this.now = env.now ?? (() => new Date());
    this.verify = env.verify ?? verifyReal;
    this.accept = env.accept ?? acceptB;
    this.deleteSealed = env.deleteSealed ?? deleteSealedReal;
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
    } catch (e) {
      this.env.log({ event: 'invite-sweep-error', reason: reasonOf(e) });
    }
  }

  private async sweepOne(listed: InviteRecord): Promise<void> {
    await this.recoverConsumed(listed);
    // Recovery works on the record it re-reads under the lock, so carry on from what is on disk now, not from the listing.
    const record = listed.status === 'consumed' ? (readRecord(listed.inviteId) ?? listed) : listed;
    await this.reconcilePublic(record);
    if (Date.parse(record.expiresAt) > this.now().getTime()) {
      // A missed hook must not strand a hello: the poll runs the same handler. It consumes the hello first, so a hello seen twice pairs once.
      if (record.status === 'open') await this.onHello(record.inviteId);
      return;
    }
    if (record.status === 'open' || record.status === 'held' || record.status === 'failed') {
      await this.close(record, 'expired');
      return;
    }
    if ((record.status === 'completed' || record.status === 'denied') && record.cleanedAt === undefined) {
      await delIfPresent(this.env.node.kv, `${inviteFolder(record.inviteId)}out/welcome.json`);
      record.cleanedAt = this.now().toISOString();
      writeRecord(record);
    }
  }

  /**
   * Recovers an invite left in consumed by a crash or a failed hold. Waits RECOVER_AFTER_MS past consumedAt so a live handleHello or approve is not disturbed.
   * An expired invite closes. The held copy, else a valid remote hello, is held with internal-error. With neither, the invite fails with hello-lost.
   */
  private async recoverConsumed(snapshot: InviteRecord): Promise<void> {
    if (snapshot.status !== 'consumed') return;
    try {
      await withInviteLock(snapshot.inviteId, async () => {
        // Re-read under the lock: an approve or deny that held it may have moved the invite on.
        const record = readRecord(snapshot.inviteId);
        if (record) await this.recoverLocked(record);
      });
    } catch (e) {
      if (e instanceof CourierError && e.code === 'invite-busy') return;
      throw e;
    }
  }

  private async recoverLocked(record: InviteRecord): Promise<void> {
    if (record.status !== 'consumed') return;
    if (record.consumedAt !== undefined && this.now().getTime() - Date.parse(record.consumedAt) < RECOVER_AFTER_MS) return;
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.close(record, 'expired');
      return;
    }
    // The held copy wins: a recovery must never let a later writer replace the identity the owner already saw. The remote hello is used only when
    // there is no held copy (a crash between the hello arriving and the hold).
    const hello = readHeld(record.inviteId) ?? (await this.remoteHello(record.inviteId));
    if (hello) {
      await this.hold(record, hello, 'internal-error');
      return;
    }
    record.status = 'failed';
    writeRecord(record);
    publishStatus(record, this.env.log);
    await this.finish(record);
    this.env.log({ event: 'invite-failed', inviteId: record.inviteId, reason: 'hello-lost' });
    await this.emit({ kind: 'invite-failed', peer: record.handle, threadId: record.inviteId, detail: 'hello-lost' });
  }

  /** The hello still under in/, or undefined when it is gone or invalid. An invalid hello is logged by reason; finish clears it. */
  private async remoteHello(id: string): Promise<Hello | undefined> {
    const got = await getJson<unknown>(this.env.node.kv, `${inviteFolder(id)}in/hello.json`);
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
    const kv = this.env.node.kv;
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
    const kv = this.env.node.kv;
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
  private async complete(record: InviteRecord, hello: Hello): Promise<string | undefined> {
    try {
      if (record.artifactC === undefined) {
        record.artifactC = await this.accept(this.env.profile(), this.env.node, hello.artifactB, record.handle);
        writeRecord(record);
      }
      this.env.fault?.('before-welcome');
      await this.writeWelcome({ v: 1, inviteId: record.inviteId, tier: record.tier, artifactC: record.artifactC, sentAt: this.now().toISOString() });
      record.status = 'completed';
      record.completedPeer = { handle: record.handle, courierDid: hello.artifactB.from.courier, ownerDid: hello.artifactB.from.owner };
      delete record.held;
      writeRecord(record);
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
      delete record.completedPeer;
      await this.hold(record, hello, 'internal-error');
      return 'internal-error';
    }
    // The public copy is best-effort. A failed write is logged by reason and reconciled by the next sweep; it never changes the outcome.
    publishStatus(record, this.env.log);
    await this.finish(record);
    await this.emit({ kind: 'invite-completed', peer: record.handle, threadId: record.inviteId, detail: '', invite: inviteFacts(record, hello, '') });
    return undefined;
  }

  /**
   * Stores the hello for a decision, then removes the remote copy. The remote copy goes only after the held copy is written, so a crash
   * in between leaves a hello to recover. A failure here leaves the invite consumed; the next sweep holds it and notifies once.
   */
  private async hold(record: InviteRecord, hello: Hello, reason: string): Promise<void> {
    try {
      writeSecure(heldPath(record.inviteId), hello);
      await delIfPresent(this.env.node.kv, `${inviteFolder(record.inviteId)}in/hello.json`);
      record.status = 'held';
      record.held = { reason, at: this.now().toISOString(), owner: hello.artifactB.from.owner, courierDid: hello.artifactB.from.courier };
      writeRecord(record);
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
      return;
    }
    publishStatus(record, this.env.log);
    this.env.log({ event: 'invite-held', inviteId: record.inviteId, reason });
    await this.emit({ kind: 'invite-held', peer: record.handle, threadId: record.inviteId, detail: '', invite: inviteFacts(record, hello, reason) });
  }

  /**
   * The approval the owner's command uses: `owner` is the owner the human says they mean to pair, and it must be the owner of the hello that is
   * actually held (`owner-mismatch` otherwise; nothing is paired or changed). The hello that is paired is the one that was checked.
   */
  async approveHeld(id: string, owner: string, tier?: AcceptedTier): Promise<AcceptedTier> {
    return withInviteLock(id, async () => {
      const record = await this.heldRecord(id);
      const hello = readHeld(id);
      if (!hello) fail('invite-not-held', 'Held hello is missing; nothing to approve.');
      if (!ownerConfirms(owner, hello.artifactB.from.owner)) {
        fail('owner-mismatch', 'The owner you gave is not the owner of the hello that is held; nothing was paired. Run the command again with the owner shown for this invite.');
      }
      return this.pairHeld(record, hello, tier);
    });
  }

  private async pairHeld(record: InviteRecord, hello: Hello, tier: AcceptedTier | undefined): Promise<AcceptedTier> {
    const peersProblem = peersEntryProblem(record.handle, this.env.peersFiles ?? peersFilesFor());
    if (peersProblem !== undefined) fail(peersProblem, `${peersMessage(peersProblem)} The invite stays held.`);
    if (tier !== undefined) record.tier = tier;
    record.status = 'consumed';
    record.consumedAt = this.now().toISOString();
    writeRecord(record);
    publishStatus(record, this.env.log);
    const reason = await this.complete(record, hello);
    if (reason !== undefined) fail(reason, 'Pairing failed; the invite is held again. Retry approve or deny.');
    return record.tier;
  }

  /** Owner denies a held invite. The invitee gets a rejected Welcome with no artifact. */
  async deny(id: string): Promise<void> {
    return withInviteLock(id, () => this.denyLocked(id));
  }

  private async denyLocked(id: string): Promise<void> {
    const record = await this.heldRecord(id);
    record.status = 'consumed';
    record.consumedAt = this.now().toISOString();
    writeRecord(record);
    publishStatus(record, this.env.log);
    const welcome: Welcome = { v: 1, inviteId: id, tier: 'rejected', sentAt: this.now().toISOString() };
    try {
      await putCreate(this.env.node.kv, `${inviteFolder(id)}out/welcome.json`, welcome);
    } catch (e) {
      // Any failure leaves the invite held, so approve or a retried deny stays possible.
      record.status = 'held';
      writeRecord(record);
      publishStatus(record, this.env.log);
      if (e instanceof CourierError && e.code === 'conflict') fail('welcome-exists', 'Welcome already written for this invite; it cannot be denied.');
      throw e;
    }
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
    await this.close(record, 'revoked');
  }

  private async heldRecord(id: string): Promise<InviteRecord> {
    const record = readRecord(id);
    if (!record || record.status !== 'held') fail('invite-not-held', 'Invite is not held; only held invites take a decision.');
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.close(record, 'expired');
      fail('invite-expired', 'Invite has expired.');
    }
    return record;
  }

  /** Remote cleanup first, then the local status. A crash leaves the record open or held for the next sweep. */
  private async close(record: InviteRecord, status: 'expired' | 'revoked'): Promise<void> {
    await this.deleteSealedBlob(record);
    const kv = this.env.node.kv;
    for (const key of await listAll(kv, inviteFolder(record.inviteId))) await delIfPresent(kv, key);
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
    for (const key of await listAll(this.env.node.kv, `${folder}in/`)) await delIfPresent(this.env.node.kv, key);
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

function inviteFacts(record: InviteRecord, hello: Hello, reason: string): NonNullable<Notice['invite']> {
  return { id: record.inviteId, handle: record.handle, label: hello.claimedLabel, owner: hello.artifactB.from.owner, courierDid: hello.artifactB.from.courier, reason, tier: record.tier };
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
  };
}

export function heldFactsText(facts: HeldFacts): string {
  return [
    `Invite ${facts.inviteId} for handle "${facts.handle}" is held (${facts.reason}).`,
    `  The hello that arrived is from owner ${facts.owner}, courier ${facts.courierDid}.`,
    `  Name it claims (not verified): ${facts.claimedLabel}`,
    `  Owner this invite expected: ${facts.expectOwner ?? 'any (no --expect-owner was set)'}`,
  ].join('\n');
}
