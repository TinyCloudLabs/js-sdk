import { adviceFor, deriveState, heldApproval, recoverInterrupted, rotateKey } from './state.js';
import { recentNotices } from './notify.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { TinyCloudNode, NodeWasmBindings, activateValidatedRuntimeDelegation, deserializeDelegation, publicJwk, serializeDelegation } from '@tinycloud/node-sdk';
import type { PortableDelegation } from '@tinycloud/node-sdk';
import { cmd } from './program.js';
import { initRequestNextLine } from './next-line.js';
import { CourierError, CourierPending, errInfo } from './errors.js';
import { AGENT_GRANT, AGENT_GRANT_EXPIRY, COURIER_SPACE, DEFAULT_HOST, EXT, k, peerReadPermissions, PREFIX } from './keys.js';
import {
  loadProfile, saveProfile, withProfileTransaction, assertNotPaired, getPeer, profileDir, profileExists, loadKey, saveKey,
  type AgentKey, type Profile, type StoredPeer,
} from './profile.js';
import { revokePeer } from './revoke.js';
import { courierNode, peerKv } from './node.js';
import { REVOKE_URL } from './grant-refusal.js';
import { courierGrantRequest, grantFromInput, installRefusing, isShortCode, noSpaceError, pendingSpaceError, receiveGrant, resumeAwaitingGrant, resumeGrant } from './grant.js';
import { completeApproval, DEFAULT_WAIT_MS, MAX_WAIT_MS, requestApproval, waitApproval } from './grant-request.js';
import { approvalPhase, assertPendingReadable, clearPending, holdsApproval, loadPending, readApprovalEntry, stageOf } from './approval-phase.js';
import {
  artifactA, artifactWithDelegation, parseArtifact, peerRecordBody, PEER_DELEGATION_EXPIRY, validateArtifactIdentity,
} from './pairing.js';
import {
  authRequiredTask, buildMessage, buildTask, COUNTERPARTY_NOTICE, isRecord, messageView, oneLine, safeText,
  messageRole, parseTaskState, taskView,
  type CourierMessage, type CourierTask, type Intent, INTENTS, type ThreadMeta,
} from './a2a.js';
import { commitReceipts, collectInbound, renderInboxText, writeOut } from './inbox.js';
import { getJson, listAll, putCreate, putMatch, del } from './store.js';
import { DEFAULT_ORDERS } from './orders.js';
import { requestFields, requestIds, requestShapeProblem, requestText } from './request.js';
import { requestHash } from './canonical.js';
import { targetHelp } from './guard/target.js';
import type { ParsedArgs } from './args.js';
import { requireFlag, oneOf } from './args.js';
import { assertExactAuthority, assertPeerDelegation, bareDid, durationMs, AGENT_GRANT_MAX_MS } from './authority.js';

interface Ctx {
  profile: Profile;
  node: TinyCloudNode;
}

async function ctx(): Promise<Ctx> {
  const profile = loadProfile();
  const node = await courierNode(profile);
  return { profile, node };
}

function newAgentKey(): AgentKey {
  const manager = new NodeWasmBindings().createSessionManager();
  const id = manager.createSessionKey('courier');
  const jwk = manager.jwk(id);
  if (!jwk) throw new CourierError('key-generation', 'SDK failed to generate the Courier agent key.');
  return { v: 1, jwk: JSON.parse(jwk) as Record<string, unknown>, did: manager.getDID(id), createdAt: new Date().toISOString() };
}

function printJson(v: unknown) {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}


function fail(code: string, message: string): never {
  throw new CourierError(code, message);
}

// ---------- init ----------

/** A value flag's value, or undefined when absent. parseArgs records a value-less flag as 'true'. */
function initValue(args: ParsedArgs, name: string): string | undefined {
  if (!args.has(name)) return undefined;
  const value = args.get(name)!;
  if (value === 'true' || value === '') fail('usage', `--${name} needs a value.`);
  return value;
}

function initUrl(args: ParsedArgs, name: string): string | undefined {
  if (!args.has(name)) return undefined;
  const value = args.get(name)!;
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* reported below */ }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) fail('usage', `--${name} needs a URL.`);
  return value;
}

