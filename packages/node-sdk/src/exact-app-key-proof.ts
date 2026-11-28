import { isIP } from "node:net";
import type { PersistedSessionProof, ValidatedPersistedSessionProof } from "@tinycloud/sdk-core";
import { completeSessionSetup, ensureEip55, prepareSession, TCWSessionManager, validateSessionGrant, makeSpaceId } from "@tinycloud/node-sdk-wasm";
import { DECRYPT_ACTION } from "@tinycloud/sdk-services";
import { formatKeyResource, KEY_CREATE_ABILITY } from "@tinycloud/sdk-services/encryption/resource";
import { SiweMessage } from "siwe";

export const EXACT_APP_KEY_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const CLI_STATEMENT = "TinyCloud CLI is requesting an app key.";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ExactAppKeyRequest {
  readonly optIn: boolean;
  readonly ownerDid: string;
  readonly path: string;
  /** The locally held private key, never a key returned alongside the proof. */
  readonly sessionKey: object;
  /** The exact local request before the owner chose its expiry. */
  readonly requestedSiwe: string;
}

export type ExactAppKeyProof = Omit<PersistedSessionProof, "jwk">;

/** Everything the CLI needs to start one exact app-key approval. */
export interface PreparedExactAppKeyRequest {
  readonly appKey: { readonly appId: string; readonly key: string };
  readonly request: ExactAppKeyRequest;
  /** The WASM-prepared session whose `siwe` is the exact request; pass it back to `completeSessionSetup`. */
  readonly prepared: { readonly siwe: string; readonly [field: string]: unknown };
  readonly address: string;
  readonly chainId: number;
  readonly spaceId: string;
}

export type ExactAppKeyProofResult =
  | { ok: true; resource: string; networkId: string; expiresAt: string; sessionDid: string }
  | { ok: false; reason: "not_opted_in" | "invalid_scope" | "invalid_proof" | "invalid_expiry" };

function appKeyTarget(path: string, ownerDid: string) {
  const match = /^apps\/([^/]+)\/(.+)$/.exec(path);
  if (!match || !/^did:pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40}$/.test(ownerDid)) return;
  const appId = match[1]!;
  const key = match[2]!;
  const labels = appId.split(".");
  if (labels.length < 2 || labels[0] === "localhost" || !labels.every((label) => DNS_LABEL.test(label))) return;
  const host = labels.reverse().join(".");
  if (isIP(host) || key.startsWith(`apps/${appId}/`)) return;
  try {
    if (new URL(`https://${host}`).hostname !== host) return;
    const networkId = `urn:tinycloud:encryption:${ownerDid}:default`;
    const resource = formatKeyResource(networkId, path);
    if (resource === `${networkId}/${path}`) return { appId, key, host, networkId, resource };
  } catch {
    return;
  }
}

/** Prepare one app-key ticket. The WASM spaceId is only a serialization field; no space capability is emitted. */
export function prepareExactAppKeyRequest(path: string, ownerDid: string, lifetimeMs: number): PreparedExactAppKeyRequest {
  const target = appKeyTarget(path, ownerDid);
  if (!target) throw new Error("Expected an exact key below apps/<reversed-host>/.");
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > EXACT_APP_KEY_MAX_LIFETIME_MS) {
    throw new Error("An app-key sign-in can last at most seven days.");
  }
  const address = ownerDid.slice(ownerDid.lastIndexOf(":") + 1);
  const chainId = Number(ownerDid.split(":")[3]);
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("Invalid app-key owner chain ID.");
  const manager = new TCWSessionManager();
  const sessionKey = JSON.parse(manager.jwk("default")!);
  const spaceId = makeSpaceId(address, chainId, "default");
  const now = Date.now();
  const prepared = prepareSession({
    abilities: {},
    rawAbilities: { [target.resource]: [DECRYPT_ACTION, KEY_CREATE_ABILITY] },
    address, chainId, domain: target.host, spaceId, jwk: sessionKey,
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + lifetimeMs).toISOString(),
  });
  // WASM emits the canonical ReCap statement and ignores custom statements.
  // Add the fixed CLI attribution before sending any bytes for approval.
  const statement = new SiweMessage(prepared.siwe).statement;
  const line = `\n${statement}\n`;
  const start = prepared.siwe.indexOf(line);
  if (!statement || start < 0 || prepared.siwe.indexOf(line, start + 1) !== -1) {
    throw new Error("Could not prepare the app-key approval statement.");
  }
  const requestedSiwe = `${prepared.siwe.slice(0, start + 1)}${CLI_STATEMENT} ${prepared.siwe.slice(start + 1)}`;
  return {
    appKey: { appId: target.appId, key: target.key },
    request: { optIn: true, ownerDid, path, sessionKey, requestedSiwe } satisfies ExactAppKeyRequest,
    prepared: { ...prepared, siwe: requestedSiwe },
    address, chainId, spaceId,
  };
}

