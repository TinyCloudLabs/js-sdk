import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ackApprovalResult, checkApprovalResultBinding, collectApprovalResult, createApprovalRequest, DEFAULT_LINKS_API_ORIGIN, generateRelayKey,
  isApprovalClientError, isLinkError, openRelayResult, signerFromJwk,
  type ApprovalClientError, type ApprovalRequesterState, type CollectedApprovalResult, type CreatedLink, type Ed25519PrivateJwk, type LinkRecord,
  type LinkSigner, type OpenKeyApprovalRequestV1,
} from '@tinycloud/share-envelope/links';
import { canonicalJson } from './canonical.js';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { AGENT_GRANT, AGENT_GRANT_EXPIRY } from './keys.js';
import { profileDir, readSecure, writeSecure, type AgentKey, type Profile } from './profile.js';
import { assertBoundToKey, installGrant, parseGrantPayload, resolveOpenKeyApiHost, type GrantPayload } from './grant.js';
import { bareDid, CLOCK_SKEW_MS, durationMs, siweTimes } from './authority.js';

/**
 * The OpenKey short-link approval flow (the same one `tc onboard` uses): `init --request` creates a sealed approval
 * request at the links API and saves it here; `init --wait` polls OpenKey for the result with the agent key's signed
 * proof, installs the grant, and only then acknowledges it. Every step is resumable from `approval-pending.json`.
 */
const PENDING_FILE = 'approval-pending.json';

export const DEFAULT_WAIT_MS = 90_000;
export const MAX_WAIT_MS = 9 * 60_000;
/**
 * The wait for a pending agents space after an approval arrives ends this long after the --timeout deadline (never less than
 * MIN_SPACE_WAIT_MS), so a default `init --wait` stays inside an agent's 2-minute tool-call limit. The grant is saved and
 * acknowledged before that wait, so running out of it costs nothing: `init --resume` finishes.
 */
const SPACE_GRACE_MS = 5_000;
const MIN_SPACE_WAIT_MS = 1_000;
const MAX_SPACE_WAIT_MS = 150_000;
/** An acknowledgement that cannot be sent quickly is retried by the next `init --wait`; it never holds the command up. */
const ACK_TIMEOUT_MS = 5_000;
/** installGrant failures that no retry can fix: the approved result itself is wrong, so the request is dropped. */
const REFUSED_CODES: Record<string, true> = { 'bad-grant': true, 'grant-too-broad': true, 'grant-incomplete': true, 'grant-expired': true, 'grant-too-long': true };

/** The durable record of one approval request. The result stays encrypted at rest under `relayPrivateKey`. */
export interface PendingGrantRequest {
  version: 1;
  request: OpenKeyApprovalRequestV1;
  requestId: string;
  bodyCid: string;
  approvalUrl: string;
  requestExpiresAt: string;
  record: LinkRecord;
  apiOrigin: string;
  linkApiOrigin: string;
  openkeyOrigin: string;
  relayPrivateKey: string;
  /** Sent with the acknowledgement; stable across retries so OpenKey can recognise the same ack. */
  ackId: string;
  resultRef?: string;
  resultExpiresAt?: string;
  resultEnvelope?: unknown;
  /** The grant and profile are saved; only the acknowledgement may remain. */
  committed?: true;
}

export function loadPending(): PendingGrantRequest | undefined {
  const pending = readSecure<PendingGrantRequest>(PENDING_FILE, false);
  if (pending === undefined) return undefined;
  if (pending.version !== 1 || !pending.request || typeof pending.requestId !== 'string' || typeof pending.bodyCid !== 'string'
    || typeof pending.approvalUrl !== 'string' || typeof pending.relayPrivateKey !== 'string' || typeof pending.ackId !== 'string') {
    throw new CourierError('bad-profile', `Corrupt ${PENDING_FILE} in ${profileDir()}. Delete it and run \`${cmd('init --request')}\` again.`);
  }
  return pending;
}

