import { SiweMessage } from "siwe";
import { canonicalizeAddress, principalDidEquals, verifyEip191MessageSignature } from "../identity";

export interface NewShareApprovalIdentity {
  requestId: string;
  shareId: string;
  ownerDid: string;
  sessionDid: string;
  origin: string;
  preparedSiwe: string;
  expiresAt: number;
}
export interface NewShareApprovalResult {
  purpose: "share-create";
  requestId: string;
  shareId: string;
  ownerDid: string;
  sessionDid: string;
  origin: string;
  prepared: { siwe: string; [key: string]: unknown };
  signature: string;
}
export interface NewShareApprovalExpected {
  /** Identity pinned by the OpenKey-origin transport before approval. */
  identity: NewShareApprovalIdentity;
  ownerAddress: string;
  chainId: number;
  sessionDid: string;
  origin: string;
  sessionExpiresAt: number;
  requestedExpiresAt: number;
  fileGrants: readonly { resource: string; actions: readonly string[] }[];
}

/** Verify before completing or activating the returned grant. No authority comes from result sidecars. */
export async function verifyNewShareApproval(value: unknown, expected: NewShareApprovalExpected, now = Date.now()) {
  if (!value || typeof value !== "object") throw new Error("Invalid new-share approval");
  const result = structuredClone(value) as NewShareApprovalResult;
  expected = structuredClone(expected);
  const pinned = expected.identity;
  const origin = new URL(expected.origin);
  const ownerAddress = canonicalizeAddress(expected.ownerAddress);
  const ownerDid = `did:pkh:eip155:${expected.chainId}:${ownerAddress}`;
  if (origin.protocol !== "https:" || origin.origin !== expected.origin || !Number.isFinite(pinned.expiresAt) || pinned.expiresAt <= now ||
    !Number.isFinite(expected.sessionExpiresAt) || !Number.isFinite(expected.requestedExpiresAt) ||
    !/^[A-Za-z0-9_-]{43}$/.test(pinned.requestId) ||
    !/^[0-9a-f]{32}$/.test(pinned.shareId) || result.purpose !== "share-create" ||
    result.requestId !== pinned.requestId || result.shareId !== pinned.shareId ||
    result.origin !== pinned.origin || pinned.origin !== expected.origin ||
    !principalDidEquals(pinned.ownerDid, ownerDid) || result.ownerDid !== pinned.ownerDid ||
    !principalDidEquals(pinned.sessionDid, expected.sessionDid) || result.sessionDid !== pinned.sessionDid ||
    !result.prepared || result.prepared.siwe !== pinned.preparedSiwe || typeof result.signature !== "string") {
    throw new Error("New-share approval does not match the current request");
  }
  const message = new SiweMessage(result.prepared.siwe);
  const expiry = Date.parse(message.expirationTime ?? "");
  if (message.prepareMessage() !== result.prepared.siwe || message.domain !== origin.host ||
    (message.scheme !== undefined && message.scheme !== "https") ||
    canonicalizeAddress(message.address) !== ownerAddress || message.chainId !== expected.chainId ||
    !principalDidEquals(message.uri, expected.sessionDid) ||
    !Number.isFinite(expiry) || expiry <= now || expiry > expected.sessionExpiresAt || expiry > expected.requestedExpiresAt ||
    (message.notBefore !== undefined && Date.parse(message.notBefore) > now)) {
    throw new Error("New-share signed authorization has invalid bindings or expiry");
  }
  const resources = message.resources ?? [];
  if (resources.length !== 1 || !resources[0]!.startsWith("urn:recap:")) throw new Error("New-share approval requires one ReCap");
  const token = resources[0]!.slice("urn:recap:".length);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid new-share ReCap");
  const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  if (btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== token) throw new Error("Invalid new-share ReCap");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  const recap = JSON.parse(json);
  if (JSON.stringify(recap) !== json || !recap.att || typeof recap.att !== "object" || Array.isArray(recap.att) ||
    Object.keys(recap).some(key => key !== "att" && key !== "prf") ||
    (recap.prf !== undefined && (!Array.isArray(recap.prf) || recap.prf.length !== 0))) throw new Error("Invalid new-share ReCap");
  const resource = `urn:tinycloud:encryption:${ownerDid}:default/share/${pinned.shareId}`;
  const grants = new Map<string, Set<string>>([[resource, new Set(["tinycloud.encryption/decrypt"])]]);
  for (const grant of expected.fileGrants) {
    const file = /^tinycloud:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40}):([^/]+)\/kv\/(.+)$/.exec(grant.resource);
    if (!file || Number(file[1]) !== expected.chainId || canonicalizeAddress(file[2]!) !== ownerAddress ||
      grant.resource.endsWith("/") || grant.resource.includes("*") || grant.actions.length === 0 ||
      grant.actions.some(action => action !== "tinycloud.kv/get" && action !== "tinycloud.kv/metadata")) throw new Error("Invalid new-share file scope");
    const actions = grants.get(grant.resource) ?? new Set<string>();
    for (const action of grant.actions) actions.add(action);
    grants.set(grant.resource, actions);
  }
  if (Object.keys(recap.att).length !== grants.size) throw new Error("New-share approval changed the requested scope");
  for (const [target, actions] of grants) {
    const granted = recap.att[target];
    if (!granted || typeof granted !== "object" || Array.isArray(granted) || Object.keys(granted).length !== actions.size ||
      [...actions].some(action => JSON.stringify(granted[action]) !== "[{}]")) throw new Error("New-share approval changed the requested scope");
  }
  if (!(await verifyEip191MessageSignature(result.prepared.siwe, result.signature, ownerAddress))) throw new Error("New-share approval signature does not match its owner");
  return Object.freeze({ requestId: pinned.requestId, shareId: pinned.shareId, resource, ownerDid,
    sessionDid: expected.sessionDid, origin: expected.origin, signedMessage: result.prepared.siwe,
    signature: result.signature, expiresAt: expiry });
}
