import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { ulid } from 'ulid';
import { DelegatedAccess, NodeWasmBindings, activateValidatedRuntimeDelegation, deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import type { IKVService, PortableDelegation, TinyCloudNode, TinyCloudSession } from '@tinycloud/node-sdk';
import { createLink, resolveLink, signerFromJwk, linkIssuerPublicKey } from '@tinycloud/share-envelope/links';
import type { Ed25519PrivateJwk } from '@tinycloud/share-envelope/links';
import { CourierError } from './errors.js';
import { canonicalJson, requestHash } from './canonical.js';
import { assertExactAuthority, assertPeerDelegation, bareDid } from './authority.js';
import { k, PREFIX, peerReadPermissions } from './keys.js';
import { artifactA, artifactWithDelegation, parseArtifact, validateArtifactIdentity } from './pairing.js';
import type { PairArtifact } from './pairing.js';
import { loadKey, loadProfile, profileDir, saveProfile, writeSecure } from './profile.js';
import type { AgentKey, Profile, StoredPeer } from './profile.js';
import { courierNode } from './node.js';
import { getJson, putCreate, putOverwrite } from './store.js';
import { isRecord } from './a2a.js';
import { requireFlag } from './args.js';
import type { ParsedArgs } from './args.js';
import { activateSession, INVITATION_MODES, selectedSession, sessionKey, validSessionId } from './guided.js';
import type { CourierSession, InvitationMode } from './guided.js';

const DEFAULT_API = 'https://api.tinycloud.xyz';
const DEFAULT_VIEWER = 'https://courier.tinycloud.xyz';
const DOMAIN = 'xyz.tinycloud.courier/invitation/v1\0';
const inviteStateKey = (id: string) => `${PREFIX}/me/state/invitations/${id}.json`;
const winnerKey = (id: string) => `${PREFIX}/me/consumed/invitations/${id}.json`;
const answerKey = (id: string) => `${PREFIX}/me/state/invitation-answers/${id}.json`;
const relayRoot = (id: string) => `${PREFIX}/to/invite-${id}/pairing/`;

export interface CourierInvitation {
  type: 'courier-invitation';
  v: 1;
  id: string;
  issuer: string;
  host: string;
  session: CourierSession;
  mode: InvitationMode;
  recipient?: string;
  expiresAt: string;
  artifact: PairArtifact;
  relay: { key: AgentKey; delegation: string };
}
interface Claim {
  invitationId: string;
  invitationHash: string;
  sessionId: string;
  artifact: PairArtifact;
}
interface Answer extends Claim { claimHash: string }
interface Signed<T> { payload: T; signature: string }
interface InviteState { body: CourierInvitation; link?: string }
interface JoinState { invitationHash: string; claim: Signed<Claim>; joined?: true }

function refuse(message: string): never { throw new CourierError('bad-invitation', message); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) refuse('Unexpected invitation fields.');
}
function sameIdentity(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

/** Strict Courier body codec; generic links do not confer chat authority. */
export function parseInvitation(value: unknown): CourierInvitation {
  if (!isRecord(value)) refuse('Invitation must be an object.');
  keys(value, ['type', 'v', 'id', 'issuer', 'host', 'session', 'mode', 'expiresAt', 'artifact', 'relay'], ['recipient']);
  if (value.type !== 'courier-invitation' || value.v !== 1 || typeof value.id !== 'string' || !validSessionId(value.id)) refuse('Unsupported Courier invitation.');
  if (typeof value.issuer !== 'string' || !linkIssuerPublicKey(value.issuer)) refuse('Invalid invitation signer.');
  if (typeof value.host !== 'string') refuse('Missing node origin.');
  let host: URL;
  try { host = new URL(value.host); } catch { return refuse('Invalid node origin.'); }
  if (host.origin !== value.host || (host.protocol !== 'https:' && !(host.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(host.hostname)))) refuse('Node must be an HTTPS origin (or a loopback test host).');
  if (!INVITATION_MODES.includes(value.mode as InvitationMode)) refuse('Unknown invitation mode.');
  if (value.mode === 'named') {
    if (typeof value.recipient !== 'string' || !linkIssuerPublicKey(value.recipient)) refuse('Named invitations require an exact Courier did:key; email identifiers are not supported.');
  } else if (value.recipient !== undefined) refuse('Unexpected recipient constraint.');
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt) refuse('Invalid invitation expiry.');
  if (!isRecord(value.session)) refuse('Missing intended session.');
  keys(value.session, ['sessionId', 'subject', 'createdAt']);
  if (typeof value.session.sessionId !== 'string' || !validSessionId(value.session.sessionId) || typeof value.session.subject !== 'string'
    || value.session.subject.length > 1000 || typeof value.session.createdAt !== 'string' || !Number.isFinite(Date.parse(value.session.createdAt))) refuse('Invalid intended session.');
  const art = parseArtifact(JSON.stringify(value.artifact));
  validateArtifactIdentity(art);
  if (art.step !== 'A' || art.from.courier !== value.issuer || art.peer !== `chat-${value.id}-recipient` || art.callMe !== `chat-${value.id}-issuer`) refuse('Invitation pairing does not match its signer or mailbox.');
  if (!isRecord(value.relay)) refuse('Missing pairing relay.');
  keys(value.relay, ['key', 'delegation']);
  if (!isRecord(value.relay.key) || value.relay.key.v !== 1 || typeof value.relay.key.did !== 'string' || !isRecord(value.relay.key.jwk)
    || typeof value.relay.delegation !== 'string') refuse('Invalid pairing relay.');
  return value as unknown as CourierInvitation;
}

