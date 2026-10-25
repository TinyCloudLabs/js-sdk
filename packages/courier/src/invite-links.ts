import { randomBytes } from 'node:crypto';
import {
  DEFAULT_LINKS_API_ORIGIN,
  LINK_MIN_LIFE_SECONDS,
  LINK_SEAL_OVERHEAD_BYTES,
  LINK_TYPE_SPECS,
  LinkError,
  MAX_LINK_BODY_BYTES,
  createLink,
  deleteLink,
  resolveLink,
  signerFromSeed,
  type LinkSigner,
} from '@tinycloud/share-envelope/links';
import { isRecord } from './a2a.js';
import { durationMs } from './authority.js';
import { CourierError } from './errors.js';
import { parseInviteBlob, type InviteBlob } from './invite-schema.js';

/**
 * Invitations ride the `courier` link type of the links API (TC-712). The invitation is sealed by the SDK under a random key that travels only in the
 * link fragment; the links service stores opaque bytes and never sees the key. Everything on the wire goes through `@tinycloud/share-envelope/links`
 * (no redirects, a timeout, a streamed size cap): this module only configures it, bounds the life and size before any request, signs with a per-invite key,
 * and maps every refusal to a stable Courier code with a fixed message. Nothing the service says is ever copied into an error.
 */

const COURIER_LINK = LINK_TYPE_SPECS.courier;
export const INVITE_TTL_MIN_MS = LINK_MIN_LIFE_SECONDS * 1000;
export const INVITE_TTL_MAX_MS = COURIER_LINK.maxLifeSeconds * 1000;
export const INVITE_TTL_DEFAULT = `${COURIER_LINK.defaultLifeSeconds}s`;

const CANONICAL_HTTPS_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
const SEED = /^[A-Za-z0-9_-]{43}$/;

/** Where the links API is, and how to reach it. `fetch` is a test seam (the real `fetch` is used when it is absent). */
export interface LinksApi {
  apiOrigin: string;
  fetch?: typeof globalThis.fetch;
}

/** The API plus the viewer origin that appears in links and that a reader trusts. */
export interface LinksConfig extends LinksApi {
  viewerOrigin: string;
}

function origin(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!CANONICAL_HTTPS_ORIGIN.test(trimmed)) {
    throw new CourierError('link-origin-invalid', `${name} must be an https origin such as https://share.example, with no path.`);
  }
  return trimmed;
}

/** The API origin: `COURIER_LINKS_API_ORIGIN`, else the SDK's default. */
export function linksApi(env: NodeJS.ProcessEnv = process.env): LinksApi {
  const given = env.COURIER_LINKS_API_ORIGIN;
  return { apiOrigin: given === undefined || given.trim() === '' ? DEFAULT_LINKS_API_ORIGIN : origin(given, 'COURIER_LINKS_API_ORIGIN') };
}

/** The viewer origin has no default: `COURIER_LINK_ORIGIN` must name it. */
export function linksConfig(env: NodeJS.ProcessEnv = process.env): LinksConfig {
  const given = env.COURIER_LINK_ORIGIN;
  if (given === undefined || given.trim() === '') {
    throw new CourierError('link-origin-unset', 'Set COURIER_LINK_ORIGIN to the https origin of the share viewer that opens invite links.');
  }
  return { ...linksApi(env), viewerOrigin: origin(given, 'COURIER_LINK_ORIGIN') };
}

const spell = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

/**
 * The invite life from `--ttl` (default 24h): at least the links service's minimum and at most the courier type's maximum, both read from the SDK's type
 * table. Checked before any request, key or delegation exists.
 */
export function inviteTtl(given: string | undefined): { text: string; ms: number } {
  const text = given ?? INVITE_TTL_DEFAULT;
  const ms = durationMs(text);
  if (ms === undefined || ms < INVITE_TTL_MIN_MS || ms > INVITE_TTL_MAX_MS) {
    throw new CourierError('usage', `--ttl must be a duration like 24h, from ${spell(INVITE_TTL_MIN_MS)} to ${spell(INVITE_TTL_MAX_MS)} (got "${given ?? ''}").`);
  }
  return { text, ms };
}