export async function cmdInit(args: ParsedArgs) {
  if (args.has('key') || args.has('key-file') || args.has('force')) {
    fail('usage', `Owner private-key flags are not supported. Use \`${cmd('init --request')}\` and approve the restricted grant in OpenKey.`);
  }
  const hostFlag = initUrl(args, 'host');
  const openkeyHostFlag = initUrl(args, 'openkey-host');
  const apiHostFlag = initUrl(args, 'openkey-api-host');
  const labelFlag = initValue(args, 'label');
  const handleFlag = initValue(args, 'handle');
  const expiry = args.get('expiry') ?? AGENT_GRANT_EXPIRY;
  const expiryMs = durationMs(expiry);
  if (!expiryMs || expiryMs > AGENT_GRANT_MAX_MS) fail('usage', `--expiry must be a duration such as 7d, at most ${AGENT_GRANT_EXPIRY}.`);
  if (args.has('resume') && (args.has('request') || args.has('grant-file') || args.has('paste') || args.has('rotate-key'))) {
    fail('usage', `\`${cmd('init --resume')}\` cannot be combined with --request, --grant-file, --paste or --rotate-key.`);
  }
  const timeoutFlag = initValue(args, 'timeout');
  if (args.has('wait') && (args.has('request') || args.has('grant-file') || args.has('paste') || args.has('resume'))) {
    fail('usage', `\`${cmd('init --wait')}\` cannot be combined with --request, --grant-file, --paste or --resume.`);
  }
  if (timeoutFlag !== undefined && !args.has('wait')) fail('usage', `--timeout needs --wait.`);
  const waitMs = timeoutFlag === undefined ? DEFAULT_WAIT_MS : durationMs(timeoutFlag);
  if (!waitMs || waitMs > MAX_WAIT_MS) fail('usage', `--timeout must be a duration such as 60s or 5m, at most 9m.`);
  const grantFile = args.has('grant-file')
    ? requireFlag(args, 'grant-file', `Usage: ${cmd('init [--request | --grant-file <file|->]')}`)
    : undefined;
  // Read the grant before touching the profile, so a bad path or empty stdin cannot cost the key.
  // --request returns before the grant is used, so never block on stdin for it.
  const grantRaw = grantFile === undefined || args.has('request')
    ? undefined
    : grantFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(grantFile, 'utf8');
  // Explicit recovery before any mode acts: finish an interrupted rotation, remove stray key-bearing temp files; then derive once.
  recoverInterrupted();
  const state = deriveState();
  for (const note of state.notes) console.error(`warning: ${note}`);
  // A profile.json that exists and cannot be read is never treated as absent: `loadProfile` refuses with its own message (an unreadable
  // profile is replaced only by an explicit `--rotate-key`).
  if (state.action === 'fix-profile' && !args.has('rotate-key')) { loadProfile(); fail('bad-profile', adviceFor(state)); }
  // A saved approval without its profile or key is left as it is; `--rotate-key` starts over with a new key.
  if (state.action === 'refuse' && !args.has('rotate-key')) fail('approval-orphaned', adviceFor(state));
  // A grant.json that is not owner-only is a saved grant that cannot be used yet: it is neither replaced nor counted as missing. A rotation
  // discards the grant by design, so it goes on.
  if (state.grantMode && !args.has('rotate-key')) {
    const file = path.join(profileDir(), 'grant.json');
    fail('profile-permissions', `${file} must be owner-only (mode 0600); found mode ${state.grantMode}. It holds a saved grant, so nothing was changed. Run \`chmod 600 ${file}\`, then run the command again.`);
  }
  const HELD_APPROVAL_KEPT = `The saved approval request holds an approval from the owner and was kept: run \`${cmd('init --wait')}\` to collect or acknowledge it.`;
  if (args.has('resume')) {
    if (!profileExists()) fail('no-grant', `No Courier profile to resume. Run \`${cmd('init')}\` and approve a grant first.`);
    const profile = loadProfile();
    // An approval the owner gave, with no grant saved to install first, is collected by `--wait`, never discarded or shadowed by a cleanup.
    if (state.action === 'wait' && heldApproval(state.inputs.approval) && profile.status !== 'ready') {
      console.error(`${adviceFor(state)} Continuing as \`${cmd('init --wait')}\`.`);
      await collectApproval(profile, loadKey(), { expiry: args.get('expiry'), openkeyApiHost: apiHostFlag, waitMs });
      return;
    }
    if (profile.status === 'awaiting-grant' && await resumeAwaitingGrant(profile)) {
      dropOpenRequest();
      if (heldApproval(state.inputs.approval)) console.error(HELD_APPROVAL_KEPT);
      await finishInit(profile, profile.host);
      return;
    }
    if (profile.status !== 'awaiting-space') fail('usage', `\`${cmd('init --resume')}\` requires a profile in awaiting-space state.`);
    await resumeGrant(profile, loadKey());
    dropOpenRequest();
    if (heldApproval(state.inputs.approval)) console.error(HELD_APPROVAL_KEPT);
    await finishInit(profile, profile.host);
    return;
  }

  const rotate = args.has('rotate-key');
  // A writer must learn that the saved approval is unreadable BEFORE the key, grant or profile is changed.
  // Also for a plain `--rotate-key`: an approval that cannot be read may be bound to the old key, and a rotation would leave it there.
  if (args.has('request') || args.has('wait') || rotate) assertPendingReadable();
  const prior = profileExists() && !rotate ? loadProfile() : undefined;
  // A renewal is asked for with `--request`; `--wait` only collects. The derived state says when `--wait` goes on.
  if (args.has('wait') && !rotate && !state.wait) fail('usage', adviceFor(state));
  const key = prior ? loadKey() : newAgentKey();
  const host = hostFlag ?? prior?.host ?? process.env.COURIER_HOST ?? DEFAULT_HOST;
  const openkeyHost = openkeyHostFlag ?? prior?.openkeyHost ?? process.env.COURIER_OPENKEY_HOST ?? 'https://openkey.so';
  const profile: Profile = prior ?? {
    version: 3,
    host,
    openkeyHost,
    label: labelFlag ?? `courier · ${os.hostname()}`,
    ...(handleFlag ? { selfHandle: handleFlag } : {}),
    courierDid: bareDid(key.did),
    status: 'awaiting-grant',
    peers: {},
  };
  profile.host = host;
  profile.openkeyHost = openkeyHost;
  profile.label = labelFlag ?? profile.label;
  if (handleFlag) profile.selfHandle = handleFlag;
  profile.courierDid = bareDid(key.did);
  if (rotate) {
    profile.peers = {};
    profile.ownerDid = undefined;
    profile.spaceId = undefined;
    profile.grantExpiresAt = undefined;
    profile.status = 'awaiting-grant';
    // One journaled step: key, profile, grant and a discarded approval change together, and an interruption is finished by the next init.
    await rotateKey(key, profile);
  } else {
    saveKey(key);
    saveProfile(profile);
  }
  const request = courierGrantRequest(profile, key, expiry, { openkeyApiHost: apiHostFlag });
  if (rotate) console.error('Agent key rotated. Existing peer pairings must be re-established; the old grant remains valid until expiry.');

  if (args.has('request')) {
    const pending = await requestApproval(profile, key, args.get('expiry'), { openkeyApiHost: apiHostFlag });
    console.error(`Send the owner this link to approve (it expires ${pending.requestExpiresAt}). Copy it exactly, never retype it:\n${pending.approvalUrl}\nThen run \`${cmd('init --wait --timeout 60s')}\` to collect the approval.`);
    console.error(initRequestNextLine());
    // A resumed request keeps the lifetime it was made with.
    const lifetime = pending.request.grantLifetimeSeconds * 1000 === expiryMs ? expiry : `${pending.request.grantLifetimeSeconds}s`;
    printJson({ did: key.did, courierDid: profile.courierDid, publicJwk: publicJwk(key.jwk), host, space: COURIER_SPACE, permissions: AGENT_GRANT, expiry: lifetime, openkeyUrl: pending.approvalUrl });
    return;
  }

  if (args.has('wait')) {
    await collectApproval(profile, key, { expiry: args.get('expiry'), openkeyApiHost: apiHostFlag, waitMs });
    return;
  }

  let payload;
  if (grantRaw !== undefined) {
    payload = await grantFromInput(grantRaw, key, { apiHost: request.openkeyApiHost });
  } else {
    payload = await receiveGrant(request, { paste: args.has('paste') });
  }
  try {
    await installRefusing(profile, key, payload, { viaCode: grantRaw !== undefined && isShortCode(grantRaw) });
  } catch (error) {
    // `no-space` means the grant IS saved (awaiting the space); any other error installed nothing and leaves an open short-link request alone.
    if (error instanceof CourierError && error.code === 'no-space') clearPendingQuietly();
    throw error;
  }
  // An open short-link request would otherwise be collected later, on top of this grant.
  clearPendingQuietly();
  await finishInit(profile, host);
}