function signed<T>(payload: T, key: AgentKey): Signed<T> {
  const privateKey = createPrivateKey({ key: key.jwk as JsonWebKey, format: 'jwk' });
  return { payload, signature: sign(null, Buffer.from(DOMAIN + canonicalJson(payload)), privateKey).toString('base64url') };
}
function checked<T>(value: unknown, did: string): Signed<T> {
  if (!isRecord(value)) refuse('Missing signed pairing response.');
  keys(value, ['payload', 'signature']);
  const raw = linkIssuerPublicKey(did);
  if (!raw || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) refuse('Invalid pairing signature.');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
  if (!verify(null, Buffer.from(DOMAIN + canonicalJson(value.payload)), key, Buffer.from(value.signature, 'base64url'))) refuse('Pairing response signature does not match its agent.');
  return value as unknown as Signed<T>;
}
function relayPermissions(body: CourierInvitation) {
  return [{ service: 'tinycloud.kv', space: body.artifact.spaceId, path: relayRoot(body.id), actions: ['tinycloud.kv/get', 'tinycloud.kv/put'] }];
}

/** The relay key has no thread access; all requests still carry the issued signed delegation. */
function relayKv(body: CourierInvitation): IKVService {
  const delegation = deserializeDelegation(body.relay.delegation);
  const key = body.relay.key;
  const signer = signerFromJwk(key.jwk as unknown as Ed25519PrivateJwk);
  if (signer.did !== bareDid(key.did) || delegation.delegateDID.split('#')[0] !== signer.did || delegation.spaceId !== body.artifact.spaceId) refuse('Relay key or space changed.');
  const wasm = new NodeWasmBindings();
  const session: TinyCloudSession = {
    address: delegation.ownerAddress, chainId: delegation.chainId, sessionKey: JSON.stringify(key.jwk), jwk: key.jwk as never,
    spaceId: delegation.spaceId, delegationCid: delegation.cid, delegationHeader: delegation.delegationHeader,
    verificationMethod: key.did, siwe: '', signature: '',
  };
  return new DelegatedAccess(session, delegation, body.host, wasm.invoke, wasm.invokeAny).kv;
}

