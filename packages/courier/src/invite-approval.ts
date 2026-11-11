import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { TinyCloudNode } from '@tinycloud/node-sdk';
import type { ShareInvitationApprovalContext } from '@tinycloud/share-envelope/links';
import { assertInvitationApprovalGrant, siweTimes } from './authority.js';
import { CourierError } from './errors.js';
import { nodeOpts } from './node.js';
import { mkdirOwnerOnly, profileDir, writeSecure } from './profile.js';
import type { AgentKey, Profile } from './profile.js';
import type { GrantPayload } from './grant.js';

const DAY_MS = 86_400_000;

/**
 * One invitation's approval, written BEFORE the approval request exists so a crash or a second run finds the same
 * invitation id, recipient and expiries instead of minting new ones. The share key id is NOT here: the approver chooses
 * it and returns it in the signed result.
 */
export interface PendingInvite {
  v: 1;
  invitationId: string;
  recipient: string;
  sessionId: string;
  subjectName: string;
  courierDid: string;
  ownerDid: string;
  createdAt: string;
  /** The approval must be given by this time; the invitation itself expires then (at most 24 hours). */
  acceptanceExpiresAt: string;
  accessExpiresAt: string;
  status: 'awaiting' | 'closed' | 'sent';
  approvalUrl?: string;
  /** Opaque transport state (request id, body digest, result key). */
  transport?: Record<string, unknown>;
}

/** The approver's side of the exchange; OpenKey in production, a local double in tests. */
export interface InviteApprovalTransport {
  create(input: { context: ShareInvitationApprovalContext; key: AgentKey; host: string }): Promise<{ approvalUrl: string; transport: Record<string, unknown> }>;
  poll(pending: PendingInvite, key: AgentKey): Promise<{ status: 'pending' } | { status: 'denied' | 'expired' } | { status: 'approved'; payload: GrantPayload }>;
  /** Tell the approver the stored result was committed. Optional; called only after the grant is saved. */
  acknowledge?(pending: PendingInvite, key: AgentKey): Promise<void>;
}

/** A stored per-invite grant: one invitation's key, kept apart from the main Courier grant. */
export interface InviteGrant {
  v: 1;
  invitationId: string;
  shareId: string;
  payload: GrantPayload;
  expiresAt: string;
  receivedAt: string;
}

const pendingDir = (home = profileDir()) => path.join(home, 'pending-invites');
const grantDir = (home = profileDir()) => path.join(home, 'invite-grants');
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CourierError('bad-profile', `Invalid ${path.basename(file)}: ${(error as Error).message}`);
  }
}

function secureWrite(dir: string, id: string, value: unknown): void {
  mkdirOwnerOnly(dir);
  writeSecure(path.join(dir, `${id}.json`), value);
}

export function loadPendingInvite(invitationId: string, home = profileDir()): PendingInvite | undefined {
  if (!ULID.test(invitationId)) return undefined;
  return readJson<PendingInvite>(path.join(pendingDir(home), `${invitationId}.json`));
}

export function savePendingInvite(pending: PendingInvite): void {
  secureWrite(pendingDir(), pending.invitationId, pending);
}

export function loadInviteGrant(invitationId: string, home = profileDir()): InviteGrant | undefined {
  if (!ULID.test(invitationId)) return undefined;
  return readJson<InviteGrant>(path.join(grantDir(home), `${invitationId}.json`));
}

