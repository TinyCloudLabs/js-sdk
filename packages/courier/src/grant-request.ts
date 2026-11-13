import { assertEpisodeGrant } from './interim-owner.js';
import { verifyOwnerRenewal } from './owner-renewal.js';
import { randomUUID } from 'node:crypto';
import {
  ackApprovalResult, checkApprovalResultBinding, collectApprovalResult, createApprovalRequest, DEFAULT_LINKS_API_ORIGIN, discoverApprovalResult, generateRelayKey,
  isApprovalClientError, isLinkError, openRelayResult, signerFromJwk,
  type ApprovalClientError, type ApprovalRequesterState, type CollectedApprovalResult, type CreatedLink, type Ed25519PrivateJwk, type LinkRecord,
  type LinkSigner, type OpenKeyApprovalRequestV1,
} from '@tinycloud/share-envelope/links';
import { canonicalJson } from './canonical.js';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { AGENT_GRANT, AGENT_GRANT_EXPIRY } from './keys.js';
import { profileDir, loadKey, withProfileTransaction, type AgentKey, type Profile } from './profile.js';
import {
  ackRef, clearPending, holdsApproval, knownResult, loadPendingForWrite, markCommitted, recordResultEnvelope, recordResultRef, resultEnvelopeOf,
  resultSeen, savePending, stageOf, approvalPhase, type PendingGrantRequest,
} from './approval-phase.js';
import { assertBoundToKey, installGrant, isClockRefusal, isPermanentRefusal, parseGrantPayload, resolveOpenKeyApiHost, type GrantPayload } from './grant.js';
import { withRefusalNotice } from './grant-refusal.js';
import { bareDid, CLOCK_SKEW_MS, durationMs, siweTimes } from './authority.js';

/**
 * The OpenKey short-link approval flow (the same one `tc onboard` uses): `init --request` creates a sealed approval
 * request at the links API and saves it here; `init --wait` polls OpenKey for the result with the agent key's signed
 * proof, installs the grant, and only then acknowledges it. Every step is resumable from `approval-pending.json`.
 */
// The saved request file, its reader, writers and phase live in approval-phase.ts; this module only calls them.

export const DEFAULT_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 9 * 60_000;
/**
 * The wait for a pending agents space after an approval arrives ends this long after the --timeout deadline (never less than
 * MIN_SPACE_WAIT_MS), so a default `init --wait` stays inside an agent's 2-minute tool-call limit. The grant is saved and
 * acknowledged before that wait, so running out of it costs nothing: `init --resume` finishes.
 */
const DAY_MS = 86_400_000;
const SPACE_GRACE_MS = 5_000;
const MIN_SPACE_WAIT_MS = 1_000;
const MAX_SPACE_WAIT_MS = 150_000;
/** An acknowledgement that cannot be sent quickly is retried by the next `init --wait`; it never holds the command up. */
const ACK_TIMEOUT_MS = 5_000;
/** installGrant failures that no retry can fix: the approved result itself is wrong, so the request is dropped. */
const REFUSED_CODES: Record<string, true> = { 'bad-grant': true, 'grant-too-broad': true, 'grant-incomplete': true, 'grant-expired': true, 'grant-too-long': true };

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
    issuer: want.signer.did, requestVersion: 1, targetDid: want.signer.did, purpose: 'standing',
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

/**
 * OpenKey keeps an approved result for this long after the approval: production APPROVAL_RESULT_RETENTION_SECONDS=600,
 * docker-compose.prod.yml:28 (OpenKey repo). The constant follows the DEPLOYED value.
 */
const RESULT_RETENTION_MS = 600_000;
/** Clock difference tolerated between this machine and OpenKey when judging the end of that window. */
const EXPIRY_SKEW_MS = 60_000;

/** The request's own expiry has passed and nothing was ever collected for it. */
const requestLapsed = (pending: PendingGrantRequest) => {
  const phase = approvalPhase({ kind: 'ok', pending });
  return phase.phase === 'open' && phase.lapsed;
};

/**
 * A lapsed, unapproved request may still have been approved just before it expired: OpenKey serves the result for
 * RESULT_RETENTION_MS after the approval. So it is asked ONCE (the normal discover) before the record is dropped:
 * a result is saved (`approved`), OpenKey still calling it open is `open`, an expired answer is `expired`. Past the whole window
 * (expiry + retention + skew) no approval can exist any more: `expired` without a call. OpenKey being unreachable inside the window
 * keeps the record (`approval-unavailable`).
 */
