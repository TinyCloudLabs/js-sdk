import { randomBytes } from 'node:crypto';
import { decodeTime, ulid } from 'ulid';
import { DelegatedAccess, NodeWasmBindings, deserializeDelegation, type TinyCloudNode } from '@tinycloud/node-sdk';
import { isRecord, messageView } from './a2a.js';
import { assertAgentGrant, siweTimes } from './authority.js';
import { requestHash } from './canonical.js';
import { CourierError } from './errors.js';
import { commitReceipts, selectUndelivered, type PendingDelivery, type Receipts } from './inbox.js';
import { COURIER_SPACE, PREFIX, agentId, k } from './keys.js';
import { assertInboundLive } from './node.js';
import { artifactWithDelegation, parseArtifact, validateArtifactIdentity, type PairArtifact } from './pairing.js';
import { assertPairCompletion, assertSignedPairCompletion, inboundGrant, issuePairDelegation, pendingFromA, recordOutbound, verifyPairDelegation } from './pairing-flow.js';
import type { StoredPeer } from './profile.js';
import { HANDLE, ULID } from './request.js';
import { issuedPeerGrants, liveMailboxGrants, revokePeerGrants } from './revoke.js';
import { publishMessage } from './send.js';
import { deleteAll, getJson, getJsonMany, listAll, putCreate } from './store.js';

export interface CourierTenantScope { readonly ownerDid: string; readonly courierDid: string; readonly spaceId: string; readonly host: string }

/** Opaque, serializable SDK state. Persist the entire record in the tenant's private store, never in a public mailbox. */
export interface CourierPeerRecord {
  readonly version: 1;
  readonly scope: CourierTenantScope;
  readonly pairingId: string;
  phase: 'pending' | 'paired' | 'revoking';
  artifactB?: PairArtifact;
  peer: StoredPeer;
}

export interface CourierPeerTransaction {
  get(handle: string): Promise<CourierPeerRecord | undefined>;
  /** Durable when resolved, even when the rest of the operation throws. Undefined deletes the record. */
  save(handle: string, record: CourierPeerRecord | undefined): Promise<void>;
}

export interface CourierPeerStore {
  /** Serialize all operations in this owner scope, including across processes if the caller runs more than one. */
  transaction<T>(scope: CourierTenantScope, operation: (tx: CourierPeerTransaction) => Promise<T>): Promise<T>;
}

export interface HeadlessCourierContext {
  readonly ownerDid: string;
  readonly courierDid: string;
  readonly label?: string;
  readonly host: string;
  /** An exclusively owned Node session restored and verified from this identity and finite Courier grant. */
  readonly node: TinyCloudNode;
  /** A new Node restored with the same grant and identity, with no runtime delegations installed. */
  createReader(): Promise<TinyCloudNode>;
  /** Optional transport for exact-peer invocations. Requests are pinned to host and cannot redirect. */
  readonly fetch?: typeof fetch;
  readonly store: CourierPeerStore;
}

export interface CourierPeerRef { readonly handle: string; readonly peerDid: string; readonly pairingId: string }
export interface CourierPairPending extends CourierPeerRef { readonly artifactB: string; readonly createdAt: number; readonly expiresAt: number }
export interface CourierPairedPeer extends CourierPeerRef { readonly delegationCid: string; readonly delegationExpiresAt: number }
export interface CourierReply { readonly inReplyTo: string; readonly idempotencyKey: string }
export interface CourierInboundMessage {
  readonly threadId: string;
  readonly messageId: string;
  readonly intent: 'ask' | 'inform' | 'request' | 'task';
  readonly text: string;
  /** The timestamp encoded by the sender's message ULID, not a signed fact. */
  readonly sentAt: number;
}

function refuse(code: string, message: string): never { throw new CourierError(code, message); }

