import fs from 'node:fs';
import path from 'node:path';
import { cmd } from './program.js';
import { loadGrant, profileDir, readSecure, saveKey, saveProfile, writeSecure } from './profile.js';
import type { AgentKey, Profile } from './profile.js';
import { openRelayResult } from '@tinycloud/share-envelope/links';
import { holdsApproval, readPending } from './grant-request.js';
import { hasLivePending } from './pending.js';
import { REVOKE_URL, withRefusalNotice } from './grant-refusal.js';
import { CourierError } from './errors.js';

/**
 * One derivation of where `init` stands, shared by every init mode.
 *
 * Inputs (all in the Courier home): profile.json (`status`, `spacePending`), grant.json, key.json, pending-grant.json (live records),
 * approval-pending.json, rotation.json, and any stray key-bearing temp file (`rotation.json.<pid>.<hex>.tmp`, `key.json.<pid>.<hex>.tmp`).
 *
 * `readInputs` is the only place that touches the disk, so the way the inputs are read can be replaced in one spot.
 * `classifyState` is pure. `deriveState` only reads: it never repairs, drops or rewrites a file. Recovery is the explicit
 * `recoverInterrupted` step an init mode takes after reading.
 *
 * Key rotation is one journaled step over key.json, profile.json, grant.json and approval-pending.json:
 *   (1) rotation.json is written (temp file, fsync, rename, directory fsync). It holds the complete NEW key and profile and the
 *       non-secret facts about the approval being discarded, so nothing about the discard depends on the process staying alive;
 *   (2) key.json is replaced; (3) profile.json is replaced; (4) grant.json, and approval-pending.json when discarding, are removed;
 *   (5) the discard warning is printed, then rotation.json is removed (its only deletion point).
 * Before the rename in (1) nothing but a stray temp file can differ from the old state. From then on every init mode rolls forward
 * from the journal alone; every step is idempotent. A process killed while writing a temp file leaves it behind (0600, holding a
 * key that was never installed): `recoverInterrupted` zero-fills and removes it.
 */
const ROTATION_FILE = 'rotation.json';
const APPROVAL_FILE = 'approval-pending.json';
const STRAY_TEMP = /^(?:rotation|key)\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

export type ApprovalState = 'none' | 'open' | 'held' | 'committed' | 'unreadable' | 'corrupt';
export type ProfileStatus = 'absent' | Profile['status'];

export interface StateInputs {
  profile: ProfileStatus;
  spacePending: boolean;
  grant: boolean;
  key: boolean;
  pendingGrant: boolean;
  approval: ApprovalState;
  rotation: boolean;
  rotationTemp: boolean;
}

export type StateAction = 'finish-rotation' | 'refuse' | 'init' | 'rotate-key' | 'wait' | 'resume' | 'request' | 'fix-approval' | 'none';

export type StateName =
  | 'rotation-interrupted' | 'approval-orphaned' | 'new' | 'key-only' | 'key-missing'
  | 'approval-held' | 'saved-delegation' | 'saved-grant' | 'approval-open' | 'approval-unreadable' | 'awaiting-grant'
  | 'grant-missing' | 'space-pending' | 'space-missing' | 'ready-approval' | 'ready';

export interface DerivedState {
  inputs: StateInputs;
  state: StateName;
  action: StateAction;
  /** A stray key-bearing temp file is on disk and `recoverInterrupted` removes it. */
  cleanTemp: boolean;
  /** `init --wait` goes on; when false it advises `adviceFor(state)`. */
  wait: boolean;
  /** Warnings about files that were read and not used (printed once by the init mode). */
  notes: string[];
}

/**
 * A saved grant is a regular, owner-only grant.json that parses and has the shape of a grant (the existing `loadGrant`). A truncated or
 * corrupt file, or a path that is not a file, is not a saved grant: it is left as it is, counted as absent, and reported once.
 */
function savedGrant(notes: string[]): boolean {
  if (!fs.existsSync(path.join(profileDir(), 'grant.json'))) return false;
  try {
    return loadGrant() !== undefined;
  } catch (error) {
    notes.push(`grant.json is not a usable saved grant, so it is treated as not saved and left as it is (${(error as Error).message}).`);
    return false;
  }
}

export const heldApproval = (approval: ApprovalState): boolean => approval === 'held' || approval === 'committed';
const liveApproval = (approval: ApprovalState): boolean => approval === 'open' || approval === 'unreadable' || heldApproval(approval);

/**
 * Whether `init --wait` goes on (collects a saved approval, or makes the request) rather than advising another command. It follows from the
 * same inputs and action as everything else here: an approval the owner gave (retryable result reference, saved result or commit) is
 * always collected, even beside a saved grant; an open request is collected while the space is being set up; otherwise `--wait` goes on
 * only where the action is waiting, requesting or starting, and advises `--resume` for a grant saved and not installed.
 */
function waitGoesOn(i: StateInputs, action: StateAction): boolean {
  if (action === 'refuse' || action === 'finish-rotation') return false;
  if (heldApproval(i.approval)) return true;
  if (i.approval === 'open' && i.profile === 'awaiting-space') return true;
  return action === 'wait' || action === 'request' || action === 'init';
}