function savePending(pending: PendingGrantRequest): void {
  writeSecure(path.join(profileDir(), PENDING_FILE), pending);
}

export function clearPending(): void {
  try { fs.unlinkSync(path.join(profileDir(), PENDING_FILE)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function configuredOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CourierError('usage', `${label} must be an origin, such as https://openkey.so.`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new CourierError('usage', `${label} must be an HTTPS origin (or a loopback HTTP origin).`);
  }
  return url.origin;
}

function requesterJwk(key: AgentKey): Ed25519PrivateJwk {
  const { kty, crv, x, d } = key.jwk;
  if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof d !== 'string') {
    throw new CourierError('bad-profile', `The agent key in ${profileDir()} is not an Ed25519 key.`);
  }
  return { kty, crv, x, d };
}

/** What a request for this profile and key looks like; anything else saved is not "the same request". */
interface WantedRequest {
  jwk: Ed25519PrivateJwk;
  signer: LinkSigner;
  /** Seconds. */
  lifetime: number;
  /** `--expiry` was given: only then does the lifetime of a saved request have to equal it. */
  explicitLifetime: boolean;
  openkeyOrigin: string;
  apiOrigin: string;
  linkApiOrigin: string;
}

function wanted(profile: Profile, key: AgentKey, expiry: string | undefined, openkeyApiHost: string | undefined): WantedRequest {
  const jwk = requesterJwk(key);
  const signer = signerFromJwk(jwk);
  if (signer.did !== bareDid(key.did)) throw new CourierError('bad-profile', 'The agent key file does not match its did:key.');
  const lifetimeMs = durationMs(expiry ?? AGENT_GRANT_EXPIRY);
  if (!lifetimeMs) throw new CourierError('usage', `Invalid --expiry ${expiry}.`);
  const openkeyOrigin = configuredOrigin(profile.openkeyHost, 'The OpenKey host');
  return {
    jwk, signer, lifetime: Math.floor(lifetimeMs / 1000), explicitLifetime: expiry !== undefined, openkeyOrigin,
    apiOrigin: configuredOrigin(resolveOpenKeyApiHost({ flag: openkeyApiHost, env: process.env.COURIER_OPENKEY_API_HOST, openkeyHost: openkeyOrigin }), 'The OpenKey API host'),
    linkApiOrigin: configuredOrigin(process.env.TC_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API_ORIGIN, 'The links API origin'),
  };
}

/** Everything in the request except the relay key (fresh per request) and the lifetime (compared only when asked for). */
function requestSpec(profile: Profile, want: WantedRequest): Omit<OpenKeyApprovalRequestV1, 'resultEncryptionPublicJwk' | 'grantLifetimeSeconds'> {
  return {
    issuer: want.signer.did, requestVersion: 1, targetDid: want.signer.did,
    // The schema is strict: the public key members only, never `d`.
    targetPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: want.jwk.x },
    nodeOrigin: profile.host, permissions: AGENT_GRANT.map((entry) => ({ ...entry, actions: [...entry.actions] })) as OpenKeyApprovalRequestV1['permissions'],
    reason: 'Grant the Courier agent key restricted access to this owner space. It cannot write owner approvals or orders.',
  };
}

/** The saved request is the one this run would make: same canonical request (permissions, target, reason, host) and origins. */
function matches(pending: PendingGrantRequest, profile: Profile, want: WantedRequest): boolean {
  const { resultEncryptionPublicJwk: _relay, grantLifetimeSeconds, ...saved } = pending.request;
  return canonicalJson(saved) === canonicalJson(requestSpec(profile, want))
    && (!want.explicitLifetime || grantLifetimeSeconds === want.lifetime)
    && pending.openkeyOrigin === want.openkeyOrigin && pending.apiOrigin === want.apiOrigin && pending.linkApiOrigin === want.linkApiOrigin;
}

