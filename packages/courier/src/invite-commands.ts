import fs from 'node:fs';
import path from 'node:path';
import { DelegatedAccess, NodeWasmBindings, deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import type { TinyCloudNode, TinyCloudSession } from '@tinycloud/node-sdk';
import type { ParsedArgs } from './args.js';
import { bareDid } from './authority.js';
import { acceptA, acceptC, ctx, fail, newAgentKey, printJson } from './commands.js';
import { credentialSourceFromArgs } from './invite-credential-source.js';
import { CourierError } from './errors.js';
import { ed25519DidKey } from './did-key.js';
import { buildHello, buildInviteBlob, newInviteId } from './invite-blob.js';
import { inviteEmailHash } from './invite-email-hash.js';
import {
  createInviteLink, deleteInviteLink, inviteTtl, linksConfig, newInviteLinkKey, resolveInviteLink,
  type CreatedInviteLink, type LinksConfig, type StoredLink,
} from './invite-links.js';
import { publicInvitesDir, updatePublicInvite, writePublicInvite, type PublicInvite } from './invite-public.js';
import { emailAddress, inviteFolder, isOwnerDid, ownerMatches, parseInviteBlob, parseWelcome, type InviteBlob, type OneTimeKey, type RequestedTier } from './invite-schema.js';
import { artifactA, validateArtifactIdentity } from './pairing.js';
import { proveInviter, type ProofDeps } from './invite-proof.js';
import { HANDLE } from './request.js';
import { cmd } from './program.js';
import { credentialDigest, oneTimeKeyHash, signPossession, verifyPossession } from './possession.js';
import { loadKey, saveProfile, secureSubdir, writeSecure, type Profile } from './profile.js';
import { delIfPresent, getJson, putCreate } from './store.js';
import { assertNoPeersEntry } from './peers-guard.js';
import { grantNote, possibleGrants, type PossibleGrant } from './grant-record.js';
import { InviteWatcher, describeHeld, heldFactsText, ownerConfirms, peersMessage, eventLog, listRecords, peersEntryProblem, peersFilesFor, readJson, readRecord, reasonOf, recordPath, requestedTier, writeRecord, type AcceptedTier, type InviteRecord, type PeersFile } from './invite-watch.js';
import { isRecord } from './a2a.js';
import { jsonLineLog } from './wake.js';

const INVITE_ID = /^[a-z2-7]{26}$/;
const TIERS = ['strict', 'trusted'] as const;
const WELCOME_POLL_MS = 30_000;
const WELCOME_WAIT_MS = 10 * 60_000;

type Entries = Parameters<TinyCloudNode['delegateTo']>[1];


/** Invitee-side join state. `d` of the one-time key lives inside `blob`: this file is 0600. */
interface JoinState {
  v: 1;
  inviteId: string;
  blob: string;
  helloText: string;
  /** `hello-unconfirmed`: a hello was already stored that could not be confirmed as ours; only a verified Welcome ends the wait. Never re-puts. */
  stage: 'hello-ready' | 'hello-sent' | 'hello-unconfirmed';
  /** Stable code of the first Welcome that arrived in `hello-unconfirmed` and did not verify for this courier. Never message text. */
  welcomeFailure?: string;
}

/** Printed by `invite` above the string, and repeated in the README. Tests pin these lines. */
export const INVITE_GUIDANCE: readonly string[] = [
  'Send this string to the invitee. It is a bearer link: keep it private until revoked or expired.',
  'Send it by a different channel than the invited email address. If it goes by email, add --also-ask or --expect-owner so a mailbox alone cannot pair.',
  'Anyone who holds the link can read your owner address, space and handles until it expires. The invitee address is stored as a salted hash.',
];

/** What `invite` prints on success, on stdout: the summary, the guidance, then the invite string last. */
export function printInviteCreated(input: { expectEmail: string; handle: string; tier: RequestedTier; expiresAt: Date; invite: string }, out: (line: string) => void = console.log): void {
  out(`Invite for ${input.expectEmail} as "${input.handle}" (requested tier ${input.tier}; the peer starts strict until you confirm), expires ${input.expiresAt.toISOString()}.`);
  for (const line of INVITE_GUIDANCE) out(line);
  out(input.invite);
}

const inviteUsage = () => `Usage: ${cmd('invite <handle> --email <address> [--tier strict|trusted] [--expect-owner <did>] [--ttl 24h] [--call-me <handle>] [--also-ask] [--invites-public-dir d] [--peers-file f]')}`;

/** Owner and tier flags. No flags: no owner check, strict. `--tier trusted` is a request the owner confirms by hand. */
export function requestedOwnerAndTier(args: ParsedArgs): { tier: RequestedTier; expectOwner: string | null } {
  const tier = args.get('tier') ?? 'strict';
  if (!(TIERS as readonly string[]).includes(tier)) fail('usage', '--tier must be strict or trusted.');
  const owner = args.get('expect-owner');
  if (owner === undefined) return { tier: tier as RequestedTier, expectOwner: null };
  if (!isOwnerDid(owner)) fail('usage', '--expect-owner must be a DID of the form did:pkh:eip155:<chain>:0x<address>.');
  return { tier: tier as RequestedTier, expectOwner: owner };
}

function requireInviteId(id: string | undefined, usage: string): string {
  if (id === undefined || !INVITE_ID.test(id)) fail('usage', `Invite id is 26 characters from a-z and 2-7. ${usage}`);
  return id;
}

/** What `invite` builds at create time: the tier as requested on the command line, `null` for no owner check. */
interface CreatedInviteRecord {
  v: 1;
  inviteId: string;
  handle: string;
  callMe: string;
  email: string;
  tier: RequestedTier;
  expectOwner: string | null;
  alsoAsk: boolean;
  expiresAt: string;
  link: StoredLink;
  status: 'open';
  publicDir?: string;
}

/** Owner-side private record and public copy for one invite. Both carry the requested tier and owner DID that the blob carries. */
export function inviteRecordsFor(input: {
  inviteId: string; handle: string; callMe: string; expectEmail: string;
  tier: RequestedTier; expectOwner: string | null; alsoAsk: boolean;
  expiresAt: Date; createdAt: string;
  link: StoredLink;
  publicDir: string | undefined;
}): { record: CreatedInviteRecord; publicRecord: PublicInvite } {
  const expiresAt = input.expiresAt.toISOString();
  return {
    record: {
      v: 1, inviteId: input.inviteId, handle: input.handle, callMe: input.callMe, email: input.expectEmail,
      expectOwner: input.expectOwner, tier: input.tier, alsoAsk: input.alsoAsk, expiresAt,
      link: { id: input.link.id, cid: input.link.cid, issuer: input.link.issuer, seed: input.link.seed, ...(input.link.apiOrigin === undefined ? {} : { apiOrigin: input.link.apiOrigin }) },
      status: 'open', publicDir: input.publicDir,
    },
    publicRecord: {
      v: 1, inviteId: input.inviteId, handle: input.handle, expectEmailHash: inviteEmailHash(input.inviteId, input.expectEmail),
      expectOwner: input.expectOwner, tier: input.tier, createdAt: input.createdAt,
      expiresAt, status: 'open', completedPeer: null,
    },
  };
}

/** The record the watcher reads: the requested tier in its stored form (`requestedTier`), no `expectOwner` key when there is no owner check, and the one-time key hash. */
export function storedRecord(created: CreatedInviteRecord, keyHash: string): InviteRecord {
  const { expectOwner, tier, ...rest } = created;
  return { ...rest, tier: requestedTier(tier), oneTimeKeyHash: keyHash, ...(expectOwner === null ? {} : { expectOwner }) };
}

/** The state file of an invite. The id must be a well-formed invite id: nothing else is ever turned into a path. */
const joinPath = (id: string) => {
  if (!INVITE_ID.test(id)) fail('internal', 'Join state has an invalid invite id.');
  return path.join(secureSubdir('joins'), `${id}.json`);
};
/** Reads the state of a join. A file that is not an object, or whose in-file id is not the id it was asked for, is refused and nothing is changed. */
export function readJoin(id: string): JoinState | undefined {
  const state: unknown = readJson<unknown>(joinPath(id));
  if (state === undefined) return undefined;
  if (typeof state !== 'object' || state === null || !('inviteId' in state) || state.inviteId !== id) {
    fail('bad-join-state', `The join state file for ${id} is not that invite's join state; it was not used.`);
  }
  return state as JoinState;
}
const writeJoin = (state: JoinState) => writeSecure(joinPath(state.inviteId), state);
const removeJoin = (id: string) => fs.rmSync(joinPath(id), { force: true });

/** Join state files by NAME: regular files called `<invite-id>.json`. A symlink or any other name is skipped. */
function joinFiles(): { id: string; file: string }[] {
  const dir = secureSubdir('joins');
  return fs.readdirSync(dir).flatMap((name) => {
    const match = /^([a-z2-7]{26})\.json$/.exec(name);
    const file = path.join(dir, name);
    return match && fs.lstatSync(file).isFile() ? [{ id: match[1], file }] : [];
  });
}

/** Pending joins. The id inside a file must be the one in its name. */
function listJoins(): JoinState[] {
  return joinFiles().flatMap(({ id, file }) => {
    const state = readJson<JoinState>(file);
    return state?.inviteId === id ? [state] : [];
  });
}

/** The one-time key as stored in the blob: public `x` and private `d`, nothing else. */
function toOneTimeKey(jwk: unknown): OneTimeKey {
  const { x, d } = jwk as { x?: unknown; d?: unknown };
  if (typeof x !== 'string' || typeof d !== 'string') fail('internal', 'One-time key is not an Ed25519 JWK with d.');
  return { kty: 'OKP', crv: 'Ed25519', x, d };
}

/** Test seams of `invite` (create): the profile and node it runs with, the links client and the clock. */
export interface InviteCreateDeps {
  ctx: typeof ctx;
  links?: LinksConfig;
  now?: () => number;
}

export async function cmdInvite(args: ParsedArgs, deps: InviteCreateDeps = { ctx }): Promise<void> {
  const sub = args.positional[0];
  if (sub === 'list') return inviteList();
  if (sub === 'revoke') return inviteRevoke(args.positional[1]);
  if (sub === 'approve') return inviteApprove(args);
  if (sub === 'deny') return inviteDeny(args.positional[1]);
  return inviteCreate(args, deps);
}

async function inviteCreate(args: ParsedArgs, deps: InviteCreateDeps): Promise<void> {
  const handle = args.positional[0] ?? fail('usage', inviteUsage());
  const peersProblem = peersEntryProblem(handle, peersFilesFor(args.get('peers-file')));
  if (peersProblem !== undefined) fail(peersProblem, peersMessage(peersProblem));
  const { tier, expectOwner } = requestedOwnerAndTier(args);
  // The life is checked before the node is reached, a key is made or anything is requested.
  const ttl = inviteTtl(args.get('ttl'));
  const { profile, node } = await deps.ctx();
  const links = deps.links ?? linksConfig();
  const spaceId = profile.spaceId ?? fail('no-space', `No TinyCloud space yet; run \`${cmd('init')}\` first.`);
  if (!HANDLE.test(handle)) fail('usage', `Handles are letters, digits, "-" or "_", not starting with "_" (got "${handle}").`);
  const emailArg = args.get('email');
  if (emailArg === undefined || emailArg === 'true') fail('usage', `--email <address> is required. ${inviteUsage()}`);
  const expectEmail = emailAddress(emailArg.trim().toLowerCase(), '--email');

  const callMe = args.get('call-me') ?? profile.selfHandle ?? handle;
  if (!HANDLE.test(callMe)) fail('usage', `Handles are letters, digits, "-" or "_", not starting with "_" (got "${callMe}").`);
  const publicDir = publicInvitesDir(args.get('invites-public-dir'), process.env.COURIER_INVITES_PUBLIC_DIR);
  const existing = profile.peers[handle];
  if (existing) fail('usage', `Peer "${handle}" already exists (${existing.status}); revoke it first.`);

  const oneTime = newAgentKey();
  const oneTimeKey = toOneTimeKey(oneTime.jwk);
  if (bareDid(oneTime.did) !== ed25519DidKey(oneTimeKey.x)) fail('internal', 'One-time key DID does not match its Ed25519 public key.');
  // A throwaway signing key for this invitation's link only: never the agent's key, never reused. Its seed goes into the private record, nowhere else.
  const linkKey = newInviteLinkKey();

  const inviteId = newInviteId();
  const nowMs = (deps.now ?? Date.now)();
  const expiresAt = new Date(nowMs + ttl.ms);
  const createdAt = new Date(nowMs).toISOString();
  const folder = inviteFolder(inviteId);
  const delegate = (entries: Entries) => node.delegateTo(bareDid(oneTime.did), entries, { expiry: ttl.text });

  profile.peers[handle] = {
    handle, ownerDid: '', courierDid: '', spaceId: '', outbound: [],
    theirHandleForMe: handle, status: 'pending-A', pairedAt: new Date(nowMs).toISOString(),
  };
  saveProfile(profile);

  let created: CreatedInviteLink | undefined;
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
      issuer: linkKey.signer.did,
      expectEmail,
      expectOwner,
      tier,
      now: nowMs,
    });
    created = await createInviteLink(links, { blobText: blob, expiresAt, key: linkKey, now: nowMs });
    const records = inviteRecordsFor({
      inviteId, handle, callMe, expectEmail, tier, expectOwner, alsoAsk: args.has('also-ask'),
      expiresAt, createdAt, link: created.stored, publicDir,
    });
    writeRecord(storedRecord(records.record, oneTimeKeyHash(oneTimeKey.x)));
    recordWritten = true;
    if (publicDir !== undefined) {
      try {
        writePublicInvite(publicDir, records.publicRecord);
      } catch (e) {
        console.error(`Public invite record not written (${reasonOf(e)}). The invite itself is unaffected.`);
      }
    }
    printInviteCreated({ expectEmail, handle, tier, expiresAt, invite: created.link });
  } catch (e) {
    if (recordWritten) fs.rmSync(recordPath(inviteId), { force: true });
    delete profile.peers[handle];
    saveProfile(profile);
    if (created) await deleteInviteLink(links, created.stored).catch(() => undefined);
    throw e;
  }
}

