import fs from 'node:fs';
import path from 'node:path';
import { cmd } from './program.js';
import { hasProfileFields, isAgentKey, loadGrant, loadKey, profileDir, readSecure, saveKey, saveProfile, writeSecure } from './profile.js';
import type { AgentKey, Profile } from './profile.js';
import { checkApprovalResultBinding, openRelayResult } from '@tinycloud/share-envelope/links';
import { holdsApproval, readPending } from './grant-request.js';
import { assertBoundToKey } from './grant.js';
import { bareDid, siweTimes } from './authority.js';
import { dropPendingDelegation, hasLivePending, liveRedeemedDelegations } from './pending.js';
import { REVOKE_URL } from './grant-refusal.js';
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
/** `unreadable`: profile.json exists and cannot be read (permissions or content). It is never the same as `absent`. */
export type ProfileStatus = 'absent' | 'unreadable' | Profile['status'];

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

export type StateAction = 'finish-rotation' | 'refuse' | 'fix-profile' | 'init' | 'rotate-key' | 'wait' | 'resume' | 'request' | 'fix-approval' | 'none';

export type StateName =
  | 'rotation-interrupted' | 'profile-unreadable' | 'approval-orphaned' | 'new' | 'key-only' | 'key-missing'
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
  if (action === 'refuse' || action === 'finish-rotation' || action === 'fix-profile') return false;
  if (heldApproval(i.approval)) return true;
  // As before: on a profile that has a grant (ready) or is setting up its space, `--wait` only collects a request that is saved.
  if (i.profile === 'awaiting-space' || i.profile === 'ready') return i.approval === 'open';
  return action === 'wait' || action === 'request' || action === 'init';
}