/**
 * A grant was installed from another source (legacy import): the saved short-link request would be collected later, on top of it,
 * so it is removed. Says so when it held an approval the owner gave (that approval is lost). Never fails the command.
 */
function clearPendingQuietly(): void {
  try {
    const phase = approvalPhase(readApprovalEntry());
    if (phase.phase === 'held' && phase.stage === 'committed') {
      console.error('This grant replaces a saved short-link approval that was already installed: its acknowledgement to OpenKey is never sent (harmless; OpenKey discards the result).');
    } else if (phase.phase === 'held') {
      console.error('This grant replaces the saved short-link approval: discarded a saved approval that was not installed.');
    } else if (phase.phase === 'unreadable' || phase.phase === 'corrupt') {
      console.error('This grant replaces the saved short-link request: discarded an unreadable saved approval request (it may have held an approval that was not installed).');
    }
    clearPending();
  } catch (error) {
    console.error(`warning: could not remove the saved approval request (${(error as Error).message}).`);
  }
}

/**
 * `init --resume` installed a grant: an open short-link request that holds nothing would be collected later, on top of it. One with a
 * result reference, the encrypted result or a commit stays, so the next `init --wait` can install it or send its acknowledgement.
 */
function dropOpenRequest(): void {
  // Only a request that holds nothing: one with a result reference, the encrypted result or a committed grant is kept for `--wait`.
  const saved = loadPending();
  if (saved && !holdsApproval(saved)) clearPendingQuietly();
}

/** `init --wait`: create or resume the approval request, wait for the owner, install the result and acknowledge it. `--resume` hands off here while an approval is saved. */
async function collectApproval(profile: Profile, key: AgentKey, options: { expiry?: string; openkeyApiHost?: string; waitMs: number }): Promise<void> {
  const deadline = Date.now() + options.waitMs;
  const { pending, resumed } = await waitApproval(profile, key, options.expiry, { openkeyApiHost: options.openkeyApiHost });
  if (stageOf(pending) !== 'committed') {
    console.error(`${resumed ? 'Resuming the saved approval request.' : 'Created an approval request.'} Owner: approve it in OpenKey (copy the link exactly, never retype it):\n${pending.approvalUrl}\nWaiting for approval (up to ${Math.round(options.waitMs / 1000)} s). Run \`${cmd('init --wait')}\` again after an interruption; no new approval is needed.`);
  }
  if (await completeApproval(profile, key, pending, { deadline }) === 'deadline') {
    throw new CourierPending({ step: 1, of: 1, approvalUrl: pending.approvalUrl, expiresAt: pending.requestExpiresAt }, !resumed);
  }
  const active = loadProfile();
  if (active.status !== 'ready') throw active.spacePending ? pendingSpaceError(active) : noSpaceError(active);
  await finishInit(active, active.host);
}

async function finishInit(profile: Profile, host: string): Promise<void> {
  const active = await ctx();
  for (const peer of Object.values(active.profile.peers)) {
    if (peer.status === 'paired') await renewOutbound(active, peer, true);
  }
  printJson({ ok: true, profileDir: profileDir(), ownerDid: profile.ownerDid, courierDid: profile.courierDid, spaceId: profile.spaceId, host, grantExpiresAt: profile.grantExpiresAt });
}

export function cmdManifest() {
  printJson({ space: COURIER_SPACE, expiry: AGENT_GRANT_EXPIRY, permissions: AGENT_GRANT });
}


// ---------- pair ----------

export async function cmdPair(args: ParsedArgs) {
  const sub = args.positional[0];
  if (sub === 'start') return pairStart(args);
  if (sub === 'accept') return pairAccept(args);
  if (sub === 'renew') return pairRenew(args);
  fail('usage', `Usage: ${cmd('pair start <peer> | pair accept <artifact-json|--file f|--stdin> | pair renew [peer] [--force] [--renew-artifact]')}`);
}

async function pairStart(args: ParsedArgs) {
  const { profile } = await ctx();
  const peerHandle = args.positional[1] ?? fail('usage', `Usage: ${cmd('pair start <peer> [--call-me <handle>]')}`);
  const callMe = args.get('call-me') ?? profile.selfHandle ?? peerHandle;
  if (profile.peers[peerHandle]?.status === 'paired') fail('usage', `Already paired with ${peerHandle}.`);
  profile.peers[peerHandle] = {
    handle: peerHandle,
    ownerDid: '',
    courierDid: '',
    spaceId: '',
    outbound: [],
    theirHandleForMe: peerHandle,
    status: 'pending-A',
    pairedAt: new Date().toISOString(),
  };
  saveProfile(profile);
  printJson(artifactA(profile, peerHandle, callMe));
}

function readArtifactArg(args: ParsedArgs): string {
  if (args.has('stdin')) return fs.readFileSync(0, 'utf8');
  const file = args.get('file');
  if (file) return fs.readFileSync(file, 'utf8');
  const pos = args.positional.slice(1).join(' ');
  if (!pos) fail('usage', `Usage: ${cmd('pair accept <artifact-json> | --file f | --stdin')}`);
  if (!pos.startsWith('{') && fs.existsSync(pos)) return fs.readFileSync(pos, 'utf8');
  return pos;
}