/**
 * The per-invite signing key: a throwaway Ed25519 did:key made when the invite is created, never reused and never the agent's key. `seed` is for the
 * invite's private 0600 record only (it is needed to sign the delete); it must not be printed, logged or put in any public copy. `signer` carries no seed
 * property: it only signs.
 */
export interface InviteLinkKey {
  signer: LinkSigner;
  seed: string;
}

export function newInviteLinkKey(random: (size: number) => Uint8Array = randomBytes): InviteLinkKey {
  const seed = Uint8Array.from(random(32));
  return { signer: signerFromSeed(seed), seed: Buffer.from(seed).toString('base64url') };
}

/** What the private invite record keeps of the link: enough to delete it, nothing to read it. */
export interface StoredLink {
  id: string;
  /** Content id of the sealed body. */
  cid: string;
  /** The did:key that signed the link; checked against the seed whenever the seed is used. */
  issuer: string;
  /** Private. Base64url Ed25519 seed of the per-invite key. */
  seed: string;
}

export function signerFromStored(link: StoredLink): LinkSigner {
  if (!SEED.test(link.seed) || Buffer.from(link.seed, 'base64url').toString('base64url') !== link.seed) {
    throw new CourierError('internal', 'The invite record has no usable link key.');
  }
  const signer = signerFromSeed(Buffer.from(link.seed, 'base64url'));
  if (signer.did !== link.issuer) throw new CourierError('internal', 'The invite record link key does not match its issuer.');
  return signer;
}

/** The stable Courier error for a failure of the links client. The service's own words never reach the message. */
export function linkFailure(error: unknown, action: 'create' | 'open' | 'delete'): CourierError {
  if (error instanceof CourierError) return error;
  if (!(error instanceof LinkError)) {
    return new CourierError('invite-store-error', `The invitation could not be ${action === 'create' ? 'created' : action === 'open' ? 'opened' : 'deleted'}.`);
  }
  switch (error.code) {
    case 'body_over_cap':
      return new CourierError('invite-too-large', `The invitation is over the ${MAX_LINK_BODY_BYTES}-byte limit of a link.`);
    case 'gone':
    case 'expired':
      return new CourierError('invite-gone', 'The invitation is gone: it expired, was revoked, or never existed.');
    case 'origin_not_trusted':
      return new CourierError('invite-origin', 'The link is not on the viewer origin set in COURIER_LINK_ORIGIN.');
    case 'issuer_binding_mismatch':
      return new CourierError('invite-issuer-mismatch', 'The invitation is not signed by the key it names; it was refused.');
    case 'body_validation_failed':
      return error.cause instanceof CourierError ? error.cause : new CourierError('bad-invite-file', 'The invitation content is not a valid Courier invitation.');
    case 'service_unavailable':
    case 'response_too_large':
    case 'invalid_response':
      return new CourierError('invite-unreachable', 'The links service could not be reached or answered unexpectedly.');
    case 'service_refused':
      if (error.status === 429) return new CourierError('invite-rate-limited', 'The links service is rate limiting requests (HTTP 429).');
      if (error.status === 503) return new CourierError('invite-unavailable', 'The links service is unavailable (HTTP 503).');
      return new CourierError('invite-store-error', `The links service refused the request${error.status === undefined ? '' : ` (HTTP ${error.status})`}.`);
    case 'life_too_short':
    case 'life_too_long':
    case 'already_expired':
      return new CourierError('usage', `The invite life must be from ${spell(INVITE_TTL_MIN_MS)} to ${spell(INVITE_TTL_MAX_MS)}.`);
    case 'issued_at_window':
      return new CourierError('invite-clock', 'This machine\'s clock is too far from the links service\'s clock.');
    case 'invalid_argument':
    case 'signer_failed':
      return new CourierError('internal', 'The invitation could not be built.');
    default:
      // Every other code is the link failing a check of the contract: grammar, signature, hash, encryption, schema.
      return new CourierError('bad-invite', action === 'open' ? 'The link is not a valid Courier invitation.' : 'The invitation could not be built.');
  }
}