async function settleLapsed(pending: PendingGrantRequest, key: AgentKey): Promise<'approved' | 'open' | 'expired'> {
  if (Date.now() >= Date.parse(pending.requestExpiresAt) + RESULT_RETENTION_MS + EXPIRY_SKEW_MS) return 'expired';
  try {
    const found = await discoverApprovalResult(requesterState(pending, key));
    if (found.status === 'pending') return 'open';
    recordResultRef(pending, found.resultRef, found.expiresAt);
    savePending(pending);
    return 'approved';
  } catch (error) {
    if (!isApprovalClientError(error)) throw error;
    if (error.code === 'request_expired' || error.code === 'not_found') return 'expired';
    if (error.code === 'network' || error.code === 'unavailable') {
      throw new CourierError('approval-unavailable', `OpenKey could not be asked whether this expired request was approved (${error.message}). Nothing was lost: the saved request is kept. Run \`${cmd('init --wait')}\` again once OpenKey is reachable.`);
    }
    throw collectFailure(error, false);
  }
}

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
  return withProfileTransaction(async current => {
    if (loadKey().did !== key.did || current.courierDid !== profile.courierDid) throw new CourierError('profile-changed', 'The Courier key changed while requesting approval.');
    return requestApprovalInTransaction(current, key, expiry, options);
  });
}