async function validateIncoming(node: TinyCloudNode, profile: Profile, body: CourierInvitation, art: PairArtifact): Promise<PortableDelegation> {
  validateArtifactIdentity(art);
  if (art.from.courier === profile.courierDid) refuse('Refusing to join this agent identity.');
  const mailbox = art.step === 'B' ? body.artifact.callMe : body.artifact.peer;
  const callMe = art.step === 'B' ? body.artifact.peer : body.artifact.callMe;
  if (art.peer !== mailbox || art.callMe !== callMe || !art.delegation) refuse('Pairing mailbox changed.');
  const delegation = deserializeDelegation(art.delegation);
  if (delegation.spaceId !== art.spaceId || !sameIdentity(delegation.ownerAddress, art.from.owner.split(':').at(-1)!)) refuse('Pairing owner or space changed.');
  const expected = { issuer: art.from.courier, audience: profile.courierDid, spaceId: art.spaceId, mailbox: art.peer, sessionId: body.session.sessionId };
  const active = await activateValidatedRuntimeDelegation(node, delegation, {
    host: profile.host,
    authorize: (permissions) => { assertExactAuthority(permissions, peerReadPermissions(expected.mailbox, expected.spaceId, expected.sessionId), 'Session pairing'); return true; },
  });
  assertPeerDelegation(active, expected);
  return active.delegation;
}

function installPeer(profile: Profile, body: CourierInvitation, incoming: PairArtifact, inbound: PortableDelegation, outbound: PortableDelegation) {
  const handle = incoming.callMe;
  const existing = profile.peers[handle];
  if (existing && (existing.courierDid !== incoming.from.courier || existing.sessionId !== body.session.sessionId)) refuse('Invitation would replace another pairing.');
  const peer: StoredPeer = {
    handle, ownerDid: incoming.from.owner, courierDid: incoming.from.courier, spaceId: incoming.spaceId,
    theirHandleForMe: incoming.peer, status: 'paired', sessionId: body.session.sessionId, pairedAt: new Date().toISOString(),
    inbound: { delegation: serializeDelegation(inbound), cid: inbound.cid, expiresAt: inbound.expiry.toISOString() },
    outbound: [{ cid: outbound.cid, expiresAt: outbound.expiry.toISOString(), issuedAt: new Date().toISOString() }],
  };
  profile.peers[handle] = peer;
  saveProfile(profile);
  return peer;
}
async function publishSession(node: TinyCloudNode, profile: Profile, body: CourierInvitation) {
  const meta = { threadId: body.session.sessionId, subject: body.session.subject, createdAt: body.session.createdAt,
    startedBy: { owner: body.artifact.from.owner, courier: body.issuer } };
  const handle = profile.courierDid === body.issuer ? body.artifact.peer : body.artifact.callMe;
  const key = k.threadMeta(handle, body.session.sessionId);
  if (!(await getJson(node.kv, key))) await putCreate(node.kv, key, meta);
  const stateKey = sessionKey(body.session.sessionId);
  if (!(await getJson(node.kv, stateKey))) await putCreate(node.kv, stateKey, body.session);
  activateSession({ ...body.session, peer: handle });
}
function expiryCheck(body: CourierInvitation) {
  if (Date.parse(body.expiresAt) <= Date.now()) throw new CourierError('invite-expired', 'Invitation expired; no session was created or substituted.');
}
function waitSeconds(args: ParsedArgs): number {
  const value = Number(args.get('wait') ?? '300');
  if (!Number.isInteger(value) || value < 1 || value > 604800) throw new CourierError('usage', '--wait must be an integer from 1 to 604800 seconds.');
  return value;
}
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