export function classifyState(i: StateInputs): Omit<DerivedState, 'inputs' | 'notes'> {
  const is = (state: StateName, action: StateAction) => ({ state, action, cleanTemp: i.rotationTemp, wait: waitGoesOn(i, action) });
  if (i.rotation) return is('rotation-interrupted', 'finish-rotation');
  // A saved approval without the profile or key it belongs to is never dropped here: the person decides.
  if (liveApproval(i.approval) && (i.profile === 'absent' || !i.key)) return is('approval-orphaned', 'refuse');
  if (i.profile === 'absent') return i.key ? is('key-only', 'init') : is('new', 'init');
  if (!i.key) return is('key-missing', 'rotate-key');
  if (i.profile === 'awaiting-grant') {
    // A grant saved and not installed is installed first (`--resume`); a held approval beside it stays on disk for the next `--wait`.
    if (i.pendingGrant) return is('saved-delegation', 'resume');
    if (i.grant) return is('saved-grant', 'resume');
    // With nothing saved to install, an approval the owner gave is collected, never discarded.
    if (heldApproval(i.approval)) return is('approval-held', 'wait');
    if (i.approval === 'open') return is('approval-open', 'wait');
    if (i.approval === 'unreadable') return is('approval-unreadable', 'fix-approval');
    return is('awaiting-grant', 'request');
  }
  if (i.profile === 'awaiting-space') {
    if (!i.grant) return heldApproval(i.approval) ? is('approval-held', 'wait') : is('grant-missing', 'request');
    return i.spacePending ? is('space-pending', 'resume') : is('space-missing', 'resume');
  }
  // ready: a held renewal is collected by `--wait`; `--resume` stays refused on a ready profile, as before.
  if (heldApproval(i.approval)) return is('ready-approval', 'wait');
  if (i.approval === 'unreadable') return is('approval-unreadable', 'fix-approval');
  if (!i.grant) return is('grant-missing', 'request');
  if (i.approval === 'open') return is('ready-approval', 'wait');
  return is('ready', 'none');
}

function approvalState(): ApprovalState {
  const read = readPending();
  if (read.kind !== 'ok') return read.kind;
  if (read.pending.committed) return 'committed';
  return holdsApproval(read.pending) ? 'held' : 'open';
}

const rotationPath = (): string => path.join(profileDir(), ROTATION_FILE);

/** The profile's status and spacePending, read without validating the rest: an unreadable or outdated profile is the job of the mode that loads it. */
function readProfileFields(): { status: ProfileStatus; spacePending: boolean } {
  try {
    const profile = readSecure<{ status?: unknown; spacePending?: unknown }>('profile.json', false);
    const status = profile?.status;
    return { status: status === 'awaiting-grant' || status === 'awaiting-space' || status === 'ready' ? status : 'absent', spacePending: profile?.spacePending === true };
  } catch {
    return { status: 'absent', spacePending: false };
  }
}

function strayTemps(): string[] {
  try { return fs.readdirSync(profileDir()).filter((name) => STRAY_TEMP.test(name)).sort(); } catch { return []; }
}

/** The one place the inputs are read. Reads only. `notes` are warnings the init mode prints once; nothing is repaired or removed. */
export function readInputs(notes: string[] = []): StateInputs {
  const dir = profileDir();
  const { status, spacePending } = readProfileFields();
  return {
    profile: status,
    spacePending,
    grant: savedGrant(notes),
    key: fs.existsSync(path.join(dir, 'key.json')),
    pendingGrant: hasLivePending(),
    approval: approvalState(),
    rotation: fs.existsSync(rotationPath()),
    rotationTemp: strayTemps().length > 0,
  };
}

export function deriveState(): DerivedState {
  const notes: string[] = [];
  const inputs = readInputs(notes);
  return { inputs, notes, ...classifyState(inputs) };
}