/** The saved request already holds something that cannot be made again: a reference to an approved result, the result itself, or an installed grant. */
const holdsApproval = (pending: PendingGrantRequest) => pending.resultRef !== undefined || pending.resultEnvelope !== undefined || pending.committed === true;

const requestLapsed = (pending: PendingGrantRequest) => !pending.resultRef && !pending.resultEnvelope && Date.parse(pending.requestExpiresAt) <= Date.now();

async function createPending(profile: Profile, want: WantedRequest): Promise<PendingGrantRequest> {
  const relay = generateRelayKey();
  const request: OpenKeyApprovalRequestV1 = { ...requestSpec(profile, want), grantLifetimeSeconds: want.lifetime, resultEncryptionPublicJwk: relay.publicJwk };
  let created: CreatedLink & { readonly record: LinkRecord };
  try {
    created = await createApprovalRequest({ request, issuerKey: want.signer, apiOrigin: want.linkApiOrigin, openkeyOrigin: want.openkeyOrigin });
  } catch (error) {
    if (!isLinkError(error)) throw error;
    throw new CourierError('link-unavailable', `Could not create the OpenKey approval link (${error.code}). Check the network and run \`${cmd('init --request')}\` again.`);
  }
  const pending: PendingGrantRequest = {
    version: 1, request, requestId: created.id, bodyCid: created.bodyCid, approvalUrl: created.link, requestExpiresAt: created.expiresAt,
    record: created.record, apiOrigin: want.apiOrigin, linkApiOrigin: want.linkApiOrigin, openkeyOrigin: want.openkeyOrigin,
    relayPrivateKey: relay.privateKey, ackId: randomUUID(),
  };
  savePending(pending); // saved before the link is shown: a link that was shown can always be resumed
  return pending;
}

/**
 * `init --request`: the saved request when it is still the same and open, else a new one. A saved request that already holds an
 * approval (a result reference, the encrypted result, or an installed grant awaiting its acknowledgement) is NEVER replaced:
 * replacing it would discard an approval the owner already gave.
 */
export async function requestApproval(profile: Profile, key: AgentKey, expiry: string | undefined, options: { openkeyApiHost?: string } = {}): Promise<PendingGrantRequest> {
  const want = wanted(profile, key, expiry, options.openkeyApiHost);
  const existing = loadPending();
  if (existing && existing.request.issuer === want.signer.did) {
    if (holdsApproval(existing)) {
      throw new CourierError('usage', `Approval request ${existing.requestId} has already been approved by the owner. Run \`${cmd('init --wait')}\` to finish it first; \`${cmd('init --request')}\` can ask for another approval after that.`);
    }
    if (matches(existing, profile, want) && !requestLapsed(existing)) return existing;
  }
  return createPending(profile, want);
}

export interface WaitOptions {
  /** Epoch milliseconds the wait ends at. */
  deadline: number;
  openkeyApiHost?: string;
}

function expiredError(): CourierError {
  return new CourierError('approval-expired', `This approval request expired before it was approved. Run \`${cmd('init --request')}\` for a new link.`);
}

/**
 * `init --wait`: resumes the saved request for this key, or makes a new one. A request that holds an approval is resumed whatever
 * flags this run has; an unapproved one is replaced only when it differs from what this run asks for. An expired unapproved
 * request is dropped and reported.
 */
export async function waitApproval(profile: Profile, key: AgentKey, expiry: string | undefined, options: Pick<WaitOptions, 'openkeyApiHost'> = {}): Promise<{ pending: PendingGrantRequest; resumed: boolean }> {
  const want = wanted(profile, key, expiry, options.openkeyApiHost);
  const existing = loadPending();
  if (existing && existing.request.issuer === want.signer.did) {
    if (holdsApproval(existing)) return { pending: existing, resumed: true };
    if (matches(existing, profile, want)) {
      if (requestLapsed(existing)) {
        clearPending();
        throw expiredError();
      }
      return { pending: existing, resumed: true };
    }
  }
  return { pending: await createPending(profile, want), resumed: false };
}