/** Serve one durable winner. A restart cannot issue C to a different claimant. */
export async function serveInvitation(node: TinyCloudNode, profile: Profile, body: CourierInvitation, wait: number) {
  const deadline = Math.min(Date.parse(body.expiresAt), Date.now() + wait * 1000);
  const invitationHash = requestHash(body);
  for (;;) {
    expiryCheck(body);
    let winner = await getJson<Signed<Claim>>(node.kv, winnerKey(body.id));
    if (!winner) {
      const candidate = await getJson<Signed<Claim>>(node.kv, `${relayRoot(body.id)}claim.json`);
      if (candidate) {
        const art = parseArtifact(JSON.stringify(candidate.value.payload?.artifact));
        const claim = checked<Claim>(candidate.value, art.from.courier);
        if (claim.payload.invitationId !== body.id || claim.payload.invitationHash !== invitationHash || claim.payload.sessionId !== body.session.sessionId || art.step !== 'B') refuse('Claim targets another invitation or session.');
        if (body.mode === 'named' && art.from.courier !== body.recipient) refuse('Claim is not from the named recipient.');
        if (body.mode === 'same-owner' && !sameIdentity(art.from.owner, profile.ownerDid!)) refuse('Claim belongs to a different owner.');
        await validateIncoming(node, profile, body, art);
        try { await putCreate(node.kv, winnerKey(body.id), claim); } catch (error) {
          if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
        }
        winner = await getJson<Signed<Claim>>(node.kv, winnerKey(body.id));
        if (!winner) refuse('Winner reservation was not persisted.');
      }
    }
    if (winner) {
      const claim = winner.value;
      const artB = parseArtifact(JSON.stringify(claim.payload.artifact));
      checked<Claim>(claim, artB.from.courier);
      if (claim.payload.invitationId !== body.id || claim.payload.invitationHash !== invitationHash || claim.payload.sessionId !== body.session.sessionId || artB.step !== 'B') refuse('Reserved winner does not match this invitation.');
      if (body.mode === 'named' && artB.from.courier !== body.recipient) refuse('Reserved winner is not the named recipient.');
      if (body.mode === 'same-owner' && !sameIdentity(artB.from.owner, profile.ownerDid!)) refuse('Reserved winner belongs to a different owner.');
      const inbound = await validateIncoming(node, profile, body, artB);
      let answer = await getJson<Signed<Answer>>(node.kv, answerKey(body.id));
      if (!answer) {
        const outbound = await node.delegateTo(artB.from.courier, peerReadPermissions(body.artifact.peer, profile.spaceId!, body.session.sessionId), { expiry: Math.min(7 * 86400000, Date.parse(body.expiresAt) - Date.now()), requireActivation: true });
        const artC = artifactWithDelegation('C', profile, outbound.delegation, body.artifact.peer, body.artifact.callMe);
        const response = signed<Answer>({ invitationId: body.id, invitationHash, sessionId: body.session.sessionId, claimHash: requestHash(claim), artifact: artC }, loadKey());
        try { await putCreate(node.kv, answerKey(body.id), response); } catch (error) {
          if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
        }
        answer = await getJson<Signed<Answer>>(node.kv, answerKey(body.id));
        if (!answer) refuse('Pairing answer was not persisted.');
      }
      const response = checked<Answer>(answer.value, body.issuer).payload;
      if (response.invitationId !== body.id || response.invitationHash !== invitationHash || response.sessionId !== body.session.sessionId || response.claimHash !== requestHash(claim)) refuse('Stored answer does not match the reserved winner.');
      const artC = parseArtifact(JSON.stringify(answer.value.payload.artifact));
      installPeer(profile, body, artB, inbound, deserializeDelegation(artC.delegation!));
      await publishSession(node, profile, body);
      await putOverwrite(node.kv, `${relayRoot(body.id)}answer.json`, answer.value);
      console.log(JSON.stringify({ status: 'paired', invitationId: body.id, sessionId: body.session.sessionId, peer: body.artifact.peer }));
      return;
    }
    if (Date.now() >= deadline) throw new CourierError('invite-pending', `No claim received. Resume with courier invite serve ${body.id}; the same invitation and winner reservation are preserved.`);
    await sleep();
  }
}

