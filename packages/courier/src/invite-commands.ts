import fs from 'node:fs';
import path from 'node:path';
import { DelegatedAccess, NodeWasmBindings, deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import type { TinyCloudNode, TinyCloudSession } from '@tinycloud/node-sdk';
import type { ParsedArgs } from './args.js';
import { PEER_DELEGATION_MAX_MS, bareDid, durationMs } from './authority.js';
import { acceptA, acceptC, ctx, fail, newAgentKey, printJson } from './commands.js';
import { credentialSourceFromArgs } from './credential-source.js';
import { CourierError } from './errors.js';
import { ed25519DidKey } from './did-key.js';
import { buildHello, buildInviteBlob, newInviteId } from './invite-blob.js';
import {
  deleteSealed, fetchSealed, formatInviteString, inviteOrigin, openInvitation, parseInviteString,
  sealInvitation, uploadSealed, type UploadedInvite,
} from './invite-link.js';
import { publicInvitesDir, updatePublicInvite, writePublicInvite } from './invite-public.js';
import { emailAddress, inviteFolder, parseInviteBlob, parseWelcome, type InviteBlob, type OneTimeKey } from './invite-schema.js';
import { artifactA, validateArtifactIdentity } from './pairing.js';
import { HANDLE } from './request.js';
import { cmd } from './program.js';
import { credentialDigest, oneTimeKeyHash, signPossession, verifyPossession } from './possession.js';
import { loadKey, saveProfile, secureSubdir, writeSecure, type Profile } from './profile.js';
import { delIfPresent, getJson, putCreate } from './store.js';

const INVITE_ID = /^[a-z2-7]{26}$/;
const TIERS = ['strict', 'trusted'] as const;
const DEFAULT_TTL = '24h';
const WELCOME_POLL_MS = 30_000;
const WELCOME_WAIT_MS = 10 * 60_000;

type Tier = (typeof TIERS)[number];
type Entries = Parameters<TinyCloudNode['delegateTo']>[1];

/** Owner-side record of an invite. Holds the store delete token: never printed. */
interface InviteRecord {
  v: 1;
  inviteId: string;
  handle: string;
  callMe: string;
  email: string;
  /** Requested tier only. The paired peer starts strict; the owner confirms trusted by hand. */
  tier: Tier;
  alsoAsk: boolean;
  expiresAt: string;
  store: { id: string; cid: string; deleteToken: string };
  status: 'open' | 'consumed' | 'revoked';
  publicDir?: string;
}

/** Invitee-side join state. `d` of the one-time key lives inside `blob`: this file is 0600. */
interface JoinState {
  v: 1;
  inviteId: string;
  blob: string;
  helloText: string;
  stage: 'hello-ready' | 'hello-sent';
}

const inviteUsage = () => `Usage: ${cmd('invite <handle> --email <address> [--tier strict|trusted] [--ttl 24h] [--call-me <handle>] [--also-ask] [--invites-public-dir d]')}`;

function requireInviteId(id: string | undefined, usage: string): string {
  if (id === undefined || !INVITE_ID.test(id)) fail('usage', `Invite id is 26 characters from a-z and 2-7. ${usage}`);
  return id;
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

const recordPath = (id: string) => path.join(secureSubdir('invites'), `${id}.json`);
const readRecord = (id: string) => readJson<InviteRecord>(recordPath(id));
const writeRecord = (record: InviteRecord) => writeSecure(recordPath(record.inviteId), record);

const joinPath = (id: string) => path.join(secureSubdir('joins'), `${id}.json`);
const readJoin = (id: string) => readJson<JoinState>(joinPath(id));
const writeJoin = (state: JoinState) => writeSecure(joinPath(state.inviteId), state);
const removeJoin = (id: string) => fs.rmSync(joinPath(id), { force: true });

function listJoins(): JoinState[] {
  const dir = secureSubdir('joins');
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).flatMap((n) => {
    const state = readJson<JoinState>(path.join(dir, n));
    return state ? [state] : [];
  });
}

/** The one-time key as stored in the blob: public `x` and private `d`, nothing else. */
function toOneTimeKey(jwk: unknown): OneTimeKey {
  const { x, d } = jwk as { x?: unknown; d?: unknown };
  if (typeof x !== 'string' || typeof d !== 'string') fail('internal', 'One-time key is not an Ed25519 JWK with d.');
  return { kty: 'OKP', crv: 'Ed25519', x, d };
}

export async function cmdInvite(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub === 'list') return inviteList();
  if (sub === 'revoke') return inviteRevoke(args.positional[1]);
  return inviteCreate(args);
}