/** The next command for the person or agent running init. */
export function adviceFor(d: Pick<DerivedState, 'state'>): string {
  switch (d.state) {
    case 'rotation-interrupted': return `A key rotation was interrupted. Any \`${cmd('init')}\` command finishes it first.`;
    case 'approval-orphaned': return `A saved approval request (approval-pending.json) has no matching profile and agent key, so it was left as it is and nothing was changed. Restore the missing file, or run \`${cmd('init --rotate-key')}\` to discard the approval and start again.`;
    case 'new':
    case 'key-only': return `No Courier profile yet. Run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
    case 'key-missing': return `The profile has no agent key. Run \`${cmd('init --rotate-key')}\` and approve a new grant.`;
    case 'saved-delegation':
    case 'saved-grant': return `An approved grant is saved and not installed: run \`${cmd('init --resume')}\`. No new approval is needed.`;
    case 'approval-held': return `An approval from the owner is saved: run \`${cmd('init --wait')}\`. No new approval is needed.`;
    case 'approval-open': return `An approval request is open: run \`${cmd('init --wait')}\` to collect it once the owner approves.`;
    case 'approval-unreadable': return `The saved approval request cannot be read. Fix its file permissions, then run \`${cmd('init --wait')}\`.`;
    case 'awaiting-grant': return `No grant yet. Run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
    case 'grant-missing': return `The profile has no saved grant. Run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
    case 'space-pending':
    case 'space-missing': return `The grant is saved and the agents space is still being set up: run \`${cmd('init --resume')}\`. \`${cmd('init --wait')}\` collects an approval that \`${cmd('init --request')}\` asked for.`;
    case 'ready-approval': return `An approval request is saved: run \`${cmd('init --wait')}\` to collect or acknowledge it.`;
    case 'ready': return `This profile already has a grant and no approval request is pending. To renew it, run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
  }
}

// ---------- recovery ----------

/** Explicit recovery: roll an interrupted rotation forward, then remove stray key-bearing temp files. Run once at the start of an init mode. */
export function recoverInterrupted(): void {
  finishRotation();
  for (const name of strayTemps()) scrub(path.join(profileDir(), name));
}

/** A stray temp file may hold a private key: only a regular file of this user is touched; its bytes are zeroed (best effort) before it is unlinked. */
function scrub(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.()) {
    throw new CourierError('stray-temp', `${file} is not a regular file of this user, so it was left as it is. Remove it by hand, then run the command again.`);
  }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.writeSync(fd, Buffer.alloc(stat.size));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(file);
  syncDir();
}

function syncDir(): void {
  const dir = fs.openSync(profileDir(), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

// ---------- rotation journal ----------

interface RotationJournal {
  v: 1;
  key: AgentKey;
  profile: Profile;
  /** A held or committed approval was on disk when the rotation was validated: it is bound to the old key and is removed in step 4. */
  discardApproval: boolean;
  /** That approval already held an approved result (`resultEnvelope` collected, or `committed`): a live grant may exist. */
  grantedResult: boolean;
  /** The delegation of that result, when it could be read. Not a secret. */
  delegationCid?: string;
}

/** The non-secret facts about the saved approval, taken before the journal is written. */
async function approvalFacts(): Promise<Pick<RotationJournal, 'discardApproval' | 'grantedResult' | 'delegationCid'>> {
  const read = readPending();
  if (read.kind !== 'ok' || !holdsApproval(read.pending)) return { discardApproval: false, grantedResult: false };
  const pending = read.pending;
  const grantedResult = pending.resultEnvelope !== undefined || pending.committed === true;
  let delegationCid: string | undefined;
  if (grantedResult && pending.resultEnvelope !== undefined) {
    try {
      const opened = await openRelayResult(pending.resultEnvelope, pending.requestId, pending.relayPrivateKey);
      const claimed = (opened.delegation as { delegationCid?: unknown } | null | undefined)?.delegationCid;
      if (typeof claimed === 'string' && claimed !== '') delegationCid = claimed;
    } catch { /* the notice is still given, without the CID */ }
  }
  return { discardApproval: true, grantedResult, ...(delegationCid ? { delegationCid } : {}) };
}

/** Steps 1-5. `profile` is the complete new profile. */
export async function rotateKey(key: AgentKey, profile: Profile): Promise<void> {
  const journal: RotationJournal = { v: 1, key, profile, ...(await approvalFacts()) };
  writeSecure(rotationPath(), journal);
  applyRotation(journal);
}

function removeIfPresent(file: string): void {
  try { fs.unlinkSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function applyRotation(journal: RotationJournal): void {
  saveKey(journal.key);
  saveProfile(journal.profile);
  removeIfPresent(path.join(profileDir(), 'grant.json'));
  if (journal.discardApproval) removeIfPresent(path.join(profileDir(), APPROVAL_FILE));
  syncDir();
  if (journal.discardApproval) warnDiscarded(journal);
  fs.unlinkSync(rotationPath());
  syncDir();
}

/** Printed from the journal, so any init mode that finishes the rotation, also after a crash, says the same thing. */
function warnDiscarded(journal: RotationJournal): void {
  console.error('The saved approval request already held an approval from the owner. It is bound to the old agent key, so this key rotation discards that approval: the owner must approve a new request.');
  if (!journal.grantedResult) return;
  const error = withRefusalNotice(
    new CourierError('approval-result-invalid', 'The owner already approved that request, so a live grant may exist for the old agent key.'),
    journal.delegationCid,
  ) as Error;
  console.error(error.message.includes(REVOKE_URL) ? error.message : `${error.message}\nA live grant may exist: the owner can revoke it at ${REVOKE_URL}.`);
}

/** Roll an interrupted rotation forward. Returns whether one was found. */
export function finishRotation(): boolean {
  if (!fs.existsSync(rotationPath())) return false;
  const journal = readSecure<RotationJournal>(ROTATION_FILE, true)!;
  if (journal.v !== 1 || !journal.key?.did || !journal.profile?.courierDid) {
    throw new CourierError('bad-profile', `Corrupt key rotation record at ${rotationPath()}`);
  }
  applyRotation(journal);
  return true;
}