export async function cmdInvite(args: ParsedArgs): Promise<void> {
  const profile = loadProfile();
  const node = await courierNode(profile);
  const wait = waitSeconds(args);
  if (args.positional[0] === 'serve') {
    const id = args.positional[1] ?? '';
    if (!validSessionId(id)) throw new CourierError('usage', 'courier invite serve <invitationId>');
    const state = await getJson<InviteState>(node.kv, inviteStateKey(id));
    if (!state) refuse('No invitation issued by this profile.');
    const body = parseInvitation(state.value.body);
    if (body.issuer !== profile.courierDid || !sameIdentity(body.artifact.from.owner, profile.ownerDid!) || body.host !== profile.host) refuse('Invitation belongs to another issuer.');
    return serveInvitation(node, profile, body, wait);
  }
  const mode = requireFlag(args, 'mode', 'courier invite --session <id> --mode same-owner|anyone|named --consent');
  if (!INVITATION_MODES.includes(mode as InvitationMode)) throw new CourierError('usage', 'Choose exactly one invitation mode: same-owner, anyone, named.');
  if (!args.has('consent')) throw new CourierError('consent-required', 'Owner consent is required: pass --consent to invite a participant to this session.');
  let recipient: string | undefined;
  if (mode === 'named') {
    const target = requireFlag(args, 'recipient', 'Named invitations require --recipient <did:key|verified-peer-handle>.');
    const peer = profile.peers[target];
    recipient = target.startsWith('did:key:') ? target : peer?.status === 'paired' && peer.inbound ? peer.courierDid : undefined;
    if (!recipient || !linkIssuerPublicKey(recipient)) throw new CourierError('unsupported-recipient', 'Use an exact Courier did:key or a verified paired handle. Email identifiers are not supported.');
    if (recipient === profile.courierDid) refuse('Refusing to invite this agent identity.');
    if (peer) await validateHandle(node, profile, peer);
  } else if (args.has('recipient')) throw new CourierError('usage', '--recipient is only valid in named mode.');
  const selected = await selectedSession(node, profile, requireFlag(args, 'session', 'courier invite --session <id>'), args.get('peer'));
  const session = { sessionId: selected.sessionId, subject: selected.subject, createdAt: selected.createdAt };
  const id = ulid();
  const manager = new NodeWasmBindings().createSessionManager();
  const keyId = manager.createSessionKey('courier-relay');
  const key: AgentKey = { v: 1, did: manager.getDID(keyId), jwk: JSON.parse(manager.jwk(keyId)!), createdAt: new Date().toISOString() };
  const expiresAt = new Date(Math.floor(Math.min(Date.now() + 86400000, Date.parse(profile.grantExpiresAt!)) / 1000) * 1000).toISOString();
  const body: CourierInvitation = {
    type: 'courier-invitation', v: 1, id, issuer: profile.courierDid, host: profile.host, session, mode: mode as InvitationMode,
    ...(recipient ? { recipient } : {}), expiresAt, artifact: artifactA(profile, `chat-${id}-recipient`, `chat-${id}-issuer`), relay: { key, delegation: '' },
  };
  const relay = await node.delegateTo(bareDid(key.did), relayPermissions(body), { expiry: Date.parse(expiresAt) - Date.now(), requireActivation: true });
  body.relay.delegation = serializeDelegation(relay.delegation);
  parseInvitation(body);
  await putCreate(node.kv, inviteStateKey(id), { body });
  const result = await createLink({ type: 'courier', issuerKey: signerFromJwk(loadKey().jwk as unknown as Ed25519PrivateJwk),
    apiOrigin: process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_API, linkOrigin: process.env.COURIER_LINK_ORIGIN ?? DEFAULT_VIEWER,
    expiresAt: new Date(expiresAt), plaintext: new TextEncoder().encode(canonicalJson(body)) });
  await putOverwrite(node.kv, inviteStateKey(id), { body, link: result.link });
  console.log(JSON.stringify({ status: 'invitation', invitationId: id, sessionId: session.sessionId, mode, link: result.link, expiresAt }));
  return serveInvitation(node, profile, body, wait);
}

async function validateHandle(node: TinyCloudNode, profile: Profile, peer: StoredPeer) {
  if (!peer.inbound || !peer.theirHandleForMe) refuse('Recipient handle is not verified.');
  const active = await activateValidatedRuntimeDelegation(node, deserializeDelegation(peer.inbound.delegation), { host: profile.host });
  assertPeerDelegation(active, { issuer: peer.courierDid, audience: profile.courierDid, spaceId: peer.spaceId, mailbox: peer.theirHandleForMe, sessionId: peer.sessionId });
}

