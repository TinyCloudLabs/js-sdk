import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { emailProofDescriptor } from '@tinycloud/node-sdk/credentials';
import { createFileEmailProofPendingStore } from '@tinycloud/node-sdk/credential-pending-store';
import { completeAgentShareReceive, requestAgentShareEmailProof, resumeAgentShareReceive } from '@tinycloud/node-sdk/share-receive';
import type { AgentShareContent, PendingAgentShareReceive } from '@tinycloud/node-sdk/share-receive';
import { publishEmailShareV3 } from '@tinycloud/node-sdk/share-publish';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { deliverCredentialInvitation, prepareAddressedShare, ShareReceiveError } from '@tinycloud/share-sdk';
import { canonicalize, isEnvelopeDeliveryEmail } from '@tinycloud/share-envelope';
import type { ShareEnvelopeV3 } from '@tinycloud/share-envelope';
import { createLink, signerFromJwk } from '@tinycloud/share-envelope/links';
import type { Ed25519PrivateJwk } from '@tinycloud/share-envelope/links';
import { bareDid, holdsInvitationKeyAuthority } from './authority.js';
import { canonicalJson } from './canonical.js';
import { CourierError } from './errors.js';
import { PREFIX } from './keys.js';
import { holderFor, keepsPendingAfterFailure, mapEmailProofError, withStoreErrors } from './credential.js';
import type { Step } from './credential.js';
import { cmd } from './program.js';
import { courierNode } from './node.js';
import { loadKey, loadProfile, profileDir } from './profile.js';
import type { AgentKey, Profile } from './profile.js';
import { joinedAlready, parseInvitation } from './invitation.js';
import type { CourierInvitation } from './invitation.js';

const DEFAULT_SHARE_ORIGIN = 'https://share.tinycloud.xyz';
const DEFAULT_LINKS_API = 'https://api.tinycloud.xyz';
/** The mail text is the Share service's; this label is the only part Courier supplies. */
const DOCUMENT_NAME = 'Courier conversation';
const DELIVERY_WINDOW_MS = 10 * 60_000;
const POLICY_ACTIONS = ['tinycloud.kv/get', 'tinycloud.kv/metadata'] as ('tinycloud.kv/get' | 'tinycloud.kv/metadata')[];

export interface EmailInvitationDeps {
  fetch?: typeof fetch;
  shareOrigin?: string;
  linksApiOrigin?: string;
  now?: () => number;
  shareId?: () => string;
  /** The per-invitation approval's node: it alone creates the key and encrypts under it; everything else uses the main node. */
  keyNode?: Pick<TinyCloudNode, 'keys' | 'encryption' | 'getVerifiedSessionCapabilities'>;
}

interface ShareConfig { shareOrigin: string; registryOrigin: string; credentialsOrigin: string }

const envelopePath = (invitationId: string, shareId: string) => `${PREFIX}/to/invite-${invitationId}/envelope/${shareId}.json`;
export const newShareId = () => randomBytes(16).toString('hex');

/**
 * Refuse BEFORE anything is created unless this grant holds key.create and decrypt on exactly `share/<shareId>`.
 * Nothing here requests that authority: the grant only gains it from an owner approval for this key, which Courier has
 * no interface for yet, so today this only passes for a grant that already names the generated id.
 */
export function requireInvitationKeyAuthority(node: Pick<TinyCloudNode, 'getVerifiedSessionCapabilities'>, profile: Profile, shareId: string): void {
  if (!profile.ownerDid || !profile.spaceId) throw new CourierError('no-grant', 'No owner grant is installed.');
  if (!holdsInvitationKeyAuthority(node.getVerifiedSessionCapabilities(), profile.ownerDid, shareId)) {
    throw new CourierError('invite-authority-missing',
      "This Courier grant does not hold key.create and decrypt on this invitation's share key, so nothing was created: no pairing relay delegation, invitation state, Share key, link or email.");
  }
}

function canonicalOrigin(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new CourierError('share-config', `Share ${label} is unavailable.`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new CourierError('share-config', `Share ${label} is invalid.`); }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if ((parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) || parsed.origin !== value) throw new CourierError('share-config', `Share ${label} is invalid.`);
  return value;
}