async function validatePeerDelegation(node: TinyCloudNode, profile: Profile, peer: StoredPeer, serialized: string): Promise<{ delegation: PortableDelegation; cid: string; expiresAt: string }> {
  const delegation = deserializeDelegation(serialized);
  const ownerAddress = peer.ownerDid.split(':').at(-1)?.toLowerCase();
  if (delegation.spaceId !== peer.spaceId || delegation.ownerAddress.toLowerCase() !== ownerAddress) {
    fail('bad-artifact', 'Peer delegation space or owner does not match the pairing artifact.');
  }
  if (!peer.theirHandleForMe) fail('bad-artifact', 'Pairing artifact is missing the peer mailbox handle.');
  const active = await activateValidatedRuntimeDelegation(node, delegation, {
    host: profile.host,
    authorize: (permissions) => {
      assertExactAuthority(permissions, peerReadPermissions(peer.theirHandleForMe!, peer.spaceId, peer.sessionId), 'Pair renewal');
      return true;
    },
  });
  assertPeerDelegation(active, {
    issuer: peer.courierDid,
    audience: profile.courierDid,
    spaceId: peer.spaceId,
    mailbox: peer.theirHandleForMe,
    sessionId: peer.sessionId,
  });
  const expiry = delegation.expiry instanceof Date ? delegation.expiry : new Date(delegation.expiry);
  return { delegation, cid: delegationCid(delegation), expiresAt: expiry.toISOString() };
}

async function pairAccept(args: ParsedArgs) {
  const { profile, node } = await ctx();
  const art = parseArtifact(readArtifactArg(args));
  validateArtifactIdentity(art);
  // A peer is a distinct AGENT key, not a distinct owner DID: two Courier agents of one owner
  // (a self-pairing like Sam↔Sam) pair normally. Only the exact same courier DID is self.
  if (art.from.courier === profile.courierDid) fail('bad-artifact', 'Refusing to pair with this agent identity.');

  if (art.step === 'A') {
    const handle = art.callMe;
    assertNotPaired(profile, handle); // before delegateTo: a refusal after it would leave a live delegation nothing records
    const outbound = await node.delegateTo(art.from.courier, peerReadPermissions(handle, profile.spaceId!), { expiry: PEER_DELEGATION_EXPIRY });
    const peer: StoredPeer = {
      handle, ownerDid: art.from.owner, courierDid: art.from.courier, label: art.from.label,
      spaceId: art.spaceId, outbound: [], theirHandleForMe: art.peer, status: 'awaiting-C', pairedAt: new Date().toISOString(),
    };
    recordOutbound(peer, outbound.delegation);
    profile.peers[handle] = peer;
    saveAfterDelegation(profile, outbound.delegation);
    await writePeerRecord(node, peer);
    printJson(artifactWithDelegation('B', profile, outbound.delegation, handle, art.peer));
    return;
  }

  if (art.step === 'B') {
    const handle = args.get('as') ?? art.callMe;
    const peer = findPendingPeer(profile, handle);
    const candidate: StoredPeer = {
      ...peer,
      ownerDid: art.from.owner,
      courierDid: art.from.courier,
      label: art.from.label,
      spaceId: art.spaceId,
      theirHandleForMe: art.peer,
    };
    const incoming = await validatePeerDelegation(node, profile, candidate, art.delegation!);
    Object.assign(peer, candidate);
    peer.inbound = { delegation: serializeDelegation(incoming.delegation), cid: incoming.cid, expiresAt: incoming.expiresAt };
    const outgoing = await node.delegateTo(peer.courierDid, peerReadPermissions(peer.handle, profile.spaceId!), { expiry: PEER_DELEGATION_EXPIRY });
    recordOutbound(peer, outgoing.delegation);
    peer.status = 'paired';
    saveAfterDelegation(profile, outgoing.delegation);
    await writePeerRecord(node, peer);
    printJson(artifactWithDelegation('C', profile, outgoing.delegation, peer.handle, art.peer));
    return;
  }

  const peer = profile.peers[art.callMe] ?? findPeerByCourier(profile, art.from.courier);
  if (!peer) fail('unknown-peer', `No paired peer for "${art.callMe}".`);
  if (peer.handle !== art.callMe) {
    fail('bad-artifact', `Artifact C names ${art.callMe}, but the matched peer handle is ${peer.handle}.`);
  }
  if (peer.status !== 'awaiting-C' && peer.status !== 'paired') {
    fail('not-paired', `Cannot install artifact C for ${peer.handle}: pairing is not awaiting C or already paired.`);
  }
  if (art.from.courier !== peer.courierDid || art.spaceId !== peer.spaceId || art.from.owner !== peer.ownerDid) {
    fail('bad-artifact', `Artifact C does not match the pairing with ${peer.handle}.`);
  }
  if (!peer.theirHandleForMe || art.peer !== peer.theirHandleForMe) {
    fail('bad-artifact', `Artifact C changes the established mailbox scope for ${peer.handle}.`);
  }
  const incoming = await validatePeerDelegation(node, profile, peer, art.delegation!);
  if (peer.status === 'paired') {
    const currentExpiry = Date.parse(peer.inbound?.expiresAt ?? '');
    if (!Number.isFinite(currentExpiry) || Date.parse(incoming.expiresAt) <= currentExpiry) {
      fail('stale-artifact', `Artifact C does not extend the current inbound delegation for ${peer.handle}.`);
    }
  }
  peer.inbound = { delegation: serializeDelegation(incoming.delegation), cid: incoming.cid, expiresAt: incoming.expiresAt };
  peer.status = 'paired';
  saveProfile(profile);
  await writePeerRecord(node, peer);
  printJson({ ok: true, paired: peer.handle, peerDid: peer.courierDid, peerSpace: peer.spaceId, delegationExpiresAt: peer.inbound.expiresAt });
}

