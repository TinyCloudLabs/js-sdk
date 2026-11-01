import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { emailProofDescriptor } from '@tinycloud/node-sdk/credentials';
import { createFileEmailProofPendingStore, PendingStoreError } from '@tinycloud/node-sdk/credential-pending-store';
import { completeAgentShareReceive, requestAgentShareEmailProof, resumeAgentShareReceive } from '@tinycloud/node-sdk/share-receive';
import type { AgentShareContent } from '@tinycloud/node-sdk/share-receive';
import { publishEmailShareV3 } from '@tinycloud/node-sdk/share-publish';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { deliverCredentialInvitation, prepareAddressedShare, ShareReceiveError } from '@tinycloud/share-sdk';
import { canonicalize, isEnvelopeDeliveryEmail } from '@tinycloud/share-envelope';
import { createLink, signerFromJwk } from '@tinycloud/share-envelope/links';
import type { Ed25519PrivateJwk } from '@tinycloud/share-envelope/links';
import { holdsInvitationKeyAuthority } from './authority.js';
import { canonicalJson } from './canonical.js';
import { CourierError } from './errors.js';
import { PREFIX } from './keys.js';
import { holderFor } from './credential.js';
import { cmd } from './program.js';
import { loadKey, profileDir, type Profile } from './profile.js';
import { parseInvitation } from './invitation.js';
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
}

interface ShareConfig { shareOrigin: string; registryOrigin: string; credentialsOrigin: string }

const envelopePath = (invitationId: string, shareId: string) => `${PREFIX}/to/invite-${invitationId}/envelope/${shareId}.json`;
const randomShareId = () => randomBytes(16).toString('hex');

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
  const shareId = (deps.shareId ?? randomShareId)();
  if (!holdsInvitationKeyAuthority(node.getVerifiedSessionCapabilities(), profile.ownerDid, shareId)) {
    throw new CourierError('invite-authority-missing', 'This Courier grant cannot create invitation keys, so no email invitation was sent. Nothing was changed.');
  }
  const fetchFn = deps.fetch ?? fetch;
  const config = await shareConfig(deps);
  const identity = await node.activeNodeIdentity();
  const descriptor = await emailProofDescriptor(email, { fetch: deps.fetch });
  const keyPath = `share/${shareId}`;
  const network = node.getDefaultEncryptionNetworkId();
  await node.publishActiveNodeLocation(config.registryOrigin, fetchFn);
  await node.keys.createKey(keyPath);
  const plaintext = new TextEncoder().encode(canonicalJson(body));
  const encrypted = await node.encryption.encryptToNetwork(network, plaintext, { keyPath, metadata: { contentType: 'application/json' } });
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

export interface EmailReceiveDeps extends EmailInvitationDeps {
  readStdinLine?: () => Promise<string>;
  out?: (text: string) => void;
}

/** True for a Share link (`/s/…`); Courier's own `/c/` links take the existing path. */
export function isShareLink(link: string): boolean {
  try { return new URL(link).pathname.startsWith('/s/'); } catch { return false; }
}

async function withStoreErrors<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof PendingStoreError) throw new CourierError(error.code, error.message);
    throw error;
  }
}

/**
 * Open an email-bound invitation with this agent's own Courier key. Step 1 asks OpenCredentials to mail an 8-digit code
 * and stops; step 2 (`--code-stdin`) completes the proof, admits at the owner Node and decrypts the one invitation.
 * Returns the invitation body, or `undefined` after step 1.
 */
export async function receiveEmailInvitation(link: string, withCode: boolean, deps: EmailReceiveDeps = {}): Promise<CourierInvitation | undefined> {
  const out = deps.out ?? ((text: string) => { process.stdout.write(text); });
  const config = await shareConfig(deps);
  const holder = holderFor(loadKey());
  const store = createFileEmailProofPendingStore({ home: profileDir() });
  const options = {
    holder, expectedOrigin: config.shareOrigin, registryOrigin: config.registryOrigin, fetch: deps.fetch, now: deps.now,
    apiOrigin: deps.linksApiOrigin ?? process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API,
  };
  try {
    if (!withCode) {
      const pending = await requestAgentShareEmailProof(link, options);
      await withStoreErrors(() => store.put(pending.proof));
      out(JSON.stringify({ status: 'code-sent', address: pending.proof.address }) + '\n');
      process.stderr.write(`Verification code sent to ${pending.proof.address}. Run \`${cmd('join <link> --consent --code-stdin')}\` and enter the 8-digit code.\n`);
      return undefined;
    }
    const code = ((await (deps.readStdinLine ?? readStdinFirstLine)()) ?? '').trim();
    if (!/^\d{8}$/.test(code)) throw new CourierError('credential.code.CODE_INVALID', 'Verification code must be 8 digits.');
    const pending = await resumeAgentShareReceive(link, (address) => withStoreErrors(() => store.findLive(address, new Date(deps.now?.() ?? Date.now()))), options);
    let content: AgentShareContent;
    try { content = await completeAgentShareReceive(pending, code, options); } finally {
      // The code was offered to the witness: this proof is spent whether or not the open succeeded.
      await withStoreErrors(() => store.delete(pending.proof.requestId));
    }
    return invitationFromShareContent(content.text, pending.proof.address);
  } catch (error) {
    if (error instanceof ShareReceiveError) throw new CourierError(`share.${error.code}`, error.message);
    throw error;
  }
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