async function inviteCreate(args: ParsedArgs): Promise<void> {
  const handle = args.positional[0] ?? fail('usage', inviteUsage());
  const { profile, node } = await ctx();
  const spaceId = profile.spaceId ?? fail('no-space', `No TinyCloud space yet; run \`${cmd('init')}\` first.`);
  if (!HANDLE.test(handle)) fail('usage', `Handles are letters, digits, "-" or "_", not starting with "_" (got "${handle}").`);
  const emailArg = args.get('email');
  if (emailArg === undefined || emailArg === 'true') fail('usage', `--email <address> is required. ${inviteUsage()}`);
  const expectEmail = emailAddress(emailArg.trim().toLowerCase(), '--email');
  const tier = args.get('tier') ?? 'strict';
  if (!(TIERS as readonly string[]).includes(tier)) fail('usage', '--tier must be strict or trusted.');
  const callMe = args.get('call-me') ?? profile.selfHandle ?? handle;
  if (!HANDLE.test(callMe)) fail('usage', `Handles are letters, digits, "-" or "_", not starting with "_" (got "${callMe}").`);
  const ttl = args.get('ttl') ?? DEFAULT_TTL;
  const ttlMs = durationMs(ttl);
  if (ttlMs === undefined || ttlMs <= 0 || ttlMs > PEER_DELEGATION_MAX_MS) {
    fail('usage', `--ttl must be a duration like 24h, at most 7d (got "${ttl}").`);
  }
  const publicDir = publicInvitesDir(args.get('invites-public-dir'), process.env.COURIER_INVITES_PUBLIC_DIR);
  const existing = profile.peers[handle];
  if (existing) fail('usage', `Peer "${handle}" already exists (${existing.status}); revoke it first.`);

  const oneTime = newAgentKey();
  const oneTimeKey = toOneTimeKey(oneTime.jwk);
  if (bareDid(oneTime.did) !== ed25519DidKey(oneTimeKey.x)) fail('internal', 'One-time key DID does not match its Ed25519 public key.');

  const inviteId = newInviteId();
  const expiresAt = new Date(Date.now() + ttlMs);
  const createdAt = new Date().toISOString();
  const folder = inviteFolder(inviteId);
  const delegate = (entries: Entries) => node.delegateTo(bareDid(oneTime.did), entries, { expiry: ttl });

  profile.peers[handle] = {
    handle, ownerDid: '', courierDid: '', spaceId: '', outbound: [],
    theirHandleForMe: handle, status: 'pending-A', pairedAt: new Date().toISOString(),
  };
  saveProfile(profile);

  let uploaded: UploadedInvite | undefined;
  let recordWritten = false;
  try {
    const put = await delegate([{ space: spaceId, service: 'tinycloud.kv', path: `${folder}in/hello.json`, actions: ['tinycloud.kv/put'] }]);
    const read = await delegate([{ space: spaceId, service: 'tinycloud.kv', path: `${folder}out/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] }]);
    const hooks = await delegate([{ space: spaceId, service: 'tinycloud.hooks', path: `kv/${folder}out`, actions: ['tinycloud.hooks/subscribe'] }]);

    const blob = buildInviteBlob({
      inviteId,
      host: profile.host,
      spaceId,
      oneTimeKey,
      permissions: {
        put: serializeDelegation(put.delegation),
        read: serializeDelegation(read.delegation),
        hooks: serializeDelegation(hooks.delegation),
      },
      artifactA: artifactA(profile, handle, callMe),
      expiresAt,
      expectEmail,
    });
    const seal = sealInvitation(new TextEncoder().encode(blob));
    uploaded = await uploadSealed(inviteOrigin(), seal.sealed, expiresAt);
    writeRecord({
      v: 1,
      inviteId,
      handle,
      callMe,
      email: expectEmail,
      tier: tier as Tier,
      alsoAsk: args.has('also-ask'),
      expiresAt: expiresAt.toISOString(),
      store: { id: uploaded.id, cid: uploaded.cid, deleteToken: uploaded.deleteToken },
      status: 'open',
      publicDir,
    });
    recordWritten = true;
    if (publicDir !== undefined) {
      writePublicInvite(publicDir, {
        v: 1, inviteId, handle, expectEmail, expectOwner: null, tier, createdAt,
        expiresAt: expiresAt.toISOString(), status: 'open', completedPeer: null,
      });
    }
    console.log(`Invite for ${expectEmail} as "${handle}" (requested tier ${tier}; the peer starts strict until you confirm), expires ${expiresAt.toISOString()}.`);
    console.log('Send this string to the invitee. It is a bearer link: keep it private until revoked or expired.');
    console.log(formatInviteString({ id: uploaded.id, key: seal.key, cid: uploaded.cid }));
  } catch (e) {
    if (recordWritten) fs.rmSync(recordPath(inviteId), { force: true });
    delete profile.peers[handle];
    saveProfile(profile);
    if (uploaded) await deleteSealed(inviteOrigin(), uploaded.id, uploaded.deleteToken).catch(() => undefined);
    throw e;
  }
}

function inviteList(): void {
  const now = Date.now();
  const dir = secureSubdir('invites');
  const rows = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().flatMap((n) => {
    const r = readJson<InviteRecord>(path.join(dir, n));
    return r ? [r] : [];
  });
  printJson(rows.map((r) => ({
    inviteId: r.inviteId,
    handle: r.handle,
    callMe: r.callMe,
    email: r.email,
    tier: r.tier,
    alsoAsk: r.alsoAsk,
    expiresAt: r.expiresAt,
    status: r.status === 'open' && Date.parse(r.expiresAt) <= now ? 'expired' : r.status,
  })));
}

async function inviteRevoke(id: string | undefined): Promise<void> {
  const inviteId = requireInviteId(id, `Usage: ${cmd('invite revoke <invite-id>')}`);
  const record = readRecord(inviteId) ?? fail('usage', `No invite ${inviteId} on this machine.`);
  if (record.status === 'revoked') {
    if (record.publicDir !== undefined) updatePublicInvite(record.publicDir, inviteId, { status: 'revoked' });
    console.log(`Invite ${inviteId} is already revoked.`);
    return;
  }
  if (record.status === 'consumed') {
    fail('invite-not-open', `Invite ${inviteId} was already used; use \`${cmd('revoke <peer>')}\` to drop the peer.`);
  }
  const { profile, node } = await ctx();
  try {
    await deleteSealed(inviteOrigin(), record.store.id, record.store.deleteToken);
  } catch (e) {
    if (!(e instanceof CourierError && e.code === 'invite-gone')) throw e;
  }
  const folder = inviteFolder(inviteId);
  await delIfPresent(node.kv, `${folder}in/hello.json`);
  await delIfPresent(node.kv, `${folder}out/welcome.json`);
  record.status = 'revoked';
  writeRecord(record);
  if (record.publicDir !== undefined) updatePublicInvite(record.publicDir, inviteId, { status: 'revoked' });
  if (profile.peers[record.handle]?.status === 'pending-A') {
    delete profile.peers[record.handle];
    saveProfile(profile);
  }
  console.log(`Revoked invite ${inviteId}.`);
}

export async function cmdJoin(args: ParsedArgs): Promise<void> {
  if (args.has('resume')) return joinResume(args);
  return joinStart(args, readInviteArg(args));
}

/**
 * The invite string comes from `--stdin` or `--file`. The positional form still works, but argv is visible in `ps`.
 */
export function readInviteArg(args: ParsedArgs): string {
  const file = args.get('file');
  const stdin = args.has('stdin');
  const positional = args.positional[0];
  if ([stdin, file !== undefined, positional !== undefined].filter(Boolean).length > 1) {
    fail('usage', 'Give the invite string once: as an argument, with --file, or with --stdin.');
  }
  if (stdin) {
    if (args.has('credential-stdin')) fail('usage', '--stdin and --credential-stdin both read stdin; put one of them in a --file.');
    return fs.readFileSync(0, 'utf8').trim();
  }
  if (file !== undefined) {
    if (file === 'true') fail('usage', '--file needs a path.');
    return fs.readFileSync(file, 'utf8').trim();
  }
  return positional ?? fail('usage', `Usage: ${cmd('join --stdin | --file f | <invite-string> [--credential-file f | --credential-stdin]')}`);
}

/** Refuses blobs for another host or for this agent's own identity. Shared by start and resume. */
function checkBlob(profile: Profile, blob: InviteBlob): void {
  if (blob.host.replace(/\/$/, '') !== profile.host.replace(/\/$/, '')) {
    fail('host-mismatch', `Invite is for ${blob.host}; this courier is on ${profile.host}.`);
  }
  validateArtifactIdentity(blob.artifactA);
  if (blob.artifactA.step !== 'A') fail('bad-invite', 'Invite does not carry pairing artifact A.');
  if (blob.artifactA.from.owner === profile.ownerDid || blob.artifactA.from.courier === profile.courierDid) {
    fail('bad-artifact', 'Refusing to pair with this agent identity.');
  }
}

async function joinStart(args: ParsedArgs, input: string): Promise<void> {
  const { profile, node } = await ctx();
  const parts = parseInviteString(input);
  const credentials = credentialSourceFromArgs(args);
  const sealed = await fetchSealed(inviteOrigin(), parts.id, parts.cid);
  const blobText = Buffer.from(openInvitation(sealed, parts.key)).toString('utf8');
  const blob = parseInviteBlob(blobText);
  checkBlob(profile, blob);
  if (readJoin(blob.inviteId)) {
    fail('join-exists', `A join for this invite is already pending; run \`${cmd(`join --resume ${blob.inviteId}`)}\`.`);
  }
  if (profile.peers[blob.artifactA.callMe]) {
    fail('usage', `Peer "${blob.artifactA.callMe}" already exists; this invite would use the same handle.`);
  }

  const credential = credentials
    ? await credentials.getEmailProof(blob.expectEmail, { courierDid: profile.courierDid, inviteId: blob.inviteId })
    : undefined;
  const now = Date.now();
  const possession = credential === undefined ? undefined : possessionFor(blob, profile.courierDid, credential, now);
  const artifactB = await acceptA(profile, node, blob.artifactA);
  let state: JoinState;
  try {
    state = {
      v: 1,
      inviteId: blob.inviteId,
      blob: blobText,
      helloText: buildHello({
        inviteId: blob.inviteId,
        artifactB,
        claimedLabel: profile.label,
        credential,
        possession,
        sentAt: new Date(now),
      }),
      stage: 'hello-ready',
    };
    writeJoin(state);
  } catch (err) {
    delete profile.peers[blob.artifactA.callMe];
    saveProfile(profile);
    throw err;
  }
  await sendHello(blob, state);
  await driveJoin(profile, node, blob, state);
}

async function joinResume(args: ParsedArgs): Promise<void> {
  const usage = `Usage: ${cmd('join --resume [invite-id]')}`;
  const { profile, node } = await ctx();
  const given = args.positional[0];
  let state: JoinState;
  if (given !== undefined) {
    state = readJoin(requireInviteId(given, usage)) ?? fail('usage', `No pending join ${given}.`);
  } else {
    const pending = listJoins();
    if (pending.length === 0) fail('usage', 'No pending join.');
    if (pending.length > 1) fail('usage', `Several pending joins (${pending.map((s) => s.inviteId).join(', ')}); pass one invite id.`);
    state = pending[0];
  }
  const blob = parseInviteBlob(state.blob);
  checkBlob(profile, blob);
  await sendHello(blob, state);
  await driveJoin(profile, node, blob, state);
}

let wasm: NodeWasmBindings | undefined;

/** Holds the one-time key. Only the `put` (hello) and `read` (out/) delegations are used by join. */
function oneTimeKv(blob: InviteBlob, which: 'put' | 'read') {
  const delegation = deserializeDelegation(blob.permissions[which]);
  if (delegation.spaceId !== blob.spaceId) fail('bad-invite', 'Invite delegation space does not match the invite.');
  const did = ed25519DidKey(blob.oneTimeKey.x);
  const session: TinyCloudSession = {
    address: delegation.ownerAddress,
    chainId: delegation.chainId,
    sessionKey: JSON.stringify(blob.oneTimeKey),
    spaceId: delegation.spaceId,
    delegationCid: delegation.cid,
    delegationHeader: delegation.delegationHeader,
    verificationMethod: `${did}#${did.slice('did:key:'.length)}`,
    jwk: blob.oneTimeKey as never,
    siwe: '',
    signature: '',
  };
  wasm ??= new NodeWasmBindings();
  return new DelegatedAccess(session, delegation, blob.host, wasm.invoke, wasm.invokeAny).kv;
}

/** Side effects of the join state machine. Production uses the real store and accept; tests inject fakes. */
export interface JoinIO {
  kv(blob: InviteBlob, which: 'put' | 'read'): Parameters<typeof getJson>[0];
  acceptC: typeof acceptC;
  pollMs: number;
  waitMs: number;
}

const productionIO: JoinIO = { kv: oneTimeKv, acceptC, pollMs: WELCOME_POLL_MS, waitMs: WELCOME_WAIT_MS };

function possessionFor(blob: InviteBlob, holderDid: string, credential: string, now: number): string {
  const key = loadKey();
  const sig = signPossession(
    { inviteId: blob.inviteId, oneTimeKeyX: blob.oneTimeKey.x, credential },
    key.jwk as Record<string, unknown>,
    now,
  );
  const check = verifyPossession(
    sig,
    { inviteId: blob.inviteId, oneTimeKeyHash: oneTimeKeyHash(blob.oneTimeKey.x), credentialDigest: credentialDigest(credential) },
    holderDid,
    now,
  );
  if (!check.ok) throw new CourierError('internal', `Possession self-check failed: ${check.reason}`);
  return sig;
}

/** Writes hello once. Create-only: a conflict means an earlier attempt already landed. */
export async function sendHello(blob: InviteBlob, state: JoinState, io: JoinIO = productionIO): Promise<void> {
  if (state.stage === 'hello-sent') return;
  try {
    await putCreate(io.kv(blob, 'put'), blob.helloKey, JSON.parse(state.helloText));
  } catch (e) {
    if (!(e instanceof CourierError && e.code === 'conflict')) throw e;
  }
  state.stage = 'hello-sent';
  writeJoin(state);
}

/** Polls out/welcome.json until the inviter answers, the invite expires, or the wait cap passes. */
export async function driveJoin(profile: Profile, node: TinyCloudNode, blob: InviteBlob, state: JoinState, io: JoinIO = productionIO): Promise<void> {
  const deadline = Math.min(Date.now() + io.waitMs, Date.parse(blob.expiresAt));
  const kv = io.kv(blob, 'read');
  for (;;) {
    const got = await getJson(kv, `${blob.outPrefix}welcome.json`);
    if (got) {
      const welcome = parseWelcome(JSON.stringify(got.value));
      if (welcome.inviteId !== blob.inviteId) fail('bad-welcome', 'Welcome is for a different invite.');
      if (welcome.tier === 'rejected') {
        removeJoin(state.inviteId);
        console.log('The inviter declined this invite.');
        return;
      }
      if (welcome.artifactC === undefined) fail('bad-welcome', 'Welcome has no pairing artifact C.');
      printJson(await io.acceptC(profile, node, welcome.artifactC));
      removeJoin(state.inviteId);
      return;
    }
    if (Date.now() + io.pollMs >= deadline) {
      console.log(`No reply yet. Run \`${cmd(`join --resume ${blob.inviteId}`)}\` to keep waiting.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
  }
}