export function classifyState(i: StateInputs): Omit<DerivedState, 'inputs' | 'notes'> {
  const is = (state: StateName, action: StateAction) => ({ state, action, cleanTemp: i.rotationTemp, wait: waitGoesOn(i, action) });
  if (i.rotation) return is('rotation-interrupted', 'finish-rotation');
  if (i.profile === 'unreadable') return is('profile-unreadable', 'fix-profile');
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

/**
 * The profile's status and spacePending, read without validating the rest (an outdated profile is the job of the mode that loads it).
 * A profile.json that exists and cannot be read, or has no usable status, is `unreadable`: never the same as absent.
 */
function readProfileFields(): { status: ProfileStatus; spacePending: boolean } {
  if (!fs.existsSync(path.join(profileDir(), 'profile.json'))) return { status: 'absent', spacePending: false };
  try {
    const profile = readSecure<{ status?: unknown; spacePending?: unknown }>('profile.json', false);
    const status = profile?.status;
    if (status === 'awaiting-grant' || status === 'awaiting-space' || status === 'ready') return { status, spacePending: profile?.spacePending === true };
  } catch { /* unreadable */ }
  return { status: 'unreadable', spacePending: false };
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

/** Which mode to restore depends on what is loose: the profile directory is 0700, a private file inside it 0600. */
function permissionAdvice(name: string): string {
  return `If the directory is loose, run \`chmod 700 ${profileDir()}\`; if the file is loose, run \`chmod 600 ${path.join(profileDir(), name)}\`.`;
}

function orphanAdvice(approval: ApprovalState): string {
  const file = path.join(profileDir(), APPROVAL_FILE);
  const left = `A saved approval request (${file}) has no matching profile and agent key. It was left as it is and nothing was changed.`;
  if (approval === 'unreadable') return `${left} The request cannot be read. ${permissionAdvice(APPROVAL_FILE)} Then run the command again.`;
  if (approval === 'open') return `${left} Restore the missing file, or run \`${cmd('init --rotate-key')}\` to start over with a new agent key.`;
  return `${left} Restore the missing file, or run \`${cmd('init --rotate-key')}\`, which discards that approval and starts over with a new agent key.`;
}

/** The next command for the person or agent running init. */
export function adviceFor(d: Pick<DerivedState, 'state' | 'inputs'>): string {
  switch (d.state) {
    case 'rotation-interrupted': return `A key rotation was interrupted. Any \`${cmd('init')}\` command finishes it first.`;
    case 'profile-unreadable': return `${path.join(profileDir(), 'profile.json')} cannot be read, so nothing was changed. ${permissionAdvice('profile.json')} If its content is damaged, \`${cmd('init --rotate-key')}\` replaces the agent key and the profile with new ones.`;
    case 'approval-orphaned': return orphanAdvice(d.inputs.approval);
    case 'new':
    case 'key-only': return `No Courier profile yet. Run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
    case 'key-missing': return `The profile has no agent key. Run \`${cmd('init --rotate-key')}\` and approve a new grant.`;
    case 'saved-delegation':
    case 'saved-grant': return `An approved grant is saved and not installed: run \`${cmd('init --resume')}\`. No new approval is needed.`;
    case 'approval-held': return `An approval from the owner is saved: run \`${cmd('init --wait')}\`. No new approval is needed.`;
    case 'approval-open': return `An approval request is open: run \`${cmd('init --wait')}\` to collect it once the owner approves.`;
    case 'approval-unreadable': return `The saved approval request cannot be read. ${permissionAdvice(APPROVAL_FILE)} Then run \`${cmd('init --wait')}\`.`;
    case 'awaiting-grant': return `No grant yet. Run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
    case 'grant-missing': return d.inputs.profile === 'ready'
      ? `This profile already has a grant and no approval request is pending. To renew it, run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`
      : `The grant is saved and the "agents" space is still being set up: run \`${cmd('init --resume')}\`. \`${cmd('init --wait')}\` collects an approval that \`${cmd('init --request')}\` asked for.`;
    case 'space-pending':
    case 'space-missing': return `The grant is saved and the agents space is still being set up: run \`${cmd('init --resume')}\`. \`${cmd('init --wait')}\` collects an approval that \`${cmd('init --request')}\` asked for.`;
    case 'ready-approval': return `An approval request is saved: run \`${cmd('init --wait')}\` to collect or acknowledge it.`;
    case 'ready': return `This profile already has a grant and no approval request is pending. To renew it, run \`${cmd('init --request')}\`, send the printed openkeyUrl to the owner, then run \`${cmd('init --wait')}\`.`;
  }
}

// ---------- recovery ----------

/**
 * Explicit recovery, run once at the start of an init mode: roll an interrupted rotation forward (only after the journal validated), then
 * remove stray key-bearing temp files. A refusal in the first step happens before anything is changed.
 */
export function recoverInterrupted(): void {
  finishRotation();
  for (const name of strayTemps()) scrub(path.join(profileDir(), name));
}

/**
 * A stray temp file may hold a private key. Only a plain file of this user with a single link is touched, and it is checked again on the
 * open descriptor so a swap between the check and the open is caught: its bytes are overwritten with zeros (best effort: a copy-on-write or
 * journaling filesystem may keep old blocks) and it is unlinked. Anything else is left as it is and reported.
 */
function scrub(file: string): void {
  const refuse = () => new CourierError('stray-temp', `${file} is not a plain file of this user with one link, so it was left as it is. Remove it by hand, then run the command again.`);
  const plain = (stat: fs.Stats) => stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1;
  const before = fs.lstatSync(file);
  if (!plain(before)) throw refuse();
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    const open = fs.fstatSync(fd);
    if (!plain(open) || open.dev !== before.dev || open.ino !== before.ino) throw refuse();
    fs.writeSync(fd, Buffer.alloc(open.size));
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

interface DiscardedGrant {
  delegationCid: string;
  /** When the delegation expires, if its SIWE message said. Not a secret. */
  expiresAt?: string;
}

interface RotationJournal {
  v: 1;
  key: AgentKey;
  profile: Profile;
  /** A held or committed approval was on disk when the rotation was validated: it is bound to the old key and is removed in step 4. */
  discardApproval: boolean;
  /** That approval already held an approved result (`resultEnvelope` collected, or `committed`): a live grant may exist. */
  grantedResult: boolean;
  /** The delegation and its expiry, when they could be read from that result. Not secrets. */
  delegationCid?: string;
  grantExpiresAt?: string;
  /** Redeemed delegations saved for the old key (pending-grant.json), removed in step 4. Not secrets: no header, no signature. */
  discardedGrants?: DiscardedGrant[];
}

/** What is wrong with a parsed journal, or undefined when it is a rotation this code may replay. Never includes any of its content. */
function journalProblem(journal: unknown): string | undefined {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return 'it is not an object';
  const j = journal as Partial<RotationJournal>;
  if (j.v !== 1) return 'its version is not 1';
  if (!isAgentKey(j.key)) return 'its key is not a valid agent key';
  if (!hasProfileFields(j.profile ?? null)) return 'its profile is not a complete current profile';
  if (j.profile?.status !== 'awaiting-grant') return 'its profile is not awaiting-grant';
  if (j.profile.courierDid !== bareDid(j.key.did)) return 'its profile does not belong to its key';
  if (typeof j.discardApproval !== 'boolean' || typeof j.grantedResult !== 'boolean') return 'its approval facts are not booleans';
  if (j.delegationCid !== undefined && typeof j.delegationCid !== 'string') return 'its delegation is not text';
  if (j.grantExpiresAt !== undefined && typeof j.grantExpiresAt !== 'string') return 'its grant expiry is not text';
  if (j.discardedGrants !== undefined
    && (!Array.isArray(j.discardedGrants) || j.discardedGrants.some((g) => !g || typeof g.delegationCid !== 'string' || g.delegationCid === '' || (g.expiresAt !== undefined && typeof g.expiresAt !== 'string')))) {
    return 'its discarded grants are not a list of delegations';
  }
  return undefined;
}

/** The non-secret facts about the saved approval, taken before the journal is written. */
async function approvalFacts(): Promise<Pick<RotationJournal, 'discardApproval' | 'grantedResult' | 'delegationCid' | 'grantExpiresAt'>> {
  const read = readPending();
  if (read.kind !== 'ok' || !holdsApproval(read.pending)) return { discardApproval: false, grantedResult: false };
  const pending = read.pending;
  const grantedResult = pending.resultEnvelope !== undefined || pending.committed === true;
  let delegationCid: string | undefined;
  let grantExpiresAt: string | undefined;
  if (grantedResult && pending.resultEnvelope !== undefined) {
    try {
      const opened = await openRelayResult(pending.resultEnvelope, pending.requestId, pending.relayPrivateKey);
      const claimed = (opened.delegation as { delegationCid?: unknown } | null | undefined)?.delegationCid;
      if (typeof claimed === 'string' && claimed !== '') delegationCid = claimed;
      grantExpiresAt = checkApprovalResultBinding(opened, { requestId: pending.requestId, bodyCid: pending.bodyCid, request: pending.request }).delegationExpiresAt;
    } catch { /* the notice is still given, with what could be read */ }
  }
  return { discardApproval: true, grantedResult, ...(delegationCid ? { delegationCid } : {}), ...(grantExpiresAt ? { grantExpiresAt } : {}) };
}

/** Redeemed delegations saved for the OLD agent key: they would be useless after the rotation and may be live grants. */
function oldKeyDelegations(): DiscardedGrant[] {
  let old: AgentKey;
  try { old = loadKey(); } catch { return []; }
  const found: DiscardedGrant[] = [];
  for (const delegation of liveRedeemedDelegations()) {
    try { assertBoundToKey(delegation, old); } catch { continue; }
    if (typeof delegation.delegationCid !== 'string' || delegation.delegationCid === '') continue;
    let expiresAt: string | undefined;
    try { expiresAt = siweTimes(delegation.siwe).expiresAt?.toISOString(); } catch { /* unknown */ }
    found.push({ delegationCid: delegation.delegationCid, ...(expiresAt ? { expiresAt } : {}) });
  }
  return found;
}

/** Steps 1-5. `profile` is the complete new profile. */
export async function rotateKey(key: AgentKey, profile: Profile): Promise<void> {
  const journal: RotationJournal = { v: 1, key, profile, ...(await approvalFacts()), discardedGrants: oldKeyDelegations() };
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
  for (const grant of journal.discardedGrants ?? []) dropPendingDelegation(grant.delegationCid);
  syncDir();
  warnDiscarded(journal);
  fs.unlinkSync(rotationPath());
  syncDir();
}

/** Printed from the journal, so any init mode that finishes the rotation, also after a crash, says the same thing. */
function warnDiscarded(journal: RotationJournal): void {
  if (journal.discardApproval) {
    console.error('The saved approval request already held an approval from the owner. It is bound to the old agent key, so this key rotation discards that approval: the owner must approve a new request.');
  }
  if (journal.discardApproval && journal.grantedResult) {
    const named = journal.delegationCid ? ` (delegation ${journal.delegationCid})` : '';
    const until = journal.grantExpiresAt ? `, valid until ${journal.grantExpiresAt}` : '';
    console.error(`That request was already granted by the owner${named}, so a live grant may exist${until}. This agent cannot revoke it; the owner can revoke it at ${REVOKE_URL}.`);
  }
  for (const grant of journal.discardedGrants ?? []) {
    const until = grant.expiresAt ? `, valid until ${grant.expiresAt}` : '';
    console.error(`A redeemed grant saved for the old agent key and not installed (delegation ${grant.delegationCid}) was discarded by this key rotation. A live grant may exist${until}. This agent cannot revoke it; the owner can revoke it at ${REVOKE_URL}.`);
  }
}

/** Roll an interrupted rotation forward. Returns whether one was found. Refuses, changing nothing, when the record is not a valid rotation. */
export function finishRotation(): boolean {
  if (!fs.existsSync(rotationPath())) return false;
  const journal = readSecure<unknown>(ROTATION_FILE, true);
  const problem = journalProblem(journal);
  if (problem) {
    throw new CourierError('bad-profile', `${rotationPath()} is not a valid key rotation record (${problem}). Nothing was changed. Restore it from a backup, or move it aside and run \`${cmd('init --rotate-key')}\` to start over with a new agent key.`);
  }
  applyRotation(journal as RotationJournal);
  return true;
}