/**
 * Saves after `delegateTo` made a delegation that is live from that moment. A save that refuses (the pairing completed, or the peer was
 * revoked, meanwhile) leaves a delegation no profile records: say so, with its CID and where the owner can revoke it, and never publish it.
 */
function saveAfterDelegation(profile: Profile, delegation: PortableDelegation): void {
  try {
    saveProfile(profile);
  } catch (error) {
    console.error(`warning: the delegation ${delegationCid(delegation)} created for this pairing is live and was not saved. Nothing was published. The owner can revoke it at ${REVOKE_URL}.`);
    throw error;
  }
}

function recordOutbound(peer: StoredPeer, delegation: PortableDelegation): void {
  const expiresAt = delegation.expiry instanceof Date ? delegation.expiry.toISOString() : new Date(delegation.expiry).toISOString();
  peer.outbound.push({ cid: delegationCid(delegation), issuedAt: new Date().toISOString(), expiresAt });
}

async function pairRenew(args: ParsedArgs) {
  const active = await ctx();
  const requested = args.positional[1];
  if (args.has('renew-artifact') && !requested) {
    fail('usage', `Usage: ${cmd('pair renew <peer> --renew-artifact [--force]')}`);
  }
  const peers = requested ? [getPeer(active.profile, requested)] : Object.values(active.profile.peers).filter((peer) => peer.status === 'paired');
  if (args.has('renew-artifact')) {
    const peer = peers[0]!;
    if (peer.status !== 'paired') fail('not-paired', `Cannot renew ${peer.handle}: pairing is not complete.`);
    if (!peer.theirHandleForMe) fail('not-paired', `Peer ${peer.handle} is missing its paired mailbox handle.`);
    const delegation = await renewOutbound(active, peer, args.has('force'));
    if (!delegation) fail('renew-throttled', `Outbound delegation for ${peer.handle} was renewed within the last 20 hours; use --force to renew it now.`);
    printJson(artifactWithDelegation('C', active.profile, delegation, peer.handle, peer.theirHandleForMe));
    return;
  }
  for (const peer of peers) {
    if (peer.status !== 'paired') fail('not-paired', `Cannot renew ${peer.handle}: pairing is not complete.`);
    await renewOutbound(active, peer, args.has('force'));
    await installInbound(active, peer);
  }
  printJson({ ok: true, renewed: peers.map((peer) => peer.handle) });
}

async function renewOutbound(active: Ctx, peer: StoredPeer, force: boolean): Promise<PortableDelegation | undefined> {
  return withProfileTransaction(async (profile, save) => {
    const current = getPeer(profile, peer.handle);
    if (current.courierDid !== peer.courierDid || profile.courierDid !== active.profile.courierDid) {
      fail('profile-changed', 'Pairing changed while renewal was starting; run the command again.');
    }
    return issueOutbound({ profile, node: await courierNode(profile) }, current, force, save);
  });
}

async function issueOutbound(active: Ctx, peer: StoredPeer, force: boolean, save: () => void): Promise<PortableDelegation | undefined> {
  const last = peer.outbound.at(-1);
  if (!force && last && Date.now() - Date.parse(last.issuedAt) < 20 * 3600 * 1000) return undefined;
  const { profile, node } = active;
  const result = await node.delegateTo(peer.courierDid, peerReadPermissions(peer.handle, profile.spaceId!, peer.sessionId), { expiry: PEER_DELEGATION_EXPIRY });
  const issuedAt = new Date().toISOString();
  const serialized = serializeDelegation(result.delegation);
  const existing = await getJson(node.kv, k.peerDelegation(peer.handle, peer.sessionId));
  const body = { v: 0, delegation: serialized, issuedAt };
  if (existing?.etag) await putMatch(node.kv, k.peerDelegation(peer.handle, peer.sessionId), body, existing.etag);
  else await putCreate(node.kv, k.peerDelegation(peer.handle, peer.sessionId), body);
  peer.outbound.push({
    cid: delegationCid(result.delegation),
    issuedAt,
    expiresAt: result.delegation.expiry instanceof Date ? result.delegation.expiry.toISOString() : new Date(result.delegation.expiry).toISOString(),
  });
  save();
  return result.delegation;
}

async function installInbound(active: Ctx, peer: StoredPeer): Promise<void> {
  if (!peer.inbound || !peer.theirHandleForMe) return;
  const kv = await peerKv(active.node, active.profile, peer);
  const update = await getJson<{ v: number; delegation: string }>(kv, k.peerDelegation(peer.theirHandleForMe, peer.sessionId));
  if (!update?.value.delegation) return;
  const incoming = await validatePeerDelegation(active.node, active.profile, peer, update.value.delegation);
  if (Date.parse(incoming.expiresAt) <= Date.parse(peer.inbound.expiresAt)) return;
  peer.inbound = { delegation: serializeDelegation(incoming.delegation), cid: incoming.cid, expiresAt: incoming.expiresAt };
  saveProfile(active.profile);
}

function findPendingPeer(profile: Profile, handle: string): StoredPeer {
  const p = profile.peers[handle];
  if (p && p.status === 'pending-A') return p;
  const pending = Object.values(profile.peers).filter((x) => x.status === 'pending-A');
  if (pending.length === 1) return pending[0];
  fail('unknown-peer', `No pending pairing started with \`${cmd('pair start')}\` (looked for "${handle}").`);
}

function findPeerByCourier(profile: Profile, courierDid: string): StoredPeer | undefined {
  return Object.values(profile.peers).find((x) => x.courierDid === courierDid);
}

function delegationCid(d: PortableDelegation): string {
  return String(d.cid ?? '');
}