/** The open (not closed, not sent, not yet expired) pending approval for this exact session and recipient, if any. */
export function findPendingInvite(profile: Profile, sessionId: string, recipient: string, now: number, home = profileDir()): PendingInvite | undefined {
  let names: string[];
  try { names = fs.readdirSync(pendingDir(home)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const name of names.filter((value) => value.endsWith('.json')).sort()) {
    const pending = readJson<PendingInvite>(path.join(pendingDir(home), name));
    if (pending?.status === 'awaiting' && pending.sessionId === sessionId && pending.recipient === recipient && pending.courierDid === profile.courierDid
      && pending.ownerDid === profile.ownerDid && Date.parse(pending.acceptanceExpiresAt) > now) return pending;
  }
  return undefined;
}

/** A new pending invitation: fresh id, expiry at most 24 hours out and never past the main grant. */
export function newPendingInvite(profile: Profile, input: { sessionId: string; subjectName: string; recipient: string }, now: number): PendingInvite {
  if (!profile.ownerDid || !profile.grantExpiresAt) throw new CourierError('no-grant', 'No owner grant is installed.');
  const expires = new Date(Math.floor(Math.min(now + DAY_MS, Date.parse(profile.grantExpiresAt)) / 1000) * 1000);
  if (expires.getTime() - now < 60_000) throw new CourierError('grant-expired', 'The Courier grant ends too soon to send an invitation.');
  return {
    v: 1, invitationId: ulid(now), recipient: input.recipient, sessionId: input.sessionId, subjectName: input.subjectName,
    courierDid: profile.courierDid, ownerDid: profile.ownerDid, createdAt: new Date(now).toISOString(),
    acceptanceExpiresAt: expires.toISOString(), accessExpiresAt: expires.toISOString(), status: 'awaiting',
  };
}

export function invitationContext(pending: PendingInvite): ShareInvitationApprovalContext {
  return {
    kind: 'share-invitation', version: 1, invitationId: pending.invitationId, recipientEmail: pending.recipient,
    subjectKind: 'session', subjectName: pending.subjectName,
    acceptanceExpiresAt: pending.acceptanceExpiresAt, accessExpiresAt: pending.accessExpiresAt,
  };
}

/** A share key id belongs to exactly one invitation, so a stored approval is never reusable for a second one. */
function keyIdUsedElsewhere(shareId: string, invitationId: string): boolean {
  let names: string[];
  try { names = fs.readdirSync(grantDir()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return names.filter((name) => name.endsWith('.json') && name !== `${invitationId}.json`)
    .some((name) => readJson<InviteGrant>(path.join(grantDir(), name))?.shareId === shareId);
}

/** Restore the per-invite node and re-verify the signed grant: holder, owner, one key pair, expiry. Returns the node and key id. */
async function restoreInviteGrant(profile: Profile, key: AgentKey, pending: PendingInvite, payload: GrantPayload, now: number): Promise<{ node: TinyCloudNode; shareId: string; expiresAt: Date }> {
  const times = siweTimes(payload.siwe);
  if (!times.expiresAt || times.expiresAt.getTime() <= now) throw new CourierError('grant-expired', 'The invitation approval has expired.');
  const node = new TinyCloudNode(nodeOpts(profile.host));
  try {
    await node.restoreSession({
      delegationHeader: payload.delegationHeader, delegationCid: payload.delegationCid, spaceId: payload.spaceId, jwk: key.jwk,
      verificationMethod: payload.verificationMethod, address: payload.address, chainId: payload.chainId, siwe: payload.siwe,
      signature: payload.signature, expiresAt: times.expiresAt.toISOString(), tinycloudHosts: [profile.host],
    });
  } catch { throw new CourierError('bad-grant', 'The invitation approval could not be verified for this Courier key.'); }
  if (node.credentialHolderDid !== profile.courierDid || pending.courierDid !== profile.courierDid) {
    throw new CourierError('bad-grant', 'The invitation approval was not issued to this Courier key.');
  }
  const owner = `did:pkh:eip155:${payload.chainId}:${payload.address}`;
  if (!profile.ownerDid || owner.toLowerCase() !== profile.ownerDid.toLowerCase() || owner.toLowerCase() !== pending.ownerDid.toLowerCase()) {
    throw new CourierError('bad-grant', 'The invitation approval was given by a different account than the Courier owner.');
  }
  const shareId = assertInvitationApprovalGrant(node.getVerifiedSessionCapabilities(), times, { ownerDid: owner, acceptanceExpiresAt: new Date(pending.acceptanceExpiresAt), now });
  return { node, shareId, expiresAt: times.expiresAt };
}

export async function verifyStoredInviteGrant(profile: Profile, key: AgentKey, pending: PendingInvite, grant: InviteGrant, now: number): Promise<TinyCloudNode> {
  if (grant.invitationId !== pending.invitationId) throw new CourierError('bad-grant', 'This approval belongs to another invitation.');
  const restored = await restoreInviteGrant(profile, key, pending, grant.payload, now);
  if (restored.shareId !== grant.shareId) throw new CourierError('bad-grant', 'The stored approval no longer matches its key.');
  return restored.node;
}

export interface ObtainOptions {
  profile: Profile;
  key: AgentKey;
  transport: InviteApprovalTransport;
  pending: PendingInvite;
  /** How long to keep checking for the approval in this run; 0 checks once. */
  waitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onApprovalUrl?: (url: string, pending: PendingInvite) => void;
}

export type ObtainResult = { status: 'approved'; shareId: string; node: TinyCloudNode } | { status: 'awaiting'; approvalUrl: string };

/**
 * Create (once) and await this invitation's approval, then keep the approved per-invite grant. Nothing the caller does
 * after this - relay delegation, state, Share key, link or email - happens unless the result is `approved`.
 */
export async function obtainInviteKey(options: ObtainOptions): Promise<ObtainResult> {
  const { profile, key, transport, pending } = options;
  const clock = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stored = loadInviteGrant(pending.invitationId);
  if (stored) {
    const node = await verifyStoredInviteGrant(profile, key, pending, stored, clock());
    return { status: 'approved', shareId: stored.shareId, node };
  }
  if (Date.parse(pending.acceptanceExpiresAt) <= clock()) {
    pending.status = 'closed';
    savePendingInvite(pending);
    throw new CourierError('invite-expired', 'The approval for this invitation was not given in time; nothing was created.');
  }
  if (pending.transport === undefined) {
    const created = await transport.create({ context: invitationContext(pending), key, host: profile.host });
    pending.approvalUrl = created.approvalUrl;
    pending.transport = created.transport;
    savePendingInvite(pending);
  }
  options.onApprovalUrl?.(pending.approvalUrl!, pending);
  const deadline = clock() + options.waitMs;
  for (;;) {
    const result = await transport.poll(pending, key);
    savePendingInvite(pending);
    if (result.status === 'approved') {
      const restored = await restoreInviteGrant(profile, key, pending, result.payload, clock());
      if (keyIdUsedElsewhere(restored.shareId, pending.invitationId)) {
        throw new CourierError('bad-grant', 'This approval was already used for another invitation; each invitation needs its own approval.');
      }
      secureWrite(grantDir(), pending.invitationId, {
        v: 1, invitationId: pending.invitationId, shareId: restored.shareId, payload: result.payload,
        expiresAt: restored.expiresAt.toISOString(), receivedAt: new Date(clock()).toISOString(),
      } satisfies InviteGrant);
      await transport.acknowledge?.(pending, key);
      return { status: 'approved', shareId: restored.shareId, node: restored.node };
    }
    if (result.status === 'denied' || result.status === 'expired') {
      pending.status = 'closed';
      savePendingInvite(pending);
      throw new CourierError('invite-approval-refused', result.status === 'denied' ? 'The owner declined this invitation; nothing was created.' : 'The approval request expired before it was given; nothing was created.');
    }
    if (clock() >= deadline) return { status: 'awaiting', approvalUrl: pending.approvalUrl! };
    await sleep(Math.min(2000, Math.max(0, deadline - clock())));
  }
}

export function markInviteSent(pending: PendingInvite): void {
  pending.status = 'sent';
  savePendingInvite(pending);
}

/**
 * Exactly one run may go on to create the relay, the Share key, the link and the email for an approved invitation:
 * the marker is created exclusively and never removed. A run that finds it refuses, so a rerun or a concurrent run can
 * never send a second email for the same approval; a new invitation needs a new approval.
 */
export function claimInviteSend(pending: PendingInvite): void {
  mkdirOwnerOnly(pendingDir());
  try {
    fs.closeSync(fs.openSync(path.join(pendingDir(), `${pending.invitationId}.sending`), 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CourierError('invite-in-progress', 'This invitation was already sent or an earlier attempt did not finish; nothing more was sent. Start a new invitation (a new owner approval) to invite again.');
    }
    throw error;
  }
}
