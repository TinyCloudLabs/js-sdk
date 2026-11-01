import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ackApprovalResult, checkApprovalResultBinding, collectApprovalResult, createApprovalRequest, DEFAULT_LINKS_API_ORIGIN, generateRelayKey,
  isApprovalClientError, isLinkError, openRelayResult, signerFromJwk,
  type ApprovalClientError, type ApprovalRequesterState, type CollectedApprovalResult, type CreatedLink, type Ed25519PrivateJwk, type LinkRecord,
  type LinkSigner, type OpenKeyApprovalRequestV1,
} from '@tinycloud/share-envelope/links';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { AGENT_GRANT } from './keys.js';
import { profileDir, readSecure, writeSecure, type AgentKey, type Profile } from './profile.js';
import { assertBoundToKey, installGrant, parseGrantPayload, resolveOpenKeyApiHost, type GrantPayload } from './grant.js';
import { bareDid, durationMs, siweTimes } from './authority.js';

/**
 * The OpenKey short-link approval flow (the same one `tc onboard` uses): `init --request` creates a sealed approval
 * request at the links API and saves it here; `init --wait` polls OpenKey for the result with the agent key's signed
 * proof, installs the grant, and only then acknowledges it. Every step is resumable from `approval-pending.json`.
 */
const PENDING_FILE = 'approval-pending.json';

export const DEFAULT_WAIT_MS = 90_000;
export const MAX_WAIT_MS = 9 * 60_000;
/** A pending agents space is waited for at least this long after an approval arrives, even when --timeout is nearly spent. */
const MIN_SPACE_WAIT_MS = 15_000;
const MAX_SPACE_WAIT_MS = 150_000;
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
  openkeyOrigin: string;
  apiOrigin: string;
  linkApiOrigin: string;
}

function wanted(profile: Profile, key: AgentKey, expiry: string, openkeyApiHost: string | undefined): WantedRequest {
  const jwk = requesterJwk(key);
  const signer = signerFromJwk(jwk);
  if (signer.did !== bareDid(key.did)) throw new CourierError('bad-profile', 'The agent key file does not match its did:key.');
  const lifetimeMs = durationMs(expiry);
  if (!lifetimeMs) throw new CourierError('usage', `Invalid --expiry ${expiry}.`);
  const openkeyOrigin = configuredOrigin(profile.openkeyHost, 'The OpenKey host');
  return {
    jwk, signer, lifetime: Math.floor(lifetimeMs / 1000), openkeyOrigin,
    apiOrigin: configuredOrigin(resolveOpenKeyApiHost({ flag: openkeyApiHost, env: process.env.COURIER_OPENKEY_API_HOST, openkeyHost: openkeyOrigin }), 'The OpenKey API host'),
    linkApiOrigin: configuredOrigin(process.env.TC_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API_ORIGIN, 'The links API origin'),
  };
}

function matches(pending: PendingGrantRequest, profile: Profile, want: WantedRequest): boolean {
  return pending.request.issuer === want.signer.did && pending.request.nodeOrigin === profile.host
    && pending.request.grantLifetimeSeconds === want.lifetime && pending.openkeyOrigin === want.openkeyOrigin
    && pending.apiOrigin === want.apiOrigin && pending.linkApiOrigin === want.linkApiOrigin;
}

const requestLapsed = (pending: PendingGrantRequest) => !pending.resultRef && !pending.resultEnvelope && Date.parse(pending.requestExpiresAt) <= Date.now();

async function createPending(profile: Profile, want: WantedRequest): Promise<PendingGrantRequest> {
  const relay = generateRelayKey();
  const request: OpenKeyApprovalRequestV1 = {
    issuer: want.signer.did, requestVersion: 1, targetDid: want.signer.did,
    // The schema is strict: the public key members only, never `d`.
    targetPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: want.jwk.x },
    nodeOrigin: profile.host, permissions: AGENT_GRANT.map((entry) => ({ ...entry, actions: [...entry.actions] })) as OpenKeyApprovalRequestV1['permissions'],
    reason: 'Grant the Courier agent key restricted access to this owner space. It cannot write owner approvals or orders.',
    grantLifetimeSeconds: want.lifetime, resultEncryptionPublicJwk: relay.publicJwk,
  };
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