/** Verify a candidate raw app-key grant, not a profile's ability to restore or use it. */
export function verifyExactAppKeyProof(
  request: ExactAppKeyRequest,
  proof: ExactAppKeyProof,
): ExactAppKeyProofResult {
  if (request.optIn !== true) return { ok: false, reason: "not_opted_in" };
  const { ownerDid, path, sessionKey } = request;
  const target = appKeyTarget(path, ownerDid);
  if (!target) return { ok: false, reason: "invalid_scope" };
  const { resource, networkId } = target;

  let verified: ValidatedPersistedSessionProof;
  try {
    // The WASM verifier checks the signature, owner address and chain, session-key
    // audience and the CID/header rebuilt from those exact signed SIWE bytes.
    verified = validateSessionGrant({ ...proof, jwk: sessionKey });
    if (`did:pkh:eip155:${proof.chainId}:${ensureEip55(proof.address)}` !== ownerDid) {
      return { ok: false, reason: "invalid_proof" };
    }
  } catch {
    return { ok: false, reason: "invalid_proof" };
  }

  const { verifiedRecap, expiresAt } = verified;
  if (verifiedRecap === undefined) return { ok: false, reason: "invalid_proof" };
  let create = false;
  let decrypt = false;
  for (const row of verifiedRecap) {
    if (row.service !== "encryption" || row.space !== "encryption" || row.path !== resource ||
      row.caveats.some((caveat) => (caveat instanceof Map ? caveat.size : Object.keys(caveat).length) !== 0)) {
      return { ok: false, reason: "invalid_scope" };
    }
    for (const action of row.actions) {
      if (action === KEY_CREATE_ABILITY && !create) create = true;
      else if (action === DECRYPT_ACTION && !decrypt) decrypt = true;
      else return { ok: false, reason: "invalid_scope" };
    }
  }
  if (!create || !decrypt) return { ok: false, reason: "invalid_scope" };

  // No wire field besides the one expiration line may change. Check the exact
  // local request (including the app domain and CLI attribution), then bound
  // the accepted end by both original signed issuance and requested expiry.
  let signed: SiweMessage;
  let requested: SiweMessage;
  try {
    signed = new SiweMessage(proof.siwe);
    requested = new SiweMessage(request.requestedSiwe);
  } catch {
    return { ok: false, reason: "invalid_proof" };
  }
  const expiryLine = /^Expiration Time: [^\r\n]+$/gm;
  if (!proof.siwe.startsWith(`${target.host} wants you to sign in with your Ethereum account:\n`) ||
    !signed.statement?.startsWith(`${CLI_STATEMENT} I further authorize `) ||
    signed.resources?.length !== 1 || !signed.resources[0]?.startsWith("urn:recap:") ||
    Array.from(proof.siwe.matchAll(expiryLine)).length !== 1 ||
    Array.from(request.requestedSiwe.matchAll(expiryLine)).length !== 1 ||
    proof.siwe.replace(expiryLine, "Expiration Time: <>") !== request.requestedSiwe.replace(expiryLine, "Expiration Time: <>")) {
    return { ok: false, reason: "invalid_proof" };
  }
  const end = Date.parse(expiresAt ?? "");
  const issued = Date.parse(signed.issuedAt ?? "");
  const requestedEnd = Date.parse(requested.expirationTime ?? "");
  const now = Date.now();
  if (expiresAt === undefined || !Number.isFinite(end) || !Number.isFinite(issued) || !Number.isFinite(requestedEnd) ||
    end <= issued || end <= now || end > requestedEnd || requestedEnd - issued > EXACT_APP_KEY_MAX_LIFETIME_MS) {
    return { ok: false, reason: "invalid_expiry" };
  }
  return { ok: true, resource, networkId, expiresAt, sessionDid: signed.uri };
}

/** What OpenKey's sign route returns that matters here. Its permissions echo is never trusted. */
export interface ExactAppKeyApproval {
  readonly signedMessage: string;
  readonly signature: string;
  readonly address: string;
}

/** The proof for the signed bytes OpenKey returned, as plain JSON that is safe to save. */
export function buildExactAppKeyProof(built: PreparedExactAppKeyRequest, approval: ExactAppKeyApproval): ExactAppKeyProof {
  const { signedMessage: siwe, signature, address } = approval;
  const { jwk: _jwk, ...setup } = completeSessionSetup({ ...built.prepared, siwe, signature }) as Record<string, unknown>;
  return JSON.parse(JSON.stringify({
    ...setup, spaceId: built.spaceId, address, chainId: built.chainId, siwe, signature,
  })) as ExactAppKeyProof;
}