async function writePeerRecord(node: TinyCloudNode, peer: StoredPeer) {
  // Best-effort publication of pairing state in-space (spec §4); the profile
  // remains authoritative for the CLI.
  const kv = node.kv;
  try {
    await putCreate(kv, k.peerRecord(peer.handle), peerRecordBody(peer));
  } catch (e) {
    const info = errInfo(e);
    if (info.code === 'conflict') {
      const cur = await getJson(kv, k.peerRecord(peer.handle));
      if (cur?.etag) await putMatch(kv, k.peerRecord(peer.handle), peerRecordBody(peer), cur.etag);
      else console.error(`warning: could not update me/peers/${peer.handle}.json`);
    } else {
      console.error(`warning: could not write me/peers/${peer.handle}.json: ${info.message}`);
    }
  }
}

// ---------- revoke ----------

export async function cmdRevoke(args: ParsedArgs) {
  const handle = args.positional[0] ?? fail('usage', `Usage: ${cmd('revoke <peer>')}`);
  await withProfileTransaction(async (profile, save) => {
    const peer = profile.peers[handle] ?? fail('unknown-peer', `No pairing with ${handle}. If you already revoked it, there's nothing left to do.`);
    const node = await courierNode(profile);
    await revokePeer(node, profile, handle, save);
    delete profile.peers[handle];
    save();
    try { await del(node.kv, k.peerRecord(handle)); } catch { /* non-fatal */ }
    console.log(`Revoked ${handle} (${peer.courierDid}).`);
  });
}

// ---------- send ----------

export type SendInput = {
  which: 'new' | 'thread';
  threadId: string;
  subject?: string;
  text: string;
  intent: Intent;
  asks: { id: string; title: string }[];
  constraints: string[];
  inReplyTo: string | null;
  referenceTaskIds: string[];
};

/** Writes one outbound message (and thread meta for a new thread) to the peer's mirror. Shared by `courier send` and the outbox. */
export async function sendMessage(node: TinyCloudNode, profile: Profile, peerHandle: string, peer: StoredPeer, input: SendInput): Promise<CourierMessage> {
  const { which, threadId, subject, text, intent, asks, constraints, inReplyTo, referenceTaskIds } = input;
  const from = { owner: profile.ownerDid!, agent: profile.courierDid, label: profile.label };
  if (peer.sessionId && (input.which === 'new' || threadId !== peer.sessionId)) {
    fail('session-mismatch', 'This pairing permits only its invited session. Start or select another session explicitly.');
  }
  const startedByMe = which === 'new' || Boolean(await getJson(node.kv, k.threadMeta(peerHandle, threadId)));
  let refsOwnTask = false;
  let refsAnyTask = false;
  for (const taskId of referenceTaskIds) {
    if (await getJson(node.kv, k.task(peerHandle, threadId, taskId))) {
      refsOwnTask = true;
      refsAnyTask = true;
      continue;
    }
    if (peer.inbound && peer.theirHandleForMe) {
      const peerSpace = await peerKv(node, profile, peer);
      const key = `${PREFIX}/to/${peer.theirHandleForMe}/threads/${threadId}/task/${taskId}.json`;
      if (await getJson(peerSpace, key)) refsAnyTask = true;
    }
  }
  const msg = buildMessage({
    threadId, text, from, intent, asks, constraints, inReplyTo, referenceTaskIds,
    role: messageRole({ startedByMe, refsOwnTask, refsAnyTask }),
  });
  if (which === 'new') {
    const meta: ThreadMeta = {
      threadId, subject: subject ?? '(no subject)',
      startedBy: { owner: profile.ownerDid!, courier: profile.courierDid, label: profile.label },
      createdAt: new Date().toISOString(),
    };
    await putCreate(node.kv, k.threadMeta(peerHandle, threadId), meta);
  }
  await putCreate(node.kv, k.msg(peerHandle, threadId, msg.messageId), msg);
  return msg;
}

export async function cmdSend(args: ParsedArgs) {
  const { profile, node } = await ctx();
  const peerHandle = args.positional[0] ?? fail('usage', sendUsage());
  const peer = getPeer(profile, peerHandle);
  const which = oneOf(args, ['new', 'thread']);
  const threadId = which === 'new' ? ulid() : which === 'thread' ? requireFlag(args, 'thread', sendUsage()) : fail('usage', sendUsage());
  const subject = args.get('new');
  const intentRaw = args.get('intent') ?? 'request';
  if (!INTENTS.includes(intentRaw as Intent)) fail('usage', `--intent must be one of: ${INTENTS.join(', ')}`);
  const text = readTextArg(args, '--text or --file is required (or pipe the body on stdin)');
  if (text.length > 256 * 1024) fail('too-large', 'Message body exceeds the 256 KB inline limit (§4) — put it under files/ instead.');
  const msg = await sendMessage(node, profile, peerHandle, peer, {
    which: which === 'new' ? 'new' : 'thread', threadId, subject, text, intent: intentRaw as Intent,
    asks: args.all('ask').map((title, i) => ({ id: `a${i + 1}`, title })),
    constraints: args.all('constraint'),
    inReplyTo: args.get('reply-to') ?? null,
    referenceTaskIds: args.all('task-ref'),
  });
  printJson({ ok: true, threadId, messageId: msg.messageId, peer: peerHandle, intent: intentRaw, role: msg.role });
}

const sendUsage = () => `Usage: ${cmd('send <peer> (--new <subject> | --thread <id>) [--text t | --file f | stdin] [--intent i] [--ask "…"]… [--reply-to id]')}`;