/** The configured Share deployment: where the registry and the credentials service live. */
async function shareConfig(deps: EmailInvitationDeps): Promise<ShareConfig> {
  const origin = canonicalOrigin(deps.shareOrigin ?? process.env.COURIER_SHARE_ORIGIN ?? DEFAULT_SHARE_ORIGIN, 'origin');
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${origin}/.well-known/tinycloud-share/config.json`, {
      headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new CourierError('share-unavailable', 'The Share service is unavailable; no invitation was sent.'); }
  if (!response.ok) throw new CourierError('share-unavailable', 'The Share service is unavailable; no invitation was sent.');
  const value = await response.json() as Record<string, unknown>;
  if (value.version !== 'tinycloud.share/config-v2') throw new CourierError('share-config', 'Share public config version is unsupported.');
  return {
    shareOrigin: canonicalOrigin(value.shareOrigin, 'origin'),
    registryOrigin: canonicalOrigin(value.registryOrigin, 'registry origin'),
    credentialsOrigin: canonicalOrigin(value.credentialsOrigin, 'credentials origin'),
  };
}

/** Canonical form of a recipient address; Share and OpenCredentials bind the invitation to exactly this string. */
export function canonicalInviteEmail(address: string): string {
  try {
    const prepared = prepareAddressedShare({ target: { kind: 'email', address }, actions: ['read'], policyActions: POLICY_ACTIONS, filename: 'invitation.json' });
    if (prepared.target.kind === 'email') return prepared.target.address;
  } catch { /* fall through to the typed refusal */ }
  throw new CourierError('unsupported-recipient', 'Use a single plain email address, for example name@example.com.');
}

/**
 * Send one email-bound invitation through the existing Share path. The invitation body (with its pairing relay) is
 * encrypted under a fresh `share/<shareId>` key, registered as one path-bound, digested Share policy, and announced by
 * the OpenCredentials service. Only the verified mailbox holder can open it. The bearer link is never returned.
 */
export async function sendEmailInvitation(node: TinyCloudNode, profile: Profile, body: CourierInvitation, deps: EmailInvitationDeps = {}): Promise<{ shareId: string }> {
  const email = body.recipient;
  if (body.mode !== 'email' || email === undefined || email !== canonicalInviteEmail(email)) throw new CourierError('bad-invitation', 'Not an email invitation.');
  if (!profile.ownerDid || !profile.spaceId) throw new CourierError('no-grant', 'No owner grant is installed.');
  const shareId = (deps.shareId ?? newShareId)();
  const keyNode = deps.keyNode ?? node;
  if (!holdsInvitationKeyAuthority(keyNode.getVerifiedSessionCapabilities(), profile.ownerDid, shareId)) {
    // A direct caller that already ran `issueInvitation` has stored its state and issued the pairing relay delegation.
    // `cmdInvite` checks first (`requireInvitationKeyAuthority`), so it never reaches this branch.
    throw new CourierError('invite-authority-missing',
      `This Courier grant does not hold key.create and decrypt on this invitation's share key, so no Share key, link or email was created or sent. Already created before this check: a pairing relay delegation (expires ${body.expiresAt}) and invitation state ${body.id}, a record that stays in your Courier space (nothing deletes it).`);
  }
  const fetchFn = deps.fetch ?? fetch;
  const config = await shareConfig(deps);
  const identity = await node.activeNodeIdentity();
  const descriptor = await emailProofDescriptor(email, { fetch: deps.fetch });
  const keyPath = `share/${shareId}`;
  const network = node.getDefaultEncryptionNetworkId();
  await node.publishActiveNodeLocation(config.registryOrigin, fetchFn);
  await keyNode.keys.createKey(keyPath);
  const plaintext = new TextEncoder().encode(canonicalJson(body));
  const encrypted = await keyNode.encryption.encryptToNetwork(network, plaintext, { keyPath, metadata: { contentType: 'application/json' } });
  if (!encrypted.ok || encrypted.data.networkId !== network || encrypted.data.keyPath !== keyPath) throw new CourierError('encrypt-failed', 'The invitation could not be encrypted.');
  const storedBytes = new TextEncoder().encode(canonicalize(encrypted.data as unknown as Record<string, unknown>));
  const path = envelopePath(body.id, shareId);
  const stored = await node.kv.put(path, storedBytes, { contentType: 'application/vnd.tinycloud.encrypted-envelope+json' });
  if (!stored.ok) throw new CourierError('store-failed', 'The encrypted invitation could not be stored.');
  const prepared = prepareAddressedShare({ target: { kind: 'email', address: email }, actions: ['read'], policyActions: POLICY_ACTIONS, filename: 'invitation.json' });
  if (prepared.target.kind !== 'email') throw new CourierError('unsupported-recipient', 'Use a single plain email address.');
  const published = await publishEmailShareV3({
    shareId, shareOrigin: config.shareOrigin, nodeOrigin: identity.origin, nodeAudience: identity.nodeDid, enforcerDid: identity.nodeDid, spaceId: profile.spaceId,
    target: prepared.target, resource: { kind: 'exact', path }, actions: ['read'], policyActions: POLICY_ACTIONS,
    contentSource: {
      shareId, kvResource: `${profile.spaceId}/kv/${path}`, selector: 'exact', encryptionNetwork: encrypted.data.networkId, encryptionKeyPath: keyPath,
      // A path-bound source registers the digest of the RAW wrapped-key bytes.
      encryptedSymmetricKeyDigestHex: createHash('sha256').update(Buffer.from(encrypted.data.encryptedSymmetricKey, 'base64')).digest('hex'),
      keyVersion: encrypted.data.keyVersion, mode: 'immutable', initialCiphertextDigestHex: createHash('sha256').update(storedBytes).digest('hex'),
    },
    ...(isEnvelopeDeliveryEmail(email) ? { deliveryEmail: email } : {}),
    filename: 'invitation.json', mediaType: 'application/json', byteLength: plaintext.byteLength, expiresAt: new Date(body.expiresAt),
    authority: {
      ownerDid: node.credentialHolderDid,
      createOwnerRoot: (request) => node.createUnifiedOwnerRoot(request),
      sign: (bytes) => node.signSessionBytes(bytes),
      registerPolicy: (request) => node.registerPolicy(request),
    },
    credentialDescriptor: descriptor, issuerDid: descriptor.issuer.did, issuerKid: descriptor.issuer.kid,
  });
  const material = published.deliveryMaterial;
  if (material === undefined) throw new CourierError('share-publish-failed', 'The Share service returned no delivery material.');
  const now = new Date(deps.now?.() ?? Date.now());
  const short = await createLink({
    type: 'share', sealed: { blob: Buffer.from(material.sealedEnvelope, 'base64url'), key: Buffer.from(material.envelopeKey, 'base64url') },
    issuerKey: signerFromJwk(loadKey().jwk as unknown as Ed25519PrivateJwk), apiOrigin: deps.linksApiOrigin ?? process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API,
    linkOrigin: new URL(published.url).origin, expiresAt: new Date(published.metadata.expiresAt), now, fetch: fetchFn,
  });
  const receipt = await node.authorizeShareDeliveryV3({
    envelope: material.envelope as Parameters<typeof node.authorizeShareDeliveryV3>[0]['envelope'], resourcePath: path, recipientEmail: email, shareUrl: short.link,
    documentName: DOCUMENT_NAME, expiresAt: new Date(now.getTime() + DELIVERY_WINDOW_MS).toISOString(), deliveryAudience: config.credentialsOrigin,
    idempotencyKey: `courier-invitation-${body.id}`, trustedOrigins: [config.shareOrigin],
  });
  await deliverCredentialInvitation({
    credentialsOrigin: config.credentialsOrigin, receipt: { request: { ...receipt.request }, admission: { ...receipt.admission }, proof: { ...receipt.proof } }, shareUrl: short.link, fetchFn,
  });
  return { shareId };
}