function verifiedScope(ctx: HeadlessCourierContext, node = ctx.node, allowExpired = false): CourierTenantScope {
  const session = node.restorableSession;
  agentId(ctx.courierDid);
  if (!session || !node.isSessionOnly || node.credentialHolderDid !== ctx.courierDid || node.getRuntimePermissionDelegations().length !== 0) {
    return refuse('bad-grant', 'Expected an isolated Courier agent session.');
  }
  const ownerDid = `did:pkh:eip155:${session.chainId}:${session.address.toLowerCase()}`;
  const spaceId = session.spaceId;
  if (ctx.ownerDid.toLowerCase() !== ownerDid || spaceId.toLowerCase() !== `tinycloud:${ownerDid.slice(4)}:${COURIER_SPACE}` || node.spaceId !== spaceId) {
    return refuse('bad-grant', 'The Courier grant does not belong to this owner and agents space.');
  }
  const times = siweTimes(session.siwe);
  const signedEnd = times.expiresAt?.getTime() ?? NaN;
  assertAgentGrant(node.getVerifiedSessionCapabilities(), times, allowExpired ? Math.min(Date.now(), signedEnd - 1) : Date.now());
  if (node.sessionEnd?.getTime() !== signedEnd ||
      session.delegationCid !== ctx.node.restorableSession?.delegationCid) {
    return refuse('bad-grant', 'Expected the same live finite Courier grant.');
  }
  const target = new URL(ctx.host);
  if (target.origin !== ctx.host || !(target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname)))) {
    return refuse('host-mismatch', 'Courier Node does not match the pinned origin.');
  }
  return { ownerDid, courierDid: ctx.courierDid, spaceId, host: ctx.host };
}

async function assertNodeHost(node: TinyCloudNode, host: string): Promise<void> {
  if ((await node.activeNodeIdentity()).origin !== host) refuse('host-mismatch', 'Courier Node does not match the pinned origin.');
}

async function inTenant<T>(ctx: HeadlessCourierContext, operation: (scope: CourierTenantScope, tx: CourierPeerTransaction) => Promise<T>): Promise<T> {
  const scope = verifiedScope(ctx);
  return ctx.store.transaction(scope, async tx => {
    await assertNodeHost(ctx.node, scope.host);
    return operation(scope, tx);
  });
}

async function loadPeer(tx: CourierPeerTransaction, scope: CourierTenantScope, handle: string, ref?: CourierPeerRef): Promise<CourierPeerRecord | undefined> {
  if (typeof handle !== 'string' || !HANDLE.test(handle) || handle === '__proto__') return refuse('bad-peer', 'Invalid Courier mailbox handle.');
  const record = await tx.get(handle);
  if (record && (record.version !== 1 || record.peer.handle !== handle ||
    record.scope.ownerDid !== scope.ownerDid || record.scope.courierDid !== scope.courierDid ||
    record.scope.host !== scope.host || record.scope.spaceId !== scope.spaceId ||
    (ref && (record.pairingId !== ref.pairingId || record.peer.courierDid !== ref.peerDid)))) {
    return refuse('peer-changed', 'The Courier pairing does not match this tenant and peer.');
  }
  return record;
}

/** The reference for a stored record, e.g. to unpair an attempt whose `acceptPairing` never returned. */
export function peerReference(record: CourierPeerRecord): CourierPeerRef {
  return { handle: record.peer.handle, peerDid: record.peer.courierDid, pairingId: record.pairingId };
}

function parseStep(raw: string, step: 'A' | 'C'): PairArtifact {
  const art = parseArtifact(raw);
  validateArtifactIdentity(art);
  if (art.step !== step || !HANDLE.test(art.peer) || !HANDLE.test(art.callMe) || art.peer === '__proto__' ||
    (step === 'C' && typeof art.delegation !== 'string')) return refuse('bad-artifact', `Expected pairing artifact ${step} with valid mailbox handles.`);
  agentId(art.from.courier);
  return art;
}

const PENDING_MS = 15 * 60_000;