export function readTextArg(args: ParsedArgs, usage: string): string {
  const t = args.get('text');
  if (t !== undefined && t !== 'true') return t;
  const file = args.get('file');
  if (file) return fs.readFileSync(file, 'utf8');
  if (args.has('stdin')) return fs.readFileSync(0, 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  fail('usage', usage);
}

// ---------- inbox ----------

export async function cmdInbox(args: ParsedArgs) {
  const { profile, node } = await ctx();
  const collection = await collectInbound({
    selfKv: node.kv,
    peers: Object.values(profile.peers),
    kvFor: (peer) => peerKv(node, profile, peer),
  });
  const output = {
    notice: COUNTERPARTY_NOTICE,
    notifications: recentNotices(profileDir()),
    items: collection.items.map((item) => ({ authority: 'counterparty', ...item })),
    errors: collection.errors,
  };
  const status = output.notifications.length ? `\nRecent notifications (delivery receipts may already be current):\n${output.notifications.map(n => `${n.title}: ${n.body}`).join('\n')}\n` : '';
  await writeOut(args.has('json') ? JSON.stringify(output, null, 2) + '\n' : renderInboxText(collection.items) + status);
  for (const error of collection.errors) console.error(`warning: inbox ${error.peer}: ${error.message}`);
  if (!args.has('peek')) await commitReceipts(node.kv, collection.pending);
}

// ---------- read ----------

export interface ThreadEntry {
  kind: 'meta' | 'msg' | 'task';
  id: string;
  side: 'me' | 'peer';
  authority: 'self' | 'counterparty';
  body: unknown;
  invalid?: string[];
}

export async function cmdRead(args: ParsedArgs) {
  const { profile, node } = await ctx();
  const threadId = args.positional[0] ?? fail('usage', `Usage: ${cmd('read <threadId> [--peer p] [--json]')}`);
  const entries: ThreadEntry[] = [];
  const peersToScan = args.get('peer')
    ? [getPeer(profile, args.get('peer')!)]
    : Object.values(profile.peers).filter((peer) => peer.status === 'paired' || peer.status === 'awaiting-C');

  for (const peer of peersToScan) {
    const mine = await listAll(node.kv, `${k.threadRoot(peer.handle, threadId)}/`);
    for (const key of mine) {
      const got = await getJson(node.kv, key);
      if (!got) continue;
      if (key.endsWith('/meta.json')) entries.push({ kind: 'meta', id: threadId, side: 'me', authority: 'self', body: got.value });
      else if (/\/msg\/[^/]+\.json$/.test(key)) {
        const invalid = messageView(got.value).invalid;
        entries.push({ kind: 'msg', id: msgIdFromKey(key), side: 'me', authority: 'self', body: got.value, ...(invalid.length ? { invalid } : {}) });
      } else if (/\/task\/[^/]+\.json$/.test(key)) {
        const invalid = taskView(got.value).invalid;
        entries.push({ kind: 'task', id: taskIdFromKey(key), side: 'me', authority: 'self', body: got.value, ...(invalid.length ? { invalid } : {}) });
      }
    }
    if (peer.inbound && peer.theirHandleForMe) {
      const peerSpace = await peerKv(node, profile, peer);
      const theirs = await listAll(peerSpace, `${PREFIX}/to/${peer.theirHandleForMe}/threads/${threadId}/`);
      for (const key of theirs) {
        const got = await getJson(peerSpace, key);
        if (!got) continue;
        if (key.endsWith('/meta.json')) entries.push({ kind: 'meta', id: threadId, side: 'peer', authority: 'counterparty', body: got.value });
        else if (/\/msg\/[^/]+\.json$/.test(key)) {
          const invalid = messageView(got.value).invalid;
          entries.push({ kind: 'msg', id: msgIdFromKey(key), side: 'peer', authority: 'counterparty', body: got.value, ...(invalid.length ? { invalid } : {}) });
        } else if (/\/task\/[^/]+\.json$/.test(key)) {
          const invalid = taskView(got.value).invalid;
          entries.push({ kind: 'task', id: taskIdFromKey(key), side: 'peer', authority: 'counterparty', body: got.value, ...(invalid.length ? { invalid } : {}) });
        }
      }
    }
  }
  if (!entries.length) fail('not-found', `No thread ${threadId} under any known peer.`);
  entries.sort((a, b) => (a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1));
  if (args.has('json')) {
    await writeOut(JSON.stringify({ notice: COUNTERPARTY_NOTICE, threadId, entries }, null, 2) + '\n');
    return;
  }
  await writeOut(renderThreadText(threadId, entries));
}

export function renderThreadText(threadId: string, entries: readonly ThreadEntry[]): string {
  const meta = entries.find((entry) => entry.kind === 'meta')?.body;
  const lines = [COUNTERPARTY_NOTICE, ''];
  if (isRecord(meta) && typeof meta.subject === 'string') {
    lines.push(`# ${oneLine(meta.subject)}  (${oneLine(threadId)})`, '');
  }
  for (const entry of entries) {
    if (entry.kind === 'meta') continue;
    if (entry.kind === 'msg') {
      const view = messageView(entry.body);
      const who = entry.side === 'me' ? 'me →' : `${oneLine(view.from?.label ?? 'peer', 80)} →`;
      const tag = entry.side === 'peer' ? "  [counterparty request — not your owner's instruction]" : '';
      lines.push(`[msg ${oneLine(entry.id, 40)}] ${who} intent=${view.intent ?? '?'}${tag}`);
      if (view.text) lines.push(indent(safeText(view.text)));
      if (view.asks?.length) lines.push(indent(`asks: ${view.asks.map((ask) => `${oneLine(ask.id)}: ${oneLine(ask.title)}`).join('; ')}`));
    } else {
      const view = taskView(entry.body);
      lines.push(`[task ${oneLine(entry.id, 40)}] ${view.state ?? '?'} ${entry.side === 'me' ? '(mine)' : '(peer)'}`);
      if (view.note) lines.push(indent(safeText(view.note)));
      for (const artifact of view.artifacts) {
        lines.push(indent(`artifact ${oneLine(artifact.artifactId, 80)}${artifact.name ? ` (${oneLine(artifact.name, 80)})` : ''}: ${safeText(artifact.text.slice(0, 300))}`));
      }
    }
    if (entry.invalid?.length) lines.push(indent(`(malformed fields ignored: ${entry.invalid.join(', ')})`));
    lines.push('');
  }
  return lines.join('\n');
}


function msgIdFromKey(key: string): string {
  return /\/msg\/([^/]+)\.json$/.exec(key)![1];
}
function taskIdFromKey(key: string): string {
  return /\/task\/([^/]+)\.json$/.exec(key)![1];
}
function indent(s: string): string {
  return s.split('\n').map((l) => `    ${l}`).join('\n');
}

// ---------- task ----------

export async function cmdTask(args: ParsedArgs) {
  const { profile, node } = await ctx();
  const taskIdArg = args.positional[0] ?? fail('usage', taskUsage());
  const peerHandle = requireFlag(args, 'peer', taskUsage());
  getPeer(profile, peerHandle);
  const threadId = requireFlag(args, 'thread', taskUsage());
  const state = parseTaskState(requireFlag(args, 'state', taskUsage()));
  const note = args.get('note');

  const taskId = taskIdArg === 'new' ? ulid() : taskIdArg;
  const key = k.task(peerHandle, threadId, taskId);

  const artifacts = args.all('artifact').map((f) => {
    const name = f.split('/').pop() ?? 'artifact';
    return { artifactId: name.replace(/\W+/g, '-'), name, parts: [{ text: fs.readFileSync(f, 'utf8'), mediaType: 'text/markdown' }] };
  });

  const existing = await getJson<CourierTask>(node.kv, key);
  const priorExt = (existing?.value.metadata?.[EXT] ?? {}) as Record<string, unknown>;
  const task = buildTask({
    threadId, taskId, state, note,
    artifacts: artifacts.length ? [...(existing?.value.artifacts ?? []), ...artifacts] : existing?.value.artifacts,
    ask: args.get('ask') ?? (typeof priorExt.ask === 'string' ? priorExt.ask : undefined),
    requestMessageId: args.get('request-message') ?? (typeof priorExt.requestMessageId === 'string' ? priorExt.requestMessageId : undefined),
    role: 'ROLE_AGENT',
  });
  // Preserve immutable provenance fields on update.
  if (existing) {
    task.id = existing.value.id;
    task.contextId = existing.value.contextId;
    task.metadata[EXT] = { ...priorExt, ...task.metadata[EXT] };
    await putMatch(node.kv, key, task, existing.etag ?? fail('conflict', `task ${taskId} exists without an etag`));
  } else {
    await putCreate(node.kv, key, task);
  }
  printJson({ ok: true, taskId, threadId, state, updated: Boolean(existing) });
}

const taskUsage = () => `Usage: ${cmd('task <taskId|new> --peer <p> --thread <id> --state <s> [--note …] [--artifact f]… [--ask a1]')}`;

// ---------- request ----------

export async function cmdRequest(args: ParsedArgs) {
  const threadId = args.positional[0] ?? fail('usage', requestUsage());
  const taskId = requireFlag(args, 'task', requestUsage());
  const why = requireFlag(args, 'why', requestUsage());
  const peerHandle = requireFlag(args, 'peer', requestUsage());
  const flag = (name: string) => (args.get(name) === 'true' ? undefined : args.get(name));
  const pinFlag = (name: string) => args.has(name) ? requireFlag(args, name, requestUsage()) : undefined;
  requestIds({ threadId, taskId });
  const fields = requestFields({ verb: flag('verb'), target: flag('target'), summary: flag('summary'), headSha: pinFlag('head-sha'), base: pinFlag('base') });
  const { profile, node } = await ctx();
  getPeer(profile, peerHandle);
  const risk = args.get('risk');
  const id = ulid();
  const request = {
    id, peer: peerHandle, threadId, taskId, ...fields,
    // Free text for the owner to read; nothing matches against it (the structured fields above do that).
    ...requestText({ action: flag('action'), reason: why, risk }, fields.summary),
    requestedBy: { owner: profile.ownerDid!, agent: profile.courierDid },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    status: 'pending',
  };
  const hash = requestHash(request); // refuses (throws) a request that could never be hashed or approved, before anything is written
  const problem = requestShapeProblem(request);
  if (problem) fail('usage', `The request is malformed: ${problem}.`);
  // The task comes first: the view names <peer> on the card only if `to/<peer>/threads/<thread>/task/<task>.json`
  // exists in this space, so the request is not written unless that file does (created here if the agent has not yet).
  const taskKey = k.task(peerHandle, threadId, taskId);
  const existing = await getJson<CourierTask>(node.kv, taskKey);
  const task = authRequiredTask(existing?.value, threadId, taskId);
  if (existing?.etag) await putMatch(node.kv, taskKey, task, existing.etag);
  else await putCreate(node.kv, taskKey, task);
  if (!(await getJson<CourierTask>(node.kv, taskKey))) fail('task-missing', `The task ${taskId} is not in ${taskKey}; no request was written.`);
  await putCreate(node.kv, k.request(id), request);
  // `requestHash` is what the view's card shows as its fingerprint (first 8 hex digits) and `courier approval` prints in full.
  printJson({ ok: true, requestId: id, requestHash: hash, taskId, state: 'TASK_STATE_AUTH_REQUIRED' });
}

const requestUsage = () =>
  `Usage: ${cmd('request <threadId> --peer <p> --task <id> --verb merge|deploy|publish|spend|other --target <what> --summary "…" --why "…" [--risk "…"] [--action "…"]')}\n${targetHelp()}\nMerge requires --head-sha <40 lowercase hex> and --base <branch> (refused for other verbs).\nRead the PR at request time: gh pr view N --repo owner/repo --json headRefOid,baseRefName\nPass headRefOid as --head-sha and baseRefName as --base; branch case is preserved.\nMerge requests include headSha and base in the approval hash.`;

/** `courier request --help`: the usage line and every target form. */
export const requestHelp = () => `${requestUsage()}\n`;

// ---------- orders ----------

export async function cmdOrders(args: ParsedArgs) {
  const { profile, node } = await ctx();
  const handle = args.positional[0] ?? fail('usage', `Usage: ${cmd('orders <peer>')}`);
  getPeer(profile, handle);
  const got = await getJson<string>(node.kv, k.orders(handle));
  const body = typeof got?.value === 'string' ? got.value : undefined;
  if (args.has('json')) {
    printJson({ peer: handle, orders: body ?? DEFAULT_ORDERS, source: body ? 'space' : 'default' });
    return;
  }
  console.log(body ?? `# No me/orders/${handle}.md in your space — v0 defaults apply:\n\n${DEFAULT_ORDERS}`);
}