function resultGoneError(): CourierError {
  return new CourierError('approval-result-expired', `OpenKey no longer holds the approved result: it keeps one for only 10 minutes, and this one was not collected in time, so nothing was installed. Run \`${cmd('init --request')}\` and approve the new link, then run \`${cmd('init --wait')}\` right away.`);
}

/**
 * What a failed collection means for the saved request. Permanent outcomes (expired request, expired or consumed result) drop it so
 * `init --request` is not blocked; anything that a retry can fix (a rejected proof, one malformed reply, OpenKey down) keeps it and
 * its relay key. `resultSeen` is whether the result reference was already saved, i.e. whether the failing call was the fetch.
 */
function collectFailure(error: ApprovalClientError, resultSeen: boolean): CourierError {
  switch (error.code) {
    case 'request_expired':
      clearPending();
      return expiredError();
    case 'not_found':
      clearPending();
      return resultSeen ? resultGoneError() : expiredError();
    case 'result_expired':
      clearPending();
      return resultGoneError();
    case 'acknowledged':
      clearPending(); // nothing local to finish from, and a kept record would block `init --request`
      return new CourierError('approval-consumed', `OpenKey says this approval was already collected, so it cannot be fetched again. If this machine has no grant, run \`${cmd('init --request')}\` and approve the new link.`);
    case 'request_binding':
      return new CourierError('approval-rejected', `OpenKey rejected this machine's proof or the request binding (check the system clock). The saved request is kept: run \`${cmd('init --wait')}\` again.`);
    default:
      return new CourierError('approval-unavailable', `OpenKey could not be asked for the result (${error.message}). Nothing was lost: run \`${cmd('init --wait')}\` again.`);
  }
}

function requesterState(pending: PendingGrantRequest, key: AgentKey): ApprovalRequesterState {
  return { requestId: pending.requestId, bodyCid: pending.bodyCid, record: pending.record, apiOrigin: pending.apiOrigin, signingKey: requesterJwk(key) };
}

/** Decrypt the saved result and check it answers this request and this key. Throws after dropping the request if it does not. */
async function verifiedPayload(profile: Profile, pending: PendingGrantRequest, key: AgentKey): Promise<GrantPayload> {
  try {
    const opened = await openRelayResult(pending.resultEnvelope, pending.requestId, pending.relayPrivateKey);
    const checked = checkApprovalResultBinding(opened, { requestId: pending.requestId, bodyCid: pending.bodyCid, request: pending.request });
    const payload = parseGrantPayload(checked.delegation, key);
    assertBoundToKey(checked.delegation, key);
    if (`did:pkh:eip155:${payload.chainId}:${payload.address}`.toLowerCase() !== checked.ownerDid.toLowerCase()) {
      throw new CourierError('bad-grant', 'The approved result names a different owner than its delegation.');
    }
    const times = siweTimes(payload.siwe);
    if (times.expiresAt?.toISOString() !== checked.delegationExpiresAt) {
      throw new CourierError('bad-grant', 'The approved result expiry differs from the signed delegation expiry.');
    }
    // The grant may not outlast what was asked for (OpenKey lets the owner choose less, never more).
    if (times.issuedAt && times.expiresAt.getTime() - times.issuedAt.getTime() > pending.request.grantLifetimeSeconds * 1000 + CLOCK_SKEW_MS) {
      throw new CourierError('grant-too-long', `The approved grant lasts longer than the ${pending.request.grantLifetimeSeconds} seconds this request asked for.`);
    }
    // A renewal stays with the owner that holds the grant: with no code to paste back, whoever approves the link first would win.
    if (profile.ownerDid && checked.ownerDid.toLowerCase() !== profile.ownerDid.toLowerCase()) {
      throw new CourierError('approval-result-invalid', `This agent is bound to owner ${profile.ownerDid}, but a different owner (${checked.ownerDid}) approved the request. Nothing was installed. Send the link only to the owner, privately. If the owner changed on purpose, run \`${cmd('init --rotate-key --request')}\` (this re-pairs every peer).`);
    }
    return payload;
  } catch (error) {
    clearPending();
    if (isApprovalClientError(error)) {
      throw new CourierError('approval-result-invalid', `The approved result does not match this request (${error.message}). Nothing was installed. Run \`${cmd('init --request')}\` for a new link.`);
    }
    throw error;
  }
}