/** The three Share-receive steps; the defaults are node-sdk's. A seam so the proof lifecycle is testable without a Share deployment. */
export interface ShareReceiveOps {
  request: typeof requestAgentShareEmailProof;
  resume: typeof resumeAgentShareReceive;
  complete: typeof completeAgentShareReceive;
}

export interface EmailReceiveDeps extends EmailInvitationDeps {
  home?: string;
  loadKey?: (home: string) => AgentKey;
  readStdinLine?: () => Promise<string>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  receive?: ShareReceiveOps;
  /** Test seam: how the profile's node is opened for the grant check. */
  node?: (profile: Profile, home: string) => Promise<TinyCloudNode>;
}

/** True for a Share link (`/s/…`); Courier's own `/c/` links take the existing path. */
export function isShareLink(link: string): boolean {
  try { return new URL(link).pathname.startsWith('/s/'); } catch { return false; }
}

/**
 * Open an email-bound invitation with this agent's own Courier key. Step 1 asks OpenCredentials to mail an 8-digit code
 * and stops; step 2 (`--code-stdin`) completes the proof, admits at the owner Node and decrypts the one invitation.
 * Returns the invitation body, or `undefined` after step 1.
 *
 * The pending proof follows `credential acquire`: it is kept only while the witness says the same request can take
 * another code (`EmailProofError.recoverable`), and deleted on a terminal failure, on any failure after the code was
 * accepted, and on success.
 */
