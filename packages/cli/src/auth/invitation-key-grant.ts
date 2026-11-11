import { NodeWasmBindings, type PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { CLIError } from "../output/errors.js";

const KEY_ACTIONS = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
const FUTURE_ISSUE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

function refuse(message: string): never {
  throw new CLIError("APPROVAL_RESULT_INVALID", message, ExitCode.PERMISSION_DENIED);
}

/**
 * The owner-signed SIWE names the one request it answers: exactly one `Request ID:` field equal to
 * `urn:tinycloud:approval-request:<requestId>:<bodyCid>` of THIS profile's own pending request. An approval signed for another
 * request, or one without the field, is refused before its key is used.
 */
export function assertApprovalRequestBinding(siwe: string, request: { requestId: string; bodyCid: string }): void {
  const lines = siwe.split("\n").filter((line) => line.startsWith("Request ID:"));
  if (lines.length !== 1 || lines[0] !== `Request ID: urn:tinycloud:approval-request:${request.requestId}:${request.bodyCid}`) {
    refuse("The approval was not signed for this invitation request; no invitation was sent.");
  }
}

/**
 * The signed result of one invitation approval: exactly one `key.create` + `decrypt` pair on one canonical
 * `<owner default network>/share/<32 lowercase hex>` key, nothing else, expiring within the acceptance window and lasting at
 * most 24 hours. No slack: the bounds are exact. Returns the key id, which only the signed grant may supply.
 */
export function invitationKeyFromGrant(
  permissions: readonly PermissionEntry[],
  input: { ownerDid: string; issuedAt: string; expiresAt: string; acceptanceExpiresAt: string; now?: number },
): string {
  const now = input.now ?? Date.now();
  const prefix = `urn:tinycloud:encryption:${input.ownerDid}:default/share/`;
  const ids = new Set<string>();
  const actions = new Set<string>();
  for (const entry of permissions) {
    // The space an encryption entry is reported under names no further resource: the path pins the key and its owner.
    const id = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : "";
    if (entry.service !== "tinycloud.encryption" || !/^[a-f0-9]{32}$/.test(id) || (entry.caveats?.length ?? 0) > 0 ||
      !entry.actions.every((action) => KEY_ACTIONS.includes(action))) {
      refuse("The approval holds more than one invitation key and nothing else; no invitation was sent.");
    }
    ids.add(id);
    for (const action of entry.actions) actions.add(action);
  }
  if (ids.size !== 1 || !KEY_ACTIONS.every((action) => actions.has(action))) {
    refuse("The approval does not hold key.create and decrypt on exactly one invitation key; no invitation was sent.");
  }
  const issued = Date.parse(input.issuedAt);
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expiry)) refuse("The invitation approval has no signed lifetime; no invitation was sent.");
  if (issued > now + FUTURE_ISSUE_MS) refuse("The invitation approval was issued in the future; no invitation was sent.");
  if (expiry <= now) refuse("The invitation approval has expired; no invitation was sent.");
  if (expiry - issued > DAY_MS || expiry > Date.parse(input.acceptanceExpiresAt)) {
    refuse("The approval lasts longer than the invitation it was requested for; no invitation was sent.");
  }
  return [...ids][0]!;
}

/** What `verifyInvitationGrant` returns: the key id and the exact signed facts it was read from. */
export interface VerifiedInvitationGrant {
  shareId: string;
  ownerDid: string;
  issuedAt: string;
  expiresAt: string;
  permissions: PermissionEntry[];
}

/**
 * Verify one approval result for THIS request, from the owner-signed SIWE alone: the request binding, the signature and
 * holder (a raw encryption grant has no space, so it is verified as a grant, never restored as a session), the owner, and the
 * exact key pair and lifetime. Nothing the result says about itself outside the signed bytes is trusted.
 */
export function verifyInvitationGrant(
  data: Record<string, unknown>,
  key: object,
  expected: { targetDid: string; ownerDid: string; request: { requestId: string; bodyCid: string }; acceptanceExpiresAt: string; now?: number },
): VerifiedInvitationGrant {
  const text = (value: unknown): string => (typeof value === "string" ? value : refuse("OpenKey did not return a complete, verifiable invitation approval; no invitation was sent."));
  const siwe = text(data.siwe);
  const signature = text(data.signature);
  const address = text(data.address);
  const delegationCid = text(data.delegationCid);
  const spaceId = text(data.spaceId);
  const verificationMethod = text(data.verificationMethod);
  const header = data.delegationHeader as { Authorization?: unknown } | undefined;
  if (!Number.isSafeInteger(data.chainId) || typeof header?.Authorization !== "string" || verificationMethod.split("#")[0] !== expected.targetDid.split("#")[0]) {
    refuse("The invitation approval was not issued to this profile's key; no invitation was sent.");
  }
  assertApprovalRequestBinding(siwe, expected.request);
  const bindings = new NodeWasmBindings();
  if (typeof bindings.validateSessionGrant !== "function") refuse("This runtime cannot verify invitation approvals; no invitation was sent.");
  let proof: { verifiedRecap?: Array<{ service: string; space: string; path: string; actions: string[]; caveats?: unknown[] }>; expiresAt?: string };
  try {
    proof = bindings.validateSessionGrant({
      delegationHeader: { Authorization: header.Authorization }, delegationCid, spaceId, jwk: key, address, chainId: data.chainId as number, siwe, signature,
    });
  } catch {
    refuse("OpenKey did not return a complete, verifiable invitation approval; no invitation was sent.");
  }
  if (!proof.verifiedRecap?.length || typeof proof.expiresAt !== "string") refuse("The invitation approval has no signed authority; no invitation was sent.");
  const ownerDid = `did:pkh:eip155:${data.chainId}:${address}`;
  if (normalizePkhIdentifier(ownerDid) !== normalizePkhIdentifier(expected.ownerDid)) {
    refuse("The approval was given by a different account than this profile's owner; no invitation was sent.");
  }
  const permissions = proof.verifiedRecap.map((entry): PermissionEntry => {
    const service = entry.service.startsWith("tinycloud.") ? entry.service : `tinycloud.${entry.service}`;
    return { service, space: entry.space, path: entry.path, actions: entry.actions.map((action) => (action.includes("/") ? action : `${service}/${action}`)),
      ...(entry.caveats?.length ? { caveats: [...entry.caveats] as never } : {}) };
  });
  const issuedAt = /^Issued At:\s*(.+)$/m.exec(siwe)?.[1]?.trim() ?? "";
  const shareId = invitationKeyFromGrant(permissions, { ownerDid, issuedAt, expiresAt: proof.expiresAt, acceptanceExpiresAt: expected.acceptanceExpiresAt, now: expected.now });
  return { shareId, ownerDid, issuedAt, expiresAt: proof.expiresAt, permissions };
}
