/**
 * The hosted server's side of an OpenKey approval request. The tenant's own
 * session key signs the request (the request's issuer is the key being
 * delegated to), a fresh P-256 relay key receives the encrypted result, and
 * the result is collected from the configured OpenKey API origin only. Every
 * value a restart needs is in `OpenKeyRequestState`, which the caller keeps in
 * the pending-approval file.
 */
import { randomUUID } from "node:crypto";

import {
  ackApprovalResult,
  checkApprovalResultBinding,
  createApprovalRequest,
  discoverApprovalResult,
  fetchApprovalResult,
  generateRelayKey,
  openRelayResult,
  signerFromJwk,
  type ApprovalRequesterState,
  type CheckedApprovalResult,
  type Ed25519PrivateJwk,
  type LinkRecord,
  type OpenKeyApprovalRequestV1,
} from "@tinycloud/share-envelope/links";
import type { PermissionEntry } from "@tinycloud/node-sdk";

/** Where approval requests are stored and where their results are collected. */
export interface OpenKeyEndpoints {
  /** OpenKey web origin; approval links open here. */
  readonly openkeyOrigin: string;
  /** OpenKey API origin; the only origin results are fetched from. */
  readonly openkeyApiOrigin: string;
  /** Links API origin that stores the signed request. */
  readonly linksApiOrigin: string;
}

/** One OpenKey approval request made for a pending approval. */
export interface OpenKeyRequestState {
  readonly requestId: string;
  readonly bodyCid: string;
  readonly record: Pick<LinkRecord, "header" | "signature">;
  readonly link: string;
  readonly request: OpenKeyApprovalRequestV1;
  /** When the request stops accepting an approval. */
  readonly expiresAt: string;
  /** The relay private key the result is encrypted to. Never logged or sent. */
  readonly relayPrivateKey: string;
  readonly ackId: string;
  /** The OpenKey API origin this request's result may be fetched from. */
  readonly apiOrigin: string;
  readonly resultRef?: string;
  readonly resultExpiresAt?: string;
  /** Set once the approval is stored; only the acknowledgement remains. */
  readonly storedCid?: string;
}

/** A short pause before a link's request ends, so an approval started near its end can finish. */
const MIN_REQUEST_LIFE_MS = 180_000;

export async function createOpenKeyRequest(
  endpoints: OpenKeyEndpoints,
  input: {
    readonly jwk: Record<string, unknown>;
    readonly nodeHost: string;
    readonly permissions: readonly PermissionEntry[];
    readonly reason: string;
    readonly grantLifetimeSeconds: number;
    readonly expiresAt: Date;
  },
): Promise<OpenKeyRequestState> {
  const signingKey = ed25519PrivateJwk(input.jwk);
  const signer = signerFromJwk(signingKey);
  const relay = generateRelayKey();
  const request: OpenKeyApprovalRequestV1 = {
    issuer: signer.did,
    requestVersion: 1,
    targetDid: signer.did,
    targetPublicJwk: { kty: signingKey.kty, crv: signingKey.crv, x: signingKey.x },
    nodeOrigin: new URL(input.nodeHost).origin,
    permissions: input.permissions.map(requestPermission),
    reason: input.reason,
    grantLifetimeSeconds: input.grantLifetimeSeconds,
    resultEncryptionPublicJwk: relay.publicJwk,
  };
  const expiresAt = new Date(Math.max(input.expiresAt.getTime(), Date.now() + MIN_REQUEST_LIFE_MS));
  const created = await createApprovalRequest({
    request,
    issuerKey: signer,
    apiOrigin: endpoints.linksApiOrigin,
    openkeyOrigin: endpoints.openkeyOrigin,
    expiresAt,
  });
  return {
    requestId: created.id,
    bodyCid: created.bodyCid,
    record: { header: created.record.header, signature: created.record.signature },
    link: created.link,
    request,
    expiresAt: created.expiresAt,
    relayPrivateKey: relay.privateKey,
    ackId: randomUUID(),
    apiOrigin: endpoints.openkeyApiOrigin,
  };
}

/** What one collection attempt found. */
export type OpenKeyCollection =
  | { readonly status: "pending" }
  | { readonly status: "discovered"; readonly resultRef: string; readonly resultExpiresAt: string }
  | { readonly status: "ready"; readonly checked: CheckedApprovalResult };

/**
 * One step towards the result: discover its reference, or fetch, open and
 * bind it. The caller saves a discovered reference before the next step.
 * Throws `ApprovalClientError` for every OpenKey refusal and transport failure.
 */
export async function collectOpenKeyResult(
  state: OpenKeyRequestState,
  jwk: Record<string, unknown>,
  timeoutMs: number,
): Promise<OpenKeyCollection> {
  const requester = requesterState(state, jwk);
  if (state.resultRef === undefined || state.resultExpiresAt === undefined) {
    const discovered = await discoverApprovalResult(requester, { timeoutMs });
    if (discovered.status === "pending") return discovered;
    return { status: "discovered", resultRef: discovered.resultRef, resultExpiresAt: discovered.expiresAt };
  }
  const relay = await fetchApprovalResult(
    requester,
    { resultRef: state.resultRef, expiresAt: state.resultExpiresAt },
    { timeoutMs },
  );
  const opened = await openRelayResult(relay, state.requestId, state.relayPrivateKey);
  return {
    status: "ready",
    checked: checkApprovalResultBinding(opened, {
      requestId: state.requestId,
      bodyCid: state.bodyCid,
      request: state.request,
    }),
  };
}

/** Acknowledge a stored result so OpenKey can discard it. */
export async function ackOpenKeyResult(
  state: OpenKeyRequestState,
  jwk: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  if (state.resultRef === undefined) return;
  await ackApprovalResult(requesterState(state, jwk), state.resultRef, state.ackId, { timeoutMs });
}

/** Parse a delegation lifetime such as `30d`, `1h` or `90s` into seconds. */
export function lifetimeSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(value);
  const unit = match === null ? undefined : { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }[match[2] as "s" | "m" | "h" | "d" | "w"];
  const seconds = match === null || unit === undefined ? Number.NaN : Number(match[1]) * unit;
  if (!Number.isSafeInteger(seconds) || seconds < 60) {
    throw new Error("TC_MCP_DELEGATION_EXPIRY must be a duration of at least 60 seconds, such as 1h or 30d.");
  }
  return seconds;
}

function requesterState(state: OpenKeyRequestState, jwk: Record<string, unknown>): ApprovalRequesterState {
  return {
    requestId: state.requestId,
    bodyCid: state.bodyCid,
    record: state.record,
    apiOrigin: state.apiOrigin,
    signingKey: ed25519PrivateJwk(jwk),
  };
}

function requestPermission(entry: PermissionEntry): OpenKeyApprovalRequestV1["permissions"][number] {
  if (entry.space === undefined || entry.space.length === 0) {
    throw new Error("An approval request needs a space for every permission.");
  }
  return {
    service: entry.service,
    space: entry.space,
    path: entry.path,
    actions: [...entry.actions],
    ...(entry.caveats === undefined ? {} : { caveats: [...entry.caveats] }),
  };
}

function ed25519PrivateJwk(jwk: Record<string, unknown>): Ed25519PrivateJwk {
  const { kty, crv, x, d } = jwk;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof d !== "string") {
    throw new Error("The tenant key is not an Ed25519 private key.");
  }
  return { kty, crv, x, d };
}