/** Acknowledge a saved grant. A failure is reported, never fatal: the grant is installed and the saved request keeps the ack to retry. */
async function acknowledge(pending: PendingGrantRequest, key: AgentKey): Promise<void> {
  if (!pending.resultRef) {
    clearPending();
    return;
  }
  try {
    await ackApprovalResult(requesterState(pending, key), pending.resultRef, pending.ackId, { timeoutMs: ACK_TIMEOUT_MS });
    clearPending();
  } catch (error) {
    if (!isApprovalClientError(error)) throw error;
    if (error.code === 'ack_conflict') {
      // OpenKey holds another acknowledgement for this result: nothing more can be sent, and a kept record would block `init --request`.
      clearPending();
      console.error('The grant is installed. OpenKey already holds a different acknowledgement for this approval, so there is nothing left to send.');
      return;
    }
    console.error(`The grant is installed, but OpenKey did not confirm the acknowledgement (${error.message}). This is harmless (OpenKey discards the result within 10 minutes); run \`${cmd('init --wait')}\` to retry it.`);
  }
}

/**
 * Collect, verify and install the approved grant, then acknowledge it. Returns `deadline` when the owner has not
 * approved by `options.deadline` (the request stays saved). Nothing is acknowledged before the grant and profile
 * are durably saved; every earlier step is resumable from the saved request alone.
 */
export async function completeApproval(profile: Profile, key: AgentKey, pending: PendingGrantRequest, options: WaitOptions): Promise<'done' | 'deadline'> {
  if (!pending.committed) {
    if (pending.resultEnvelope === undefined) {
      let collected: CollectedApprovalResult | { readonly status: 'deadline' };
      try {
        collected = await collectApprovalResult(requesterState(pending, key), {
          deadline: options.deadline,
          ...(pending.resultRef && pending.resultExpiresAt ? { known: { resultRef: pending.resultRef, expiresAt: pending.resultExpiresAt } } : {}),
          onDiscovered: (found) => {
            pending.resultRef = found.resultRef;
            pending.resultExpiresAt = found.expiresAt;
            savePending(pending);
          },
        });
      } catch (error) {
        if (!isApprovalClientError(error)) throw error;
        throw collectFailure(error, pending.resultRef !== undefined);
      }
      if (collected.status === 'deadline') return 'deadline';
      pending.resultEnvelope = collected.relay;
      savePending(pending); // the encrypted result is on disk before any install work
    }
    const payload = await verifiedPayload(profile, pending, key);
    const spaceTimeoutMs = Math.min(MAX_SPACE_WAIT_MS, Math.max(MIN_SPACE_WAIT_MS, options.deadline + SPACE_GRACE_MS - Date.now()));
    let spaceError: CourierError | undefined;
    try {
      await installGrant(profile, key, payload, { spaceTimeoutMs });
    } catch (error) {
      if (error instanceof CourierError && error.code === 'no-space') spaceError = error; // grant and profile are saved
      else {
        if (error instanceof CourierError && REFUSED_CODES[error.code]) clearPending();
        throw error;
      }
    }
    pending.committed = true;
    savePending(pending);
    await acknowledge(pending, key);
    if (spaceError) throw spaceError;
    return 'done';
  }
  await acknowledge(pending, key);
  return 'done';
}