export async function receiveEmailInvitation(link: string, withCode: boolean, deps: EmailReceiveDeps = {}): Promise<CourierInvitation | undefined> {
  const out = deps.out ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.err ?? ((text: string) => { process.stderr.write(text); });
  const home = deps.home ?? profileDir();
  const ops = deps.receive ?? { request: requestAgentShareEmailProof, resume: resumeAgentShareReceive, complete: completeAgentShareReceive };
  const config = await shareConfig(deps);
  const holder = holderFor((deps.loadKey ?? loadKey)(home));
  const store = createFileEmailProofPendingStore({ home });
  const options = {
    holder, expectedOrigin: config.shareOrigin, registryOrigin: config.registryOrigin, fetch: deps.fetch, now: deps.now,
    apiOrigin: deps.linksApiOrigin ?? process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API,
  };
  if (!withCode) {
    let requested: PendingAgentShareReceive;
    try { requested = await ops.request(link, options); } catch (error) { throw mapReceiveError(error, 'request'); }
    await withStoreErrors(() => store.put(requested.proof));
    out(JSON.stringify({ status: 'code-sent', address: requested.proof.address }) + '\n');
    err(`Verification code sent to ${requested.proof.address}. Run \`${cmd('join <link> --consent --code-stdin')}\` and enter the 8-digit code.\n`);
    return undefined;
  }
  const code = ((await (deps.readStdinLine ?? readStdinFirstLine)()) ?? '').trim();
  if (!/^\d{8}$/.test(code)) throw new CourierError('credential.code.CODE_INVALID', 'Verification code must be 8 digits.');
  let pending: PendingAgentShareReceive;
  try {
    pending = await ops.resume(link, (address) => withStoreErrors(() => store.findLive(address, new Date(deps.now?.() ?? Date.now()))), options);
  } catch (error) { throw mapReceiveError(error, 'session'); }
  // Refuse everything local and everything the signed envelope already says BEFORE the one-time code is spent.
  const bindings = await preflight(pending.envelope, deps, home);
  let content: AgentShareContent;
  try {
    content = await ops.complete(pending, code, options);
  } catch (error) {
    if (keepsPendingAfterFailure(error)) {
      const mapped = mapEmailProofError(error, 'credential');
      throw new CourierError(mapped.code, `${mapped.message} Retry with \`${cmd('join <link> --consent --code-stdin')}\` before ${pending.proof.expiresAt}.`);
    }
    // Terminal, or after the code was accepted: this proof is spent.
    await withStoreErrors(() => store.delete(pending.proof.requestId));
    throw mapReceiveError(error, 'credential');
  }
  await withStoreErrors(() => store.delete(pending.proof.requestId));
  const body = invitationFromShareContent(content.text, pending.proof.address);
  assertBodyMatchesEnvelope(body, pending.envelope, bindings);
  // Another process may have joined while the code was out.
  if (joinedAlready(body.id, home)) throw new CourierError('invite-used', 'Invitation already joined. No other session was activated.');
  return body;
}