/** `init --request`: the saved request when it is still the same and open, else a new one. */
export async function requestApproval(profile: Profile, key: AgentKey, expiry: string, options: { openkeyApiHost?: string } = {}): Promise<PendingGrantRequest> {
  const want = wanted(profile, key, expiry, options.openkeyApiHost);
  const existing = loadPending();
  if (existing && !existing.committed && matches(existing, profile, want) && !requestLapsed(existing)) return existing;
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

/** `init --wait`: the saved request (resumed), or a new one. An expired saved request is dropped and reported. */
export async function waitApproval(profile: Profile, key: AgentKey, expiry: string, options: Pick<WaitOptions, 'openkeyApiHost'> = {}): Promise<{ pending: PendingGrantRequest; resumed: boolean }> {
  const want = wanted(profile, key, expiry, options.openkeyApiHost);
  const existing = loadPending();
  if (existing && matches(existing, profile, want)) {
    if (requestLapsed(existing)) {
      clearPending();
      throw expiredError();
    }
    return { pending: existing, resumed: true };
  }
  return { pending: await createPending(profile, want), resumed: false };
}

function refuse(error: ApprovalClientError): CourierError {
  clearPending();
  switch (error.code) {
    case 'request_expired':
    case 'not_found':
      return expiredError();
    case 'result_expired':
      return new CourierError('approval-result-expired', `OpenKey keeps an approved result for only 10 minutes, and this one was not collected in time, so nothing was installed. Run \`${cmd('init --request')}\` and approve the new link, then run \`${cmd('init --wait')}\` right away.`);
    case 'acknowledged':
      return new CourierError('approval-consumed', `OpenKey says this approval was already collected. If this machine has no grant, run \`${cmd('init --request')}\` and approve the new link.`);
    default:
      return new CourierError('approval-rejected', `OpenKey refused this approval request (${error.message}). Run \`${cmd('init --request')}\` for a new link.`);
  }
}

function requesterState(pending: PendingGrantRequest, key: AgentKey): ApprovalRequesterState {
  return { requestId: pending.requestId, bodyCid: pending.bodyCid, record: pending.record, apiOrigin: pending.apiOrigin, signingKey: requesterJwk(key) };
}

/** Decrypt the saved result and check it answers this request and this key. Throws after dropping the request if it does not. */
async function verifiedPayload(pending: PendingGrantRequest, key: AgentKey): Promise<GrantPayload> {
  try {
    const opened = await openRelayResult(pending.resultEnvelope, pending.requestId, pending.relayPrivateKey);
    const checked = checkApprovalResultBinding(opened, { requestId: pending.requestId, bodyCid: pending.bodyCid, request: pending.request });
    const payload = parseGrantPayload(checked.delegation, key);
    assertBoundToKey(checked.delegation, key);
    if (`did:pkh:eip155:${payload.chainId}:${payload.address}`.toLowerCase() !== checked.ownerDid.toLowerCase()) {
      throw new CourierError('bad-grant', 'The approved result names a different owner than its delegation.');
    }
    if (siweTimes(payload.siwe).expiresAt?.toISOString() !== checked.delegationExpiresAt) {
      throw new CourierError('bad-grant', 'The approved result expiry differs from the signed delegation expiry.');
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
    await ackApprovalResult(requesterState(pending, key), pending.resultRef, pending.ackId);
    clearPending();
  } catch (error) {
    if (!isApprovalClientError(error)) throw error;
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
        if (error.code === 'unavailable') {
          throw new CourierError('approval-unavailable', `OpenKey could not be asked for the result (${error.message}). Nothing was lost: run \`${cmd('init --wait')}\` again.`);
        }
        throw refuse(error);
      }
      if (collected.status === 'deadline') return 'deadline';
      pending.resultEnvelope = collected.relay;
      savePending(pending); // the encrypted result is on disk before any install work
    }
    const payload = await verifiedPayload(pending, key);
    const spaceTimeoutMs = Math.min(MAX_SPACE_WAIT_MS, Math.max(MIN_SPACE_WAIT_MS, options.deadline - Date.now()));
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