/** The sealed size of a plaintext, as the links service will see it. */
export const sealedSize = (plaintextBytes: number): number => plaintextBytes + LINK_SEAL_OVERHEAD_BYTES;

export interface CreatedInviteLink {
  link: string;
  stored: StoredLink;
}

/**
 * Seals the invitation text, signs it with the per-invite key and stores it as a `courier` link that lives until `expiresAt`. The size is checked against
 * the SDK's limit before anything is signed, and the blob's top-level `issuer` must already be this key's did:key (the reader refuses it otherwise).
 */
export async function createInviteLink(
  config: LinksConfig,
  input: { blobText: string; expiresAt: Date; key: InviteLinkKey; now?: number },
): Promise<CreatedInviteLink> {
  const plaintext = new TextEncoder().encode(input.blobText);
  if (sealedSize(plaintext.byteLength) > MAX_LINK_BODY_BYTES) throw linkFailure(new LinkError('body_over_cap'), 'create');
  let issuer: unknown;
  try {
    const parsed: unknown = JSON.parse(input.blobText);
    issuer = isRecord(parsed) ? parsed.issuer : undefined;
  } catch {
    issuer = undefined;
  }
  if (issuer !== input.key.signer.did) throw new CourierError('internal', 'The invitation does not name its signing key as issuer.');
  try {
    const created = await createLink({
      type: 'courier',
      plaintext,
      issuerKey: input.key.signer,
      apiOrigin: config.apiOrigin,
      linkOrigin: config.viewerOrigin,
      expiresAt: input.expiresAt,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
    return { link: created.link, stored: { id: created.id, cid: created.bodyCid, issuer: input.key.signer.did, seed: input.key.seed } };
  } catch (error) {
    throw linkFailure(error, 'create');
  }
}

export interface OpenedInvite {
  blob: InviteBlob;
  /** The opened invitation text, byte for byte. */
  blobText: string;
  /** The did:key that signed the link. */
  issuer: string;
}

/**
 * Fetches and opens an invitation link. The SDK runs every contract check and refuses a body whose top-level `issuer` is not the link's signing did:key
 * (`issuer_binding_mismatch`) before this module's validator or any field is read; the validator then applies the strict invitation schema, and the opened
 * text is parsed once more as text so a repeated key cannot hide behind the JSON parse.
 */
export async function resolveInviteLink(config: LinksConfig, link: string, now: number = Date.now()): Promise<OpenedInvite> {
  try {
    const opened = await resolveLink(link.trim(), {
      trustedOrigins: [config.viewerOrigin],
      apiOrigin: config.apiOrigin,
      now,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      validateBody: (type, value) => {
        if (type !== 'courier') throw new CourierError('bad-invite', 'The link is not a Courier invitation.');
        parseInviteBlob(JSON.stringify(value), now);
      },
    });
    const blobText = new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext);
    return { blob: parseInviteBlob(blobText, now), blobText, issuer: opened.header.issuer };
  } catch (error) {
    throw linkFailure(error, 'open');
  }
}

/** Deletes a link with the invite's own key. A link that is already gone counts as deleted. */
export async function deleteInviteLink(api: LinksApi, link: StoredLink): Promise<void> {
  try {
    await deleteLink({
      id: link.id,
      issuerKey: signerFromStored(link),
      apiOrigin: api.apiOrigin,
      ...(api.fetch === undefined ? {} : { fetch: api.fetch }),
    });
  } catch (error) {
    throw linkFailure(error, 'delete');
  }
}