/** Call only inside the shared profile transaction, including automated owner requests. */
export async function requestApprovalInTransaction(profile: Profile, key: AgentKey, expiry: string | undefined, options: { openkeyApiHost?: string } = {}): Promise<PendingGrantRequest> {
  const want = wanted(profile, key, expiry, options.openkeyApiHost);
  const existing = loadPendingForWrite();
  if (existing && existing.request.issuer === want.signer.did) {
    if (!holdsApproval(existing) && requestLapsed(existing) && matches(existing, profile, want)) {
      const settled = await settleLapsed(existing, key);
      if (settled === 'open') return existing;
      if (settled === 'expired') clearPending();
    }
    if (holdsApproval(existing)) {
      throw new CourierError('usage', `Approval request ${existing.requestId} has already been approved by the owner. Run \`${cmd('init --wait')}\` to finish it first; \`${cmd('init --request')}\` can ask for another approval after that. To discard that approval instead, run \`${cmd('init --rotate-key --request')}\`: it replaces the agent key, CLEARS every pairing (peers must be re-paired by hand), deletes grant.json and puts the profile back to awaiting-grant, so there is no working grant until the owner approves.`);
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
 * flags this run has; an unapproved one is replaced only when it differs from what this run asks for. A lapsed unapproved request
 * is asked about once (see settleLapsed) and dropped and reported only when OpenKey too says it is expired.
 */
export async function waitApproval(profile: Profile, key: AgentKey, expiry: string | undefined, options: Pick<WaitOptions, 'openkeyApiHost'> = {}): Promise<{ pending: PendingGrantRequest; resumed: boolean }> {
  return withProfileTransaction(async current => {
    if (loadKey().did !== key.did || current.courierDid !== profile.courierDid) throw new CourierError('profile-changed', 'The Courier key changed while requesting approval.');
    const want = wanted(current, key, expiry, options.openkeyApiHost);
    const existing = loadPendingForWrite();
    if (existing && existing.request.issuer === want.signer.did) {
      if (holdsApproval(existing)) return { pending: existing, resumed: true };
      if (matches(existing, current, want)) {
        if (requestLapsed(existing)) {
          if (await settleLapsed(existing, key) === 'expired') {
            clearPending();
            throw expiredError();
          }
        }
        return { pending: existing, resumed: true };
      }
    }
    return { pending: await createPending(current, want), resumed: false };
  });
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
  let delegationCid: string | undefined;
  try {
    const opened = await openRelayResult(resultEnvelopeOf(pending), pending.requestId, pending.relayPrivateKey);
    const claimedCid = (opened.delegation as { delegationCid?: unknown } | null | undefined)?.delegationCid;
    delegationCid = typeof claimedCid === 'string' && claimedCid !== '' ? claimedCid : undefined;
    const checked = checkApprovalResultBinding(opened, { requestId: pending.requestId, bodyCid: pending.bodyCid, request: pending.request, allowExpiredRenewal: true });
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
      throw new CourierError('grant-too-long', `The approved grant is valid for ${+((times.expiresAt.getTime() - times.issuedAt.getTime()) / DAY_MS).toFixed(2)} days, but this request asked for at most ${+(pending.request.grantLifetimeSeconds * 1000 / DAY_MS).toFixed(2)} days.`);
    }
    // A renewal stays with the owner that holds the grant: with no code to paste back, whoever approves the link first would win.
    if (profile.ownerDid && checked.ownerDid.toLowerCase() !== profile.ownerDid.toLowerCase()) {
      throw new CourierError('approval-result-invalid', `This agent is bound to owner ${profile.ownerDid}, but a different owner (${checked.ownerDid}) approved the request. Send the link only to the owner, privately. If the owner changed on purpose, run \`${cmd('init --rotate-key --request')}\` it replaces the agent key, clears every pairing (peers must be re-paired by hand) and deletes grant.json.`);
    }
    if (checked.renewal) {
      await verifyOwnerRenewal(payload, checked.ownerDid, checked.renewal);
      payload.renewal = checked.renewal;
    }
    return payload;
  } catch (error) {
    clearPending();
    throw withRefusalNotice(isApprovalClientError(error) ? new CourierError('approval-result-invalid', `The approved result was refused. ${error.message}`) : error, delegationCid);
  }
}

/** Acknowledge a saved grant. A failure is reported, never fatal: the grant is installed and the saved request keeps the ack to retry. */
async function acknowledge(pending: PendingGrantRequest, key: AgentKey): Promise<void> {
  const ref = ackRef(pending);
  if (!ref) {
    clearPending();
    return;
  }
  try {
    await ackApprovalResult(requesterState(pending, key), ref, pending.ackId, { timeoutMs: ACK_TIMEOUT_MS });
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
  const stage = stageOf(pending);
  if (stage !== 'committed') {
    if (stage !== 'result') {
      const known = knownResult(pending);
      let collected: CollectedApprovalResult | { readonly status: 'deadline' };
      try {
        collected = await collectApprovalResult(requesterState(pending, key), {
          deadline: options.deadline,
          ...(known ? { known } : {}),
          onDiscovered: (found) => {
            recordResultRef(pending, found.resultRef, found.expiresAt);
            savePending(pending);
          },
        });
      } catch (error) {
        if (!isApprovalClientError(error)) throw error;
        throw collectFailure(error, resultSeen(pending));
      }
      if (collected.status === 'deadline') return 'deadline';
      recordResultEnvelope(pending, collected.relay);
      savePending(pending); // the encrypted result is on disk before any install work
    }
    const payload = await verifiedPayload(profile, pending, key);
    assertEpisodeGrant(pending, payload);
    const spaceTimeoutMs = Math.min(MAX_SPACE_WAIT_MS, Math.max(MIN_SPACE_WAIT_MS, options.deadline + SPACE_GRACE_MS - Date.now()));
    let spaceError: CourierError | undefined;
    try {
      await installGrant(profile, key, payload, { spaceTimeoutMs });
    } catch (error) {
      if (error instanceof CourierError && error.code === 'no-space') spaceError = error; // grant and profile are saved
      else if (isClockRefusal(error) && !isPermanentRefusal(error, payload.siwe)) {
        // Refused because of THIS machine's clock (issued "in the future", no future expiry): the approval is fine and is kept.
        throw new CourierError((error as CourierError).code, `${(error as CourierError).message}\nThe system clock may be wrong. Nothing was installed and the saved approval is kept (it is not something to revoke): check the system clock, then run \`${cmd('init --wait')}\` again.`);
      } else {
        if (error instanceof CourierError && REFUSED_CODES[error.code]) clearPending();
        throw withRefusalNotice(error, payload.delegationCid);
      }
    }
    markCommitted(pending);
    savePending(pending);
    await acknowledge(pending, key);
    if (spaceError) throw spaceError;
    return 'done';
  }
  await acknowledge(pending, key);
  return 'done';
}

/** A stable pre-create binding; the saved episode also records the full actual request hash. */
export function approvalIntent(profile: Profile, key: AgentKey): string {
  const want = wanted(profile, key, undefined, undefined);
  return canonicalJson({ ...requestSpec(profile, want), lifetime: want.lifetime, apiOrigin: want.apiOrigin, linkApiOrigin: want.linkApiOrigin, openkeyOrigin: want.openkeyOrigin });
}

export function matchesApprovalIntent(pending: PendingGrantRequest, profile: Profile, key: AgentKey): boolean {
  return matches(pending, profile, wanted(profile, key, undefined, undefined));
}
