import fs from 'node:fs';
import path from 'node:path';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { acceptB, fail } from './commands.js';
import { CourierError } from './errors.js';
import { deleteSealed as deleteSealedReal, inviteOrigin } from './invite-link.js';
import { updatePublicInvite, type PublicInvite } from './invite-public.js';
import { inviteFolder, ownerMatches, parseHello, type Hello, type Tier, type Welcome } from './invite-schema.js';
import type { Notice, Notifier } from './notify.js';
import type { WatchLog } from './wake.js';
import { saveProfile, secureSubdir, writeSecure, type Profile } from './profile.js';
import { delIfPresent, getJson, listAll, putCreate } from './store.js';
import { verifyEmailProof as verifyReal, type VerifyEmailProofInput, type VerifyEmailProofResult } from './verify-email-proof.js';

export type AcceptedTier = Exclude<Tier, 'rejected'>;
/** Maps the owner's `--tier` flag to the tier the peer requested. `trusted` is recorded as a request; nothing here grants it, and the peer starts strict until the owner confirms trusted status. */
export function requestedTier(flag: string): AcceptedTier {
  if (flag === 'strict') return 'strict';
  if (flag === 'trusted') return 'trusted-requested';
  return fail('usage', '--tier must be strict or trusted.');
}
export type InviteStatus = 'open' | 'consumed' | 'held' | 'completed' | 'denied' | 'revoked' | 'expired';
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
  held?: { reason: string; at: string };
  completedPeer?: { handle: string; courierDid: string; ownerDid: string };
  cleanedAt?: string;
}

const RECORD_FILE = /^[a-z2-7]{26}\.json$/;
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

/**
 * Best-effort public copy update. Failure is logged by reason code and never changes the invite outcome.
 * Only status and completedPeer are patched; the create-time fields stay as written at create.
 */
export function publishStatus(record: InviteRecord, log: Log): void {
  if (record.publicDir === undefined) return;
  const patch: Partial<Pick<PublicInvite, 'status' | 'completedPeer'>> = { status: record.status };
  if (record.completedPeer !== undefined) patch.completedPeer = record.completedPeer;
  try {
    updatePublicInvite(record.publicDir, record.inviteId, patch);
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

  private async sweepOne(record: InviteRecord): Promise<void> {
    if (Date.parse(record.expiresAt) > this.now().getTime()) return;
    if (record.status === 'open' || record.status === 'held') {
      await this.close(record, 'expired');
      return;
    }
    if ((record.status === 'completed' || record.status === 'denied') && record.cleanedAt === undefined) {
      await delIfPresent(this.env.node.kv, `${inviteFolder(record.inviteId)}out/welcome.json`);
      record.cleanedAt = this.now().toISOString();
      writeRecord(record);
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
      await this.clearInbound(folder);
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
      await delIfPresent(kv, helloKey);
      return;
    }
    latest.status = 'consumed';
    writeRecord(latest);
    publishStatus(latest, this.env.log);
    await delIfPresent(kv, helloKey);
    await this.decide(latest, hello);
  }

  private async decide(record: InviteRecord, hello: Hello): Promise<void> {
    let decision: Check;
    try {
      decision = await this.check(record, hello);
    } catch (e) {
      await this.hold(record, hello, reasonOf(e));
      return;
    }
    if (!decision.ok) {
      await this.hold(record, hello, decision.reason);
      return;
    }
    await this.complete(record, hello, record.tier, decision.replayKey);
  }

  private async check(record: InviteRecord, hello: Hello): Promise<Check> {
    if (hello.credential === undefined) return { ok: false, reason: 'no-credential' };
    if (hello.possession === undefined) return { ok: false, reason: 'no-possession' };
    const verified = await this.verify({
      credential: hello.credential,
      possession: hello.possession,
      expectEmail: record.email,
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
    if (record.alsoAsk) return { ok: false, reason: 'also-ask' };
    return { ok: true, replayKey: `${verified.credentialId}:${record.inviteId}` };
  }

  /** Pairs the peer and writes Welcome. Returns a reason code on failure; the invite then stays consumed. */
  private async complete(record: InviteRecord, hello: Hello, tier: AcceptedTier, replayKey?: string): Promise<string | undefined> {
    try {
      const artifactC = await this.accept(this.env.profile(), this.env.node, hello.artifactB, record.handle);
      if (replayKey !== undefined) addSeenReplayKey(replayKey);
      const welcome: Welcome = { v: 1, inviteId: record.inviteId, tier, artifactC, sentAt: this.now().toISOString() };
      if ((await putCreate(this.env.node.kv, `${inviteFolder(record.inviteId)}out/welcome.json`, welcome)) === null) {
        throw new CourierError('welcome-exists', 'welcome already written for this invite');
      }
      record.status = 'completed';
      record.tier = tier;
      record.completedPeer = { handle: record.handle, courierDid: hello.artifactB.from.courier, ownerDid: hello.artifactB.from.owner };
      delete record.held;
      writeRecord(record);
      publishStatus(record, this.env.log);
    } catch (e) {
      const reason = reasonOf(e);
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason });
      return reason;
    }
    await this.finish(record);
    await this.emit({ kind: 'invite-completed', peer: record.handle, threadId: record.inviteId, detail: '', invite: inviteFacts(record, hello, '') });
    return undefined;
  }

  private async hold(record: InviteRecord, hello: Hello, reason: string): Promise<void> {
    try {
      writeSecure(heldPath(record.inviteId), hello);
      record.status = 'held';
      record.held = { reason, at: this.now().toISOString() };
      writeRecord(record);
      publishStatus(record, this.env.log);
    } catch (e) {
      this.env.log({ event: 'invite-error', inviteId: record.inviteId, reason: reasonOf(e) });
    }
    this.env.log({ event: 'invite-held', inviteId: record.inviteId, reason });
    await this.emit({ kind: 'invite-held', peer: record.handle, threadId: record.inviteId, detail: '', invite: inviteFacts(record, hello, reason) });
  }

  /** Owner approves a held invite. Status is consumed before pairing so a second decision cannot run. */
  async approve(id: string, tier?: AcceptedTier): Promise<void> {
    const record = await this.heldRecord(id);
    const hello = readHeld(id);
    if (!hello) fail('invite-not-held', 'Held hello is missing; nothing to approve.');
    record.status = 'consumed';
    writeRecord(record);
    publishStatus(record, this.env.log);
    const reason = await this.complete(record, hello, tier ?? record.tier);
    if (reason !== undefined) fail(reason, 'Pairing failed; the invite stays consumed.');
  }

  /** Owner denies a held invite. The invitee gets a rejected Welcome with no artifact. */
  async deny(id: string): Promise<void> {
    const record = await this.heldRecord(id);
    record.status = 'consumed';
    writeRecord(record);
    publishStatus(record, this.env.log);
    const welcome: Welcome = { v: 1, inviteId: id, tier: 'rejected', sentAt: this.now().toISOString() };
    if ((await putCreate(this.env.node.kv, `${inviteFolder(id)}out/welcome.json`, welcome)) === null) {
      fail('welcome-exists', 'Welcome already written for this invite.');
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