export async function joinInvitation(link: string, args: ParsedArgs): Promise<void> {
  if (!args.has('consent')) throw new CourierError('consent-required', 'Joining delegates read access to your side of this session. Pass --consent after owner approval.');
  const wait = waitSeconds(args);
  const opened = await resolveLink(link, { apiOrigin: process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_API,
    trustedOrigins: [process.env.COURIER_LINK_ORIGIN ?? DEFAULT_VIEWER], validateBody: (type, value) => { if (type !== 'courier') refuse('Not a Courier invitation.'); parseInvitation(value); } });
  const body = parseInvitation(opened.value);
  if (opened.header.audience !== (process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_API) || opened.header.expiresAt !== body.expiresAt) refuse('Invitation audience or expiry changed.');
  expiryCheck(body);
  const profile = loadProfile();
  const node = await courierNode(profile);
  if (body.host !== profile.host) refuse('Invitation uses another node host; no setup or session was changed.');
  if (body.issuer === profile.courierDid) refuse('Refusing to join this agent identity.');
  if (body.mode === 'same-owner' && !sameIdentity(body.artifact.from.owner, profile.ownerDid!)) refuse('Invitation requires another agent of the same owner.');
  if (body.mode === 'named' && body.recipient !== profile.courierDid) refuse('Invitation is addressed to another agent key.');
  const hash = requestHash(body);
  const localFile = path.join(profileDir(), 'invitation-joins', `${body.id}.json`);
  fs.mkdirSync(path.dirname(localFile), { recursive: true, mode: 0o700 });
  let state: JoinState | undefined;
  try { state = JSON.parse(fs.readFileSync(localFile, 'utf8')) as JoinState; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (state && (state.invitationHash !== hash || state.joined)) throw new CourierError('invite-used', 'Invitation already joined or changed. No other session was activated.');
  if (!state) {
    const outbound = await node.delegateTo(body.issuer, peerReadPermissions(body.artifact.callMe, profile.spaceId!, body.session.sessionId), { expiry: Date.parse(body.expiresAt) - Date.now(), requireActivation: true });
    const artB = artifactWithDelegation('B', profile, outbound.delegation, body.artifact.callMe, body.artifact.peer);
    state = { invitationHash: hash, claim: signed<Claim>({ invitationId: body.id, invitationHash: hash, sessionId: body.session.sessionId, artifact: artB }, loadKey()) };
    writeSecure(localFile, state);
  }
  const relay = relayKv(body);
  try { await putCreate(relay, `${relayRoot(body.id)}claim.json`, state.claim); } catch (error) {
    if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
    const existing = await getJson<Signed<Claim>>(relay, `${relayRoot(body.id)}claim.json`);
    if (!existing || requestHash(existing.value) !== requestHash(state.claim)) throw new CourierError('invite-used', 'Another recipient has already claimed this invitation.');
  }
  const deadline = Math.min(Date.parse(body.expiresAt), Date.now() + wait * 1000);
  for (;;) {
    expiryCheck(body);
    const got = await getJson<Signed<Answer>>(relay, `${relayRoot(body.id)}answer.json`);
    if (got) {
      const answer = checked<Answer>(got.value, body.issuer).payload;
      if (answer.invitationId !== body.id || answer.invitationHash !== hash || answer.sessionId !== body.session.sessionId || answer.claimHash !== requestHash(state.claim)) refuse('Pairing answer belongs to another claim or session.');
      const artC = parseArtifact(JSON.stringify(answer.artifact));
      if (artC.step !== 'C' || artC.from.courier !== body.issuer || artC.from.owner !== body.artifact.from.owner || artC.spaceId !== body.artifact.spaceId) refuse('Pairing issuer changed.');
      const inbound = await validateIncoming(node, profile, body, artC);
      const outbound = deserializeDelegation(state.claim.payload.artifact.delegation!);
      installPeer(profile, body, artC, inbound, outbound);
      await publishSession(node, profile, body);
      writeSecure(localFile, { ...state, joined: true });
      console.log(JSON.stringify({ status: 'active', invitationId: body.id, session: { ...body.session, peer: body.artifact.callMe } }));
      return;
    }
    if (Date.now() >= deadline) throw new CourierError('invite-pending', 'Issuer has not completed pairing yet. Ask them to resume invite serve, then join the same link; no different session was created.');
    await sleep();
  }
}

export async function cmdJoin(args: ParsedArgs) {
  const link = args.positional[0] ?? requireFlag(args, 'link', 'courier join <link> --consent');
  return joinInvitation(link, args);
}