function inviteList(): void {
  const now = Date.now();
  printJson(listRecords().map((r) => ({
    inviteId: r.inviteId,
    handle: r.handle,
    callMe: r.callMe,
    email: r.email,
    tier: r.tier,
    alsoAsk: r.alsoAsk,
    expiresAt: r.expiresAt,
    status: (r.status === 'open' || r.status === 'held') && Date.parse(r.expiresAt) <= now ? 'expired' : r.status,
    // Read grants an abandoned attempt may have left (not revoked automatically): cid or `unknown`, the courier it was for, and when it ends at the latest.
    possibleGrants: possibleGrants(r.inviteId, now).map((g) => ({ cid: g.cid, peerCourierDid: g.peerCourierDid, notAfter: g.notAfter })),
    // A grant that may exist but could not be written down (no courier is known for it): only its latest end.
    ...(r.unrecordedGrantUntil && Date.parse(r.unrecordedGrantUntil) > now ? { unrecordedGrantUntil: r.unrecordedGrantUntil } : {}),
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
  if (record.status !== 'open' && record.status !== 'held') {
    fail('invite-not-open', `Invite ${inviteId} was already used (${record.status}); use \`${cmd('revoke <peer>')}\` to drop the peer.`);
  }
  const { profile, node } = await ctx();
  await inviteWatcher(profile, node).revoke(record);
  console.log(`Revoked invite ${inviteId}.`);
}

/** `peersFiles` is for the commands that pair (`approve`); revoke and deny never consult peers, so a bad peers path must not stop them. */
export function inviteWatcher(profile: Profile, node: TinyCloudNode, peersFiles?: readonly PeersFile[]): InviteWatcher {
  return new InviteWatcher({ node, profile: () => profile, log: eventLog(jsonLineLog((line) => process.stderr.write(line))), ...(peersFiles ? { peersFiles } : {}) });
}

/**
 * `trusted` is recorded as a request for you to decide on. It does not grant trust; the peer starts strict.
 * Before anything is paired the hello that is actually held is shown (its owner and courier DID, why it is held), and `--owner` must name that owner.
 */
async function inviteApprove(args: ParsedArgs): Promise<void> {
  const inviteId = requireInviteId(args.positional[1], `Usage: ${cmd('invite approve <invite-id> [--tier strict|trusted] [--peers-file f] --owner <did>')}`);
  const flag = args.get('tier');
  const tier = flag === undefined ? undefined : requestedTier(flag);
  const facts = describeHeld(inviteId);
  console.log(heldFactsText(facts));
  const owner = args.get('owner');
  if (owner === undefined || owner === 'true' || owner === '') {
    fail('usage', `Nothing was paired. Check that the owner above is the one you mean to pair, then run: ${cmd(`invite approve ${inviteId} --owner <that owner>`)}`);
  }
  if (!ownerConfirms(owner, facts.owner)) {
    fail('owner-mismatch', 'The owner you gave is not the owner of the hello that is held; nothing was paired. Run the command again with the owner shown above.');
  }
  const peersFiles = peersFilesFor(args.get('peers-file'));
  const { profile, node } = await ctx();
  const approved = await inviteWatcher(profile, node, peersFiles).approveHeld(inviteId, owner, tier);
  console.log(approveSummary(inviteId, approved, possibleGrants(inviteId, Date.now())));
}

/** What `invite approve` prints: the tier the record carries (the request, `trusted-requested` shown as `trusted`), not the flag. */
export function approveSummary(inviteId: string, tier: AcceptedTier, grants: readonly PossibleGrant[] = []): string {
  return [`Invite ${inviteId} paired. Requested tier: ${tier === 'trusted-requested' ? 'trusted' : tier}. The peer starts as strict until you confirm trusted status.`, ...grants.map(earlierGrantNote)].join('\n');
}

/** Said after approve or deny when an earlier, abandoned attempt may have left a read grant (not revoked automatically yet). */
const earlierGrantNote = (g: PossibleGrant): string => `Note: an earlier attempt may have left ${grantNote(g)}.`;

async function inviteDeny(id: string | undefined): Promise<void> {
  const inviteId = requireInviteId(id, `Usage: ${cmd('invite deny <invite-id>')}`);
  const { profile, node } = await ctx();
  await inviteWatcher(profile, node).deny(inviteId);
  console.log([`Invite ${inviteId} denied. The invitee receives a rejected Welcome and no artifact.`, ...possibleGrants(inviteId, Date.now()).map(earlierGrantNote)].join('\n'));
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

/**
 * What `join` shows before it does anything: the inviter named by the invitation (owner, handle, space). The link is a bearer string anyone can make, so the
 * person joining must say whom they expect. `--expect-inviter <owner did>` is required and must match; without it, or on a mismatch, nothing is sent and
 * the facts are printed with a command to run once the owner is confirmed with the inviter by another channel. The command carries a placeholder, never the
 * link's own owner value: the DID to pass comes from the inviter, not from the link. Returns the DID the person joining expects.
 */
export function requireExpectedInviter(args: ParsedArgs, blob: InviteBlob): string {
  const owner = blob.artifactA.from.owner;
  const facts = `This invitation names the inviter: owner ${owner}, handle "${blob.artifactA.callMe}", space ${blob.spaceId}.`;
  const rerun = `Ask the person who invited you for their owner address, by another channel (not from this link), then run: ${cmd('join --stdin --expect-inviter <did you expect>')} (the link on stdin, the same other flags).`;
  const expected = args.get('expect-inviter');
  if (expected === undefined || expected === 'true') {
    fail('inviter-unconfirmed', `${facts} Nothing was sent. --expect-inviter <owner did> is required. ${rerun}`);
  }
  if (!isOwnerDid(expected)) fail('usage', '--expect-inviter must be a DID of the form did:pkh:eip155:<chain>:0x<address>.');
  if (!ownerMatches(expected, owner)) {
    fail('inviter-mismatch', `${facts} That is not the inviter you expected (${expected}). Nothing was sent. ${rerun}`);
  }
  return expected;
}

/** The address the invitee says the invitation was made for, checked against the hash in the invitation. `undefined` when no address was given. */
function invitedAddress(args: ParsedArgs, blob: InviteBlob, needed: boolean): string | undefined {
  const given = args.get('email');
  if (given === undefined || given === 'true') {
    if (needed) fail('usage', '--email <address> is required with --credential-file or --credential-stdin: the address this invitation was made for.');
    return undefined;
  }
  const address = given.trim().toLowerCase();
  try {
    emailAddress(address, '--email');
  } catch {
    fail('usage', '--email must be an email address.');
  }
  if (inviteEmailHash(blob.inviteId, address) !== blob.expectEmailHash) {
    fail('invite-email-mismatch', 'That address is not the one this invitation was made for. Nothing was sent.');
  }
  return address;
}

/**
 * `deps.ctx` is a test seam: the profile and node a join runs with. `deps.links` and `deps.now` are test seams for the links client and its clock;
 * `deps.proof` is the seam for the activator the invitation's delegations are proven through (production activates them at the invitation's host).
 */
export async function joinStart(
  args: ParsedArgs,
  input: string,
  deps: { ctx: typeof ctx; links?: LinksConfig; now?: number; proof?: ProofDeps } = { ctx },
): Promise<void> {
  const peersFiles = peersFilesFor(args.get('peers-file'));
  const links = deps.links ?? linksConfig();
  const { profile, node } = await deps.ctx();
  const credentials = credentialSourceFromArgs(args);
  const { blob, blobText } = await resolveInviteLink(links, input, deps.now);
  checkBlob(profile, blob);
  const expectedInviter = requireExpectedInviter(args, blob);
  const address = invitedAddress(args, blob, credentials !== undefined);
  if (readJoin(blob.inviteId)) {
    fail('join-exists', `A join for this invite is already pending; run \`${cmd(`join --resume ${blob.inviteId}`)}\`.`);
  }
  // Nothing below this line may run for an invitation whose grants are not the named inviter's: no handle is claimed and no grant is made first.
  await proveInviter(node, blob, expectedInviter, deps.proof);
  claimCallMe(profile, blob, peersFiles);

  const credential = credentials && address !== undefined
    ? await credentials.getEmailProof(address, { courierDid: profile.courierDid, inviteId: blob.inviteId })
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
  const blob = resumeBlob(state);
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

/**
 * Checks that the handle this invite asks us to use for the inviter is free. A pairing with this same inviter that never completed (awaiting-C) is what an
 * earlier failed join left behind: the new invite replaces it and drops that join's state. A paired peer, or any other peer under the handle, still blocks.
 * The earlier join's outgoing read grant is no longer tracked and ends at its own expiry (at most 7 days).
 */
export function claimCallMe(profile: Profile, blob: InviteBlob, peersFiles: readonly PeersFile[] = peersFilesFor()): void {
  // The inviter picked this handle. A peers file that lists it would hand its trust setting to the new peer, so nothing is created.
  assertNoPeersEntry(blob.artifactA.callMe, peersFiles);
  const leftover = profile.peers[blob.artifactA.callMe];
  if (!leftover) return;
  const sameInviter = leftover.status === 'awaiting-C' && leftover.courierDid === blob.artifactA.from.courier && leftover.ownerDid === blob.artifactA.from.owner;
  if (!sameInviter) fail('usage', `Peer "${blob.artifactA.callMe}" already exists; this invite would use the same handle.`);
  dropStaleJoins(blob);
}

/** Removes pending joins of other invites from the same inviter under the same handle: their invites are closed once a newer one exists. */
function dropStaleJoins(blob: InviteBlob): void {
  for (const { id, file } of joinFiles()) {
    if (id === blob.inviteId) continue;
    try {
      // Only a file whose name and in-file id agree is looked at, and only that file (by name) is removed.
      const state = readJson<JoinState>(file);
      if (state?.inviteId !== id) continue;
      const parsed: unknown = JSON.parse(state.blob);
      const old = isRecord(parsed) && isRecord(parsed.artifactA) ? parsed.artifactA : undefined;
      const oldCourier = old !== undefined && isRecord(old.from) ? old.from.courier : undefined;
      if (old?.callMe === blob.artifactA.callMe && oldCourier === blob.artifactA.from.courier) fs.rmSync(file, { force: true });
    } catch {
      // A join file that does not parse is left for the owner.
    }
  }
}

/**
 * The blob of a pending join, ready to resume. An unconfirmed join cannot be waited on past the invite's expiry (the one-time key's read grant ends
 * with it), so a resume after expiry gets the `hello-exists` advice instead of the schema's "invite is expired".
 */
export function resumeBlob(state: JoinState, now: number = Date.now()): InviteBlob {
  const unconfirmed = state.stage === 'hello-unconfirmed';
  const blob = parseInviteBlob(state.blob, unconfirmed ? 0 : now);
  if (unconfirmed && Date.parse(blob.expiresAt) <= now) fail('hello-exists', helloUnconfirmedMessage(blob, state.welcomeFailure));
  return blob;
}

/** Codes of a Welcome that arrived and was checked and refused. Any other code (a network error, `rejected`) means it could not be confirmed. */
const VERIFICATION_FAILURES: Record<string, true> = { 'bad-delegation': true, 'bad-artifact': true, 'bad-welcome': true };
const welcomeProblem = (failure: string): string => (Object.hasOwn(VERIFICATION_FAILURES, failure) ? `does not verify for this courier (${failure})` : `could not be confirmed (${failure})`);

/** `failure` is the stable code of the first Welcome that arrived and was not accepted, when one did. */
const helloUnconfirmedMessage = (blob: InviteBlob, failure: string | undefined): string => {
  const advice = `Ask the inviter for a new invite; if that is refused with "already exists", ask them to run \`${cmd(`revoke ${blob.artifactA.peer}`)}\` first.`;
  return failure === undefined
    ? `Your hello could not be confirmed and no welcome was seen before the invite expired. ${advice}`
    : `Your hello could not be confirmed, and the welcome that arrived ${welcomeProblem(failure)}. ${advice}`;
};

/**
 * Writes hello once. Create-only. A conflict is accepted as sent only when the object already there is byte-for-byte this hello (an earlier attempt landed).
 * A different object, or one this key cannot read back, may be another writer's or our own whose response was lost: the join moves to hello-unconfirmed
 * and waits for a Welcome that acceptC verifies. It never writes over the stored object, and a resume never writes again.
 */
export async function sendHello(blob: InviteBlob, state: JoinState, io: JoinIO = productionIO): Promise<void> {
  if (state.stage === 'hello-sent' || state.stage === 'hello-unconfirmed') return;
  const hello: unknown = JSON.parse(state.helloText);
  try {
    await putCreate(io.kv(blob, 'put'), blob.helloKey, hello);
  } catch (e) {
    if (!(e instanceof CourierError && e.code === 'conflict')) throw e;
    let existing: unknown;
    try {
      existing = (await getJson(io.kv(blob, 'read'), blob.helloKey))?.value;
    } catch {
      existing = undefined;
    }
    if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(hello)) {
      state.stage = 'hello-unconfirmed';
      writeJoin(state);
      console.log("A hello is already stored for this invite and this machine cannot confirm it is its own. Waiting for the inviter's welcome; nothing is written over it.");
      return;
    }
  }
  state.stage = 'hello-sent';
  writeJoin(state);
}

/** Polls out/welcome.json until the inviter answers, the invite expires, or the wait cap passes. */
export async function driveJoin(profile: Profile, node: TinyCloudNode, blob: InviteBlob, state: JoinState, io: JoinIO = productionIO): Promise<void> {
  const unconfirmed = state.stage === 'hello-unconfirmed';
  const expiresAt = Date.parse(blob.expiresAt);
  const deadline = Math.min(Date.now() + io.waitMs, expiresAt);
  const kv = io.kv(blob, 'read');
  for (;;) {
    const got = await getJson(kv, `${blob.outPrefix}welcome.json`);
    if (got && unconfirmed) {
      // Our hello is not confirmed to be the one stored, so the Welcome may belong to someone else's hello. Only one that acceptC accepts
      // (this courier as audience, the pinned inviter as issuer) pairs; anything else is ignored and the wait goes on.
      let paired: Record<string, unknown> | undefined;
      let failure: string | undefined;
      try {
        const welcome = parseWelcome(JSON.stringify(got.value));
        if (welcome.inviteId !== blob.inviteId) failure = 'bad-welcome';
        else if (welcome.tier === 'rejected') failure = 'rejected';
        else if (welcome.artifactC === undefined) failure = 'bad-welcome';
        else paired = await io.acceptC(profile, node, welcome.artifactC);
      } catch (e) {
        failure = reasonOf(e);
      }
      if (paired !== undefined) {
        printJson(paired);
        removeJoin(state.inviteId);
        return;
      }
      if (failure !== undefined && state.welcomeFailure === undefined) {
        state.welcomeFailure = failure;
        writeJoin(state);
        console.log(`A welcome arrived but ${welcomeProblem(failure)}; still waiting.`);
      }
    } else if (got) {
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
      if (unconfirmed && Date.now() + io.pollMs >= expiresAt) fail('hello-exists', helloUnconfirmedMessage(blob, state.welcomeFailure));
      console.log(`No reply yet. Run \`${cmd(`join --resume ${blob.inviteId}`)}\` to keep waiting.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, io.pollMs));
  }
}