/** Accept an untrusted A provisionally. Until C verifies, this handle is unavailable to reads and replies. */
export async function acceptPairing(ctx: HeadlessCourierContext, artifactA: string): Promise<CourierPairPending> {
  const art = parseStep(artifactA, 'A');
  if (art.challengeVersion !== 1) return refuse('courier-update-required', 'The initiating Courier must support signed pairing completion.');
  if (art.from.courier === ctx.courierDid) return refuse('bad-artifact', 'Refusing to pair with this agent identity.');
  return inTenant(ctx, async (scope, tx) => {
    const handle = art.callMe;
    let record = await loadPeer(tx, scope, handle);
    if (record) {
      if (record.phase !== 'pending' || record.peer.courierDid !== art.from.courier || record.peer.ownerDid !== art.from.owner ||
        record.peer.spaceId !== art.spaceId || record.peer.theirHandleForMe !== art.peer || !record.artifactB) {
        return refuse('peer-changed', 'This Courier mailbox already belongs to a different pairing.');
      }
      const preparing = record.peer.interim?.preparing;
      if (preparing) {
        const issued = await issuedPeerGrants(ctx.node, scope, record.peer, () => refuse('pair-pending', 'Pairing activation could not be confirmed.'));
        if (!issued.some(grant => grant.cid === preparing.cid && grant.status === 'active')) {
          return refuse('pair-pending', 'Pairing activation is unconfirmed; unpair this attempt before creating a replacement.');
        }
        recordOutbound(record.peer, deserializeDelegation(record.artifactB.delegation!));
        delete record.peer.interim;
        await tx.save(handle, record);
      }
    } else {
      // A is not signed. Never expose pre-existing data to the identity named in an unsigned artifact.
      if ((await listAll(ctx.node.kv, k.toPeer(handle))).length !== 0) return refuse('mailbox-in-use', 'The requested Courier mailbox is not empty.');
      // A grant left from an earlier use of this handle would let its holder read the new peer's mailbox. Refuse; never
      // revoke here. Only grants the node already lists are seen; an activation still in flight is not.
      if ((await liveMailboxGrants(ctx.node, scope, handle, reason => refuse('mailbox-unconfirmed', `Courier could not confirm the mailbox is unshared: ${reason}.`))).length !== 0) {
        return refuse('mailbox-in-use', 'An earlier grant for this Courier mailbox is still live; it must be revoked first.');
      }
      const peer = pendingFromA(art);
      const challenge = randomBytes(32).toString('base64url');
      const pending: CourierPeerRecord = { version: 1, scope, pairingId: challenge, phase: 'pending', peer };
      const outgoing = await issuePairDelegation(ctx.node, scope.spaceId, peer, {
        expiry: '7d', requireActivation: true, disableSubDelegation: true,
        onPrepared: async prepared => {
          pending.artifactB = { ...artifactWithDelegation('B', { ...scope, label: ctx.label }, prepared, handle, art.peer), challenge };
          peer.interim = { cleanup: {}, preparing: { cid: prepared.cid, at: new Date().toISOString() } };
          await tx.save(handle, pending);
        },
      });
      recordOutbound(peer, outgoing);
      delete peer.interim;
      await tx.save(handle, pending);
      record = pending;
    }
    const createdAt = Date.parse(record.peer.pairedAt);
    const expiresAt = Math.min(Date.parse(record.artifactB!.delegationExpiresAt!), createdAt + PENDING_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return refuse('pair-expired', 'This pairing offer expired; unpair the attempt before starting a new one.');
    return { ...peerReference(record), artifactB: JSON.stringify(record.artifactB), createdAt, expiresAt };
  });
}

async function readPeer(ctx: HeadlessCourierContext, scope: CourierTenantScope, peer: StoredPeer, serialized: string) {
  const delegation = deserializeDelegation(serialized);
  if (delegation.host !== scope.host) return refuse('host-mismatch', 'Peer delegation is not for the pinned Courier Node.');
  const reader = await ctx.createReader();
  if (reader === ctx.node) return refuse('bad-grant', 'Peer reads require an isolated Courier Node.');
  verifiedScope(ctx, reader);
  await assertNodeHost(reader, scope.host);
  const active = await verifyPairDelegation(reader, scope, peer, serialized);
  if (active.host !== scope.host) return refuse('host-mismatch', 'Peer delegation activated on a different Courier Node.');
  return { active, reader };
}

/** Check the peer's signed C and consume the pending challenge in the same durable transaction. */
export async function finalizePairing(ctx: HeadlessCourierContext, pending: CourierPeerRef, artifactC: string): Promise<CourierPairedPeer> {
  const art = parseStep(artifactC, 'C');
  if (art.callMe !== pending.handle || art.from.courier !== pending.peerDid) return refuse('bad-artifact', 'Artifact C does not match this pending pairing.');
  return inTenant(ctx, async (scope, tx) => {
    const record = await loadPeer(tx, scope, pending.handle, pending);
    if (!record || record.phase !== 'pending' || !record.artifactB || record.peer.interim?.preparing) {
      return refuse('not-pending', 'This Courier pairing is not awaiting completion.');
    }
    const peer = record.peer;
    const pendingEnd = Date.parse(peer.pairedAt) + PENDING_MS;
    if (!Number.isFinite(pendingEnd) || Date.now() >= pendingEnd) return refuse('pair-expired', 'The Courier pairing challenge expired.');
    assertPairCompletion(peer, art);
    assertSignedPairCompletion(record.artifactB, art);
    const { active } = await readPeer(ctx, scope, peer, art.delegation!);
    const now = Date.now();
    const issued = await issuedPeerGrants(ctx.node, scope, peer, () => refuse('pair-pending', 'The accepted grant could not be confirmed.'));
    const outgoingEnd = issued.find(grant => grant.cid === peer.outbound[0]?.cid && grant.status === 'active')?.expiresAt?.getTime() ?? 0;
    const delegationExpiresAt = Math.min(active.expiry.getTime(), outgoingEnd);
    if (delegationExpiresAt <= now || now >= pendingEnd) {
      return refuse('pair-expired', 'A pairing grant expired or was revoked before completion.');
    }
    peer.inbound = inboundGrant(active);
    peer.status = 'paired';
    peer.pairedAt = new Date(now).toISOString();
    record.phase = 'paired';
    delete record.artifactB;
    await tx.save(peer.handle, record);
    return { ...peerReference(record), delegationCid: active.cid, delegationExpiresAt };
  });
}

async function pairedReader(ctx: HeadlessCourierContext, scope: CourierTenantScope, tx: CourierPeerTransaction, ref: CourierPeerRef) {
  const record = await loadPeer(tx, scope, ref.handle, ref);
  if (!record || record.phase !== 'paired' || record.peer.status !== 'paired' || !record.peer.inbound || !record.peer.theirHandleForMe) {
    return refuse('not-paired', 'Courier peer is not paired.');
  }
  const peer = record.peer;
  if (peer.interim?.latchedAt || peer.interim?.inboundRefusedAt) return refuse('peer-revoked', 'Courier pairing was revoked.');
  if (!peer.outbound.some(grant => !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now())) return refuse('peer-expired', 'The outgoing Courier pairing grant expired.');
  assertInboundLive(peer);
  const { active, reader } = await readPeer(ctx, scope, peer, peer.inbound!.delegation);
  if (active.cid !== peer.inbound!.cid) return refuse('bad-delegation', 'Stored Courier grant does not match the signed grant.');
  // Even in a shared owner space, sign exclusively with the peer delegation, never the broader primary session.
  const wasm = new NodeWasmBindings();
  const delegation = active.delegation;
  const access = new DelegatedAccess({
    ...reader.restorableSession!, spaceId: delegation.spaceId, address: delegation.ownerAddress, chainId: delegation.chainId,
    delegationCid: active.cid, delegationHeader: delegation.delegationHeader,
  }, delegation, scope.host, wasm.invoke, wasm.invokeAny, undefined, {
    fetch: (input, init) => {
      const url = new URL(input);
      if (url.origin !== scope.host) return refuse('host-mismatch', 'Peer invocation left the pinned Courier Node.');
      return (ctx.fetch ?? fetch)(input, { ...init, redirect: 'error' });
    },
    track: context => context,
  });
  return { peer, kv: access.kv, mailbox: peer.theirHandleForMe!, expiry: active.expiry };
}

function inboundMessage(peer: StoredPeer, threadId: string, messageId: string, raw: unknown): CourierInboundMessage | undefined {
  if (!isRecord(raw) || raw.contextId !== threadId || raw.messageId !== messageId || !ULID.test(messageId)) return;
  const view = messageView(raw);
  if (view.invalid.length || view.from?.agent !== peer.courierDid || view.from.owner.toLowerCase() !== peer.ownerDid.toLowerCase()) return;
  let sentAt: number;
  try { sentAt = decodeTime(messageId); } catch { return; }
  const intent = view.intent;
  if (intent !== 'ask' && intent !== 'request' && intent !== 'inform') return;
  return { threadId, messageId, intent: intent !== 'inform' && Array.isArray(raw.referenceTaskIds) && raw.referenceTaskIds.length ? 'task' : intent, text: view.text, sentAt };
}

/** Read the verified peer's current mailbox; the caller owns cursors, rate limits and turn policy. */
export async function listInbound(ctx: HeadlessCourierContext, ref: CourierPeerRef, since?: string): Promise<CourierInboundMessage[]> {
  if (since !== undefined && !ULID.test(since)) return refuse('bad-message', 'Courier cursor must be a message ULID.');
  return inTenant(ctx, async (scope, tx) => {
    const { peer, kv, mailbox, expiry } = await pairedReader(ctx, scope, tx, ref);
    const base = `${k.toPeer(mailbox)}threads/`;
    const prefix = peer.sessionId ? `${k.threadRoot(mailbox, peer.sessionId)}/` : base;
    const current = await getJson<Receipts>(ctx.node.kv, k.receipts(peer.handle));
    const receipts: Receipts = { v: 1, threads: current?.value.threads ?? {} };
    const candidates = selectUndelivered((await listAll(kv, prefix)).filter(key => key.startsWith(base)), receipts)
      .filter(item => ULID.test(item.threadId) && ULID.test(item.messageId) && (!since || item.messageId > since) &&
        item.key === k.msg(mailbox, item.threadId, item.messageId) && (!peer.sessionId || item.threadId === peer.sessionId))
      .sort((a, b) => a.messageId.localeCompare(b.messageId) || a.threadId.localeCompare(b.threadId))
      .slice(-200);
    const { values } = await getJsonMany<unknown>(kv, candidates.map(item => item.key));
    assertInboundLive(peer, expiry);
    const result: CourierInboundMessage[] = [];
    for (const { key, threadId, messageId } of candidates) {
      const item = inboundMessage(peer, threadId, messageId, values.get(key)?.value);
      if (item) result.push(item);
    }
    return result;
  });
}

/** Acknowledge only after the caller durably takes responsibility for these deliveries. */
export async function acknowledgeInbound(ctx: HeadlessCourierContext, ref: CourierPeerRef, ids: PendingDelivery[]): Promise<void> {
  if (ids.length === 0) return;
  if (ids.length > 200 || ids.some(id => !ULID.test(id.threadId) || !ULID.test(id.messageId))) {
    return refuse('bad-message', 'Courier acknowledgements require valid thread/message ULIDs.');
  }
  return inTenant(ctx, async (scope, tx) => {
    const { peer, expiry } = await pairedReader(ctx, scope, tx, ref);
    if (peer.sessionId && ids.some(id => id.threadId !== peer.sessionId)) return refuse('session-mismatch', 'Courier acknowledgements are outside the paired session.');
    assertInboundLive(peer, expiry);
    await commitReceipts(ctx.node.kv, new Map([[peer.handle, ids]]), { strict: true });
  });
}

/** Reply reservations are private even when the corresponding reply never reaches the peer. */
function replyReservations(scope: CourierTenantScope, handle: string): string {
  return `${PREFIX}/me/state/agents/${agentId(scope.courierDid)}/headless-replies/${handle}/`;
}

/** Reply only to an exact, presently readable peer message; this API cannot create threads or send requests. */
export async function sendMessage(ctx: HeadlessCourierContext, ref: CourierPeerRef, threadId: string, text: string, reply: CourierReply): Promise<{ messageId: string }> {
  if (typeof threadId !== 'string' || !ULID.test(threadId) || !reply || typeof reply.inReplyTo !== 'string' || !ULID.test(reply.inReplyTo) ||
    reply.idempotencyKey !== requestHash([ref.peerDid, threadId, reply.inReplyTo])) {
    return refuse('bad-reply', 'Courier reply requires a valid thread, incoming message and idempotency key.');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 256 * 1024) return refuse('bad-reply', 'Courier reply must contain 1–256 KB of inline text.');
  return inTenant(ctx, async (scope, tx) => {
    const { peer, kv, mailbox, expiry } = await pairedReader(ctx, scope, tx, ref);
    if (peer.sessionId && threadId !== peer.sessionId) return refuse('session-mismatch', 'The reply does not match the paired session.');
    const source = await getJson<unknown>(kv, k.msg(mailbox, threadId, reply.inReplyTo));
    const incoming = inboundMessage(peer, threadId, reply.inReplyTo, source?.value);
    if (!incoming || incoming.intent === 'inform') return refuse('bad-reply', 'This peer message does not allow a reply in that thread.');
    assertInboundLive(peer, expiry);
    const self = ctx.node.kv;
    // Reserve one real ULID at the time of the first attempt, even if its write or the reply's response is lost.
    const key = `${replyReservations(scope, peer.handle)}${threadId}/${reply.inReplyTo}.json`;
    const bodyHash = requestHash([ref.pairingId, text]);
    let reservation = (await getJson<{ messageId: string; bodyHash: string }>(self, key))?.value;
    if (!reservation) {
      reservation = { messageId: ulid(), bodyHash };
      await putCreate(self, key, reservation);
    }
    if (reservation.bodyHash !== bodyHash || !ULID.test(reservation.messageId)) return refuse('conflict', 'A different reply is already reserved for this Courier message.');
    assertInboundLive(peer, expiry);
    const message = await publishMessage(self, { owner: scope.ownerDid, agent: scope.courierDid, label: ctx.label }, peer, {
      which: 'thread', threadId, text, intent: 'answer', inReplyTo: reply.inReplyTo, asks: [], constraints: [], referenceTaskIds: [],
    }, { messageId: reservation.messageId });
    return { messageId: message.messageId };
  });
}

/** Latch the peer off first. A failed revocation or cleanup stays durable and can be retried with the same reference. */
export async function unpair(ctx: HeadlessCourierContext, ref: CourierPeerRef): Promise<void> {
  const scope = verifiedScope(ctx, ctx.node, true);
  return ctx.store.transaction(scope, async tx => {
    const record = await loadPeer(tx, scope, ref.handle, ref);
    if (!record) return;
    const peer = record.peer;
    const save = () => tx.save(ref.handle, record);
    if (record.phase !== 'revoking') {
      record.phase = 'revoking';
      (peer.interim ??= { cleanup: {} }).latchedAt = new Date().toISOString();
      await save();
    }
    verifiedScope(ctx);
    await assertNodeHost(ctx.node, scope.host);
    await revokePeerGrants(ctx.node, scope, () => peer, save, reason => refuse('revoke-failed', `Courier unpair is pending: ${reason}. Retry with the same peer reference.`), true);
    for (const prefix of [k.toPeer(peer.handle), replyReservations(scope, peer.handle)]) {
      if (!await deleteAll(ctx.node.kv, prefix)) return refuse('unpair-pending', 'Courier unpair cleanup is incomplete. Retry with the same peer reference.');
    }
    await tx.save(ref.handle, undefined);
  });
}