const ENVELOPE_PATH_PREFIX = `${PREFIX}/to/invite-`;
const ENVELOPE_PATH_TAIL = /^([0-9A-HJKMNP-TV-Z]{26})\/envelope\/([a-f0-9]{32})\.json$/;

interface EnvelopeBindings { invitationId: string; shareId: string }

/**
 * The invitation id and share id in the SIGNED envelope's exact resource path, which Courier writes as
 * `<PREFIX>/to/invite-<id>/envelope/<shareId>.json`. Anything else is not a Courier invitation.
 */
export function envelopeBindings(envelope: ShareEnvelopeV3): EnvelopeBindings {
  const { resource } = envelope;
  const tail = resource.kind === 'exact' && resource.path.startsWith(ENVELOPE_PATH_PREFIX)
    ? ENVELOPE_PATH_TAIL.exec(resource.path.slice(ENVELOPE_PATH_PREFIX.length))
    : null;
  if (!tail || tail[2] !== envelope.shareId) throw new CourierError('bad-invitation', 'This share is not a Courier invitation.');
  return { invitationId: tail[1]!, shareId: tail[2] };
}

/**
 * What can be refused before the code is entered. The body is encrypted, so only the signed envelope and local state
 * are available here: its invitation id, node origin, issuer (policy owner) and expiry, the profile, the grant, the node
 * and whether this invitation was joined. What stays unknown until decrypt: the session, the pairing relay and the pairing
 * artifact; `assertBodyMatchesEnvelope` ties the body to the envelope afterwards.
 */
async function preflight(envelope: ShareEnvelopeV3, deps: EmailReceiveDeps, home: string): Promise<EnvelopeBindings> {
  const bindings = envelopeBindings(envelope);
  if (Date.parse(envelope.expiry) <= (deps.now?.() ?? Date.now())) throw new CourierError('invite-expired', 'Invitation expired; no code was entered and nothing was changed.');
  const profile = loadProfile(home);
  await (deps.node ?? courierNode)(profile, home);
  if (new URL(envelope.target.origin).origin !== new URL(profile.host).origin) {
    throw new CourierError('bad-invitation', 'Invitation uses another node host; no code was entered and nothing was changed.');
  }
  if (bareDid(envelope.policy.ownerDid) === profile.courierDid) throw new CourierError('bad-invitation', 'Refusing to join this agent identity.');
  if (joinedAlready(bindings.invitationId, home)) throw new CourierError('invite-used', 'Invitation already joined; no code was entered.');
  return bindings;
}

/** The decrypted body must be the one the signed envelope described. */
function assertBodyMatchesEnvelope(body: CourierInvitation, envelope: ShareEnvelopeV3, bindings: EnvelopeBindings): void {
  const same = body.id === bindings.invitationId
    && body.host === new URL(envelope.target.origin).origin
    && body.issuer === bareDid(envelope.policy.ownerDid)
    && Date.parse(body.expiresAt) === Date.parse(envelope.expiry)
    // Canonical resource identifiers, used verbatim as a KV space path: no case folding.
    && body.artifact.spaceId === envelope.target.spaceId;
  if (!same) throw new CourierError('bad-invitation', 'The invitation does not match the share that carried it.');
}

/** Share-link errors keep their `share.<code>`; witness errors map like `credential acquire`. */
function mapReceiveError(error: unknown, fallbackStep: Step): unknown {
  if (error instanceof CourierError) return error;
  if (error instanceof ShareReceiveError) return new CourierError(`share.${error.code}`, error.message);
  return mapEmailProofError(error, fallbackStep);
}

/** The decrypted Share content must be an email invitation addressed to exactly the mailbox that was verified. */
export function invitationFromShareContent(text: string | undefined, address: string): CourierInvitation {
  if (text === undefined) throw new CourierError('bad-invitation', 'The shared content is not a Courier invitation.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CourierError('bad-invitation', 'The shared content is not a Courier invitation.'); }
  // parseInvitation lives in invitation.ts, which imports this module; it is only called at runtime.
  const body = parseInvitation(value);
  if (body.mode !== 'email' || body.recipient !== address) throw new CourierError('bad-invitation', 'The invitation is not addressed to the verified mailbox.');
  return body;
}

async function readStdinFirstLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) { rl.close(); return line; }
  return '';
}
