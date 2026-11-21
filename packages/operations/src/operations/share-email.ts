import { randomUUID } from "node:crypto";
import { z } from "zod";
import { emailProofDescriptor, EmailProofError } from "@tinycloud/node-sdk/credentials";
import type { CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import {
  extractSiweExpiration,
  ManifestValidationError,
  type TinyCloudNode,
} from "@tinycloud/node-sdk";
import { publishEmailShareV3 } from "@tinycloud/node-sdk/share-publish";
import { revokePolicyRootV3 } from "@tinycloud/sdk-core";
import { POLICY_ROOT_MAX_LIFETIME_SECONDS } from "@tinycloud/share-envelope";
import { fromBase64Url } from "@tinycloud/share-envelope";
import { createLink, DEFAULT_LINKS_API_ORIGIN, LINK_MIN_LIFE_SECONDS } from "@tinycloud/share-envelope/links";
import {
  bindPathBoundContentSource,
  deliverCredentialInvitation,
  historyRecordForPublishedShare,
  encryptAddressedShareContent,
  planPathBoundShare,
  prepareAddressedShare,
  type AddressedSharePublishOptions,
  type CredentialInvitationReceipt,
  type PathBoundSharePlan,
  type PublishedShare,
  type SenderShareRecordStorage,
} from "@tinycloud/share-sdk";

import type {
  CapabilityRequirement,
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  OperationExposure,
  OperationSensitivity,
  RuntimeOperationContext,
  TinyCloudPosture,
} from "../contract.js";
import { operationError, type OperationErrorCode } from "../errors.js";
import { requestInvitationApproval, type InvitationApprovalOutcome } from "../invitation-approval.js";
import { openProfileShareHistory } from "../share-history.js";
import { resolveGenericKvSpace } from "./exploration.js";

/** The share service whose public config names the registry and the credentials service. */
const SHARE_ORIGIN = "https://share.tinycloud.xyz";
const MIN_SECONDS = LINK_MIN_LIFE_SECONDS;
/** A short link's longest life. Every share here is sent as a short link, so this is the longest a share lasts. */
const MAX_SECONDS = 30 * 86_400;
const DEFAULT_SECONDS = 7 * 86_400;
const MAX_CONTENT_BYTES = 1_048_576;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MEDIA_TYPES = { md: "text/markdown", txt: "text/plain", html: "text/html", json: "application/json" } as const;

export interface ShareEmailInput {
  readonly content: string;
  readonly filename: string;
  readonly recipient: string;
  readonly expiresInSeconds?: number;
}

export interface ShareEmailOutput {
  /** Whether the recipient can open the share now. */
  readonly shared: boolean;
  readonly shareId: string;
  readonly recipient: string;
  readonly expiresAt: string;
  readonly delivery: "sent" | "failed";
  /** Present when delivery failed: whether the share was revoked again. Only `true` once the node confirmed it. */
  readonly revoked?: boolean;
  readonly message: string;
}

const ShareEmailInputSchema: z.ZodType<ShareEmailInput, z.ZodTypeDef, ShareEmailInput> = z.object({
  content: z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= MAX_CONTENT_BYTES, {
    message: `content is longer than ${MAX_CONTENT_BYTES} bytes`,
  }),
  filename: z.string().regex(FILENAME, "filename must be 1-100 characters of A-Z, a-z, 0-9, '.', '_' or '-', starting with a letter or digit")
    .refine((value) => !value.includes(".."), { message: "filename must not contain '..'" }),
  recipient: z.string().min(3).max(254),
  expiresInSeconds: z.number().int().min(MIN_SECONDS).max(MAX_SECONDS).optional(),
}).strict();

const ShareEmailOutputSchema: z.ZodType<ShareEmailOutput> = z.object({
  shared: z.boolean(),
  shareId: z.string(),
  recipient: z.string(),
  expiresAt: z.string(),
  delivery: z.enum(["sent", "failed"]),
  revoked: z.boolean().optional(),
  message: z.string(),
}).strict();

const POSTURES: readonly TinyCloudPosture[] = ["delegate-session", "owner-openkey", "local-owner-key"];

const EXPOSURE: OperationExposure = {
  // The CLI keeps its own publisher (`tinycloud share publish`).
  cli: { status: "excluded", reason: "The CLI publishes through `tinycloud share publish --to <email>`." },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};

// The share link carries the read key in its fragment and never leaves this operation, so neither it nor the content is an output.
const SENSITIVITY: OperationSensitivity = { input: ["/content"], output: [] };

export const shareEmailOperationDefinition: OperationDefinition<ShareEmailInput, ShareEmailOutput> = {
  id: "tinycloud.share.publish_email",
  version: 1,
  title: "Share a file with one email address",
  description:
    "Encrypt a text file and share it with one email address. Only the person who proves that address through the TinyCloud OpenCredentials issuer can open it, and TinyCloud emails them the invitation. If this session cannot decrypt, the owner is first asked to approve the share's own key. The permission it needs lets the agent save, read and delete files under the owner's `shares/` folder, so it can delete the owner's other shares and see their encrypted copies, but it can't open them; tell the owner so when you ask. Every share is recorded in the owner's share history, so `tinycloud share list` shows it and `tinycloud share revoke <id>` ends it.",
  input: ShareEmailInputSchema,
  output: ShareEmailOutputSchema,
  effects: ["write", "external"],
  runtime: "authenticated",
  postures: POSTURES,
  exposure: EXPOSURE,
  sensitivity: SENSITIVITY,
  authority: planShareEmail,
  execute: executeShareEmailOperation,
};

export const shareEmailOperationDefinitions: readonly [typeof shareEmailOperationDefinition] = [
  shareEmailOperationDefinition,
];

/**
 * The encrypted copy and its policy live under `shares/` in the owner's default space. The key's own decrypt
 * authority is not planned here: an owner can give it only for one invitation, through the invitation approval below.
 */
async function planShareEmail(context: RuntimeOperationContext): Promise<readonly CapabilityRequirement[]> {
  return [{
    service: "tinycloud.kv",
    space: resolveGenericKvSpace(context, "default"),
    path: "shares/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put", "tinycloud.kv/del"],
  }];
}

export type ShareEmailNode = Pick<TinyCloudNode,
  | "isSessionOnly" | "restorableSession" | "credentialHolderDid" | "keys" | "getDefaultEncryptionNetworkId"
  | "hasRuntimePermissions" | "getRuntimePermissionDelegations" | "activeNodeIdentity" | "publishActiveNodeLocation"
  | "kvForSpace" | "createUnifiedOwnerRoot" | "signSessionBytes" | "registerPolicy" | "authorizeShareDeliveryV3"
  | "spaceId" | "resourceTransport">;

/** The encrypted file and the content source that binds the policy to it. */
export interface SealedShareContent {
  readonly storedBytes: Uint8Array;
  readonly contentSource: AddressedSharePublishOptions["contentSource"];
}

/** Everything outside this process, so a test can stand in for it. */
export interface ShareEmailPorts {
  /** The profile's sender history, the one `tinycloud share list` and `share revoke` read. */
  readonly openHistory: (input: { readonly profile: string; readonly node: ShareEmailNode }) => SenderShareRecordStorage;
  readonly sealContent: (input: {
    readonly plan: PathBoundSharePlan; readonly node: ShareEmailNode; readonly plaintext: Uint8Array;
    readonly mediaType: string; readonly kvResource: string;
  }) => Promise<SealedShareContent>;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly emailProofDescriptor: typeof emailProofDescriptor;
  readonly requestInvitationApproval: typeof requestInvitationApproval;
  readonly publishEmailShareV3: typeof publishEmailShareV3;
  readonly deliverCredentialInvitation: typeof deliverCredentialInvitation;
  readonly createLink: typeof createLink;
  readonly revokePolicyRootV3: typeof revokePolicyRootV3;
}

const DEFAULT_PORTS: ShareEmailPorts = {
  openHistory: ({ profile, node }) => openProfileShareHistory({ profile, signSessionBytes: (bytes) => node.signSessionBytes(bytes) }),
  async sealContent({ plan, node, plaintext, mediaType, kvResource }) {
    const encrypted = await encryptAddressedShareContent({ plan, keys: node.keys, plaintext, metadata: { contentType: mediaType } });
    return {
      storedBytes: encrypted.storedBytes,
      contentSource: bindPathBoundContentSource({ plan, envelope: encrypted.envelope, storedBytes: encrypted.storedBytes, kvResource, selector: "exact" }),
    };
  },
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  emailProofDescriptor,
  requestInvitationApproval,
  publishEmailShareV3,
  deliverCredentialInvitation,
  createLink,
  revokePolicyRootV3,
};

function executeShareEmailOperation(
  context: OperationContext,
  input: ShareEmailInput,
): Promise<OperationExecutionOutcome<ShareEmailOutput>> {
  return executeShareEmail(context, input, DEFAULT_PORTS);
}

const NAMED_KEY_PATH_MESSAGE = "Manifest validation failed: named keys go in manifest.keys";

/** Whether this session already holds decrypt on exactly this share key (a runtime grant naming it), which an owner session without it does not. */
function holdsKeyDecrypt(node: ShareEmailNode, keyResource: string): boolean {
  try {
    return node.hasRuntimePermissions([{ service: "tinycloud.encryption", path: keyResource, actions: ["tinycloud.encryption/decrypt"] }]);
  } catch (error) {
    if (!(error instanceof ManifestValidationError) || error.message !== NAMED_KEY_PATH_MESSAGE) throw error;
    const now = Date.now();
    return node.getRuntimePermissionDelegations().some((delegation) => delegation.expiry.getTime() > now &&
      (delegation.resources ?? []).some((resource) => resource.service === "encryption" && resource.path === keyResource && resource.actions.includes("tinycloud.encryption/decrypt")));
  }
}

function failure(code: OperationErrorCode, message: string, retryable = false): OperationExecutionOutcome<ShareEmailOutput> {
  return { status: "error", error: operationError(code, message, { retryable }) };
}

export async function executeShareEmail(
  context: OperationContext,
  input: ShareEmailInput,
  ports: ShareEmailPorts,
): Promise<OperationExecutionOutcome<ShareEmailOutput>> {
  const node = context.runtime?.node as ShareEmailNode | undefined;
  if (node === undefined) return failure("INTERNAL_ERROR", "The TinyCloud node is not available to share this file.");
  const ownerDid = context.summary.ownerDid;
  const profile = context.summary.profile;

  // 1. Everything that can be checked without the owner or the network.
  let recipient: string;
  try {
    const target = prepareAddressedShare({
      target: { kind: "email", address: input.recipient },
      actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"], filename: input.filename,
    }).target;
    if (target.kind !== "email") throw new TypeError("not an email address");
    recipient = target.address;
  } catch {
    return failure("INPUT_INVALID", "recipient must be one email address.");
  }
  const session = node.restorableSession;
  const ownerSpaceId = session?.spaceId;
  if (ownerSpaceId === undefined || ownerDid === undefined) {
    return failure("AUTH_REQUIRED", "This session has no owner space to share from.");
  }
  const now = ports.now();
  let expiresAtMs = now + (input.expiresInSeconds ?? DEFAULT_SECONDS) * 1000;
  if (node.isSessionOnly && session?.siwe !== undefined) {
    let sessionEnd: Date | undefined;
    try { sessionEnd = extractSiweExpiration(session.siwe); } catch { sessionEnd = undefined; }
    if (sessionEnd === undefined) return failure("AUTH_REQUIRED", "This session's expiry cannot be read.");
    if (sessionEnd.getTime() <= now + 60_000) return failure("AUTH_REQUIRED", "This session ends too soon to share from.");
    if (expiresAtMs > sessionEnd.getTime()) {
      if (input.expiresInSeconds !== undefined) return failure("INPUT_INVALID", "expiresInSeconds goes beyond the end of this session.");
      expiresAtMs = sessionEnd.getTime();
    }
  }
  let expiresAt = new Date(Math.floor(expiresAtMs / 1000) * 1000);
  if ((expiresAt.getTime() - now) / 1000 < MIN_SECONDS) return failure("INPUT_INVALID", "The share would last less than two minutes.");
  if ((expiresAt.getTime() - now) / 1000 > POLICY_ROOT_MAX_LIFETIME_SECONDS) return failure("INPUT_INVALID", "The share would last longer than the policy limit.");

  // 2. The credential the recipient must present: the built-in OpenCredentials issuer, pinned. Before any approval or write.
  let descriptor: CredentialFlowDescriptor;
  try {
    descriptor = await ports.emailProofDescriptor(recipient, { fetch: ports.fetch });
  } catch (error) {
    return error instanceof EmailProofError && error.code === "PROFILE_UNAVAILABLE"
      ? failure("NODE_ERROR", "The OpenCredentials email issuer doesn't match the issuer TinyCloud trusts, so nothing was shared.")
      : failure("NODE_UNREACHABLE", "Couldn't reach the OpenCredentials email issuer, so nothing was shared. Try again shortly.", true);
  }
  const config = await shareConfig(ports);
  if ("error" in config) return failure("NODE_UNREACHABLE", config.error, true);

  // The owner must be able to list and revoke what this creates, so the history is proven readable before anything is asked or written.
  const history = ports.openHistory({ profile, node });
  try {
    await history.list();
  } catch {
    return failure("INTERNAL_ERROR", "This profile's share history can't be read, so nothing was shared. `tinycloud share list` shows the same problem.");
  }

  // 3. The key. A session that cannot decrypt gets the owner's approval of one key for this invitation, before anything is created.
  const network = node.getDefaultEncryptionNetworkId();
  let shareId = randomUUID().replace(/-/g, "");
  let plan = planPathBoundShare({ shareId, encryptionNetwork: network });
  if (node.isSessionOnly && !holdsKeyDecrypt(node, plan.keyResource)) {
    const bytes = new TextEncoder().encode(input.content);
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode(input.filename), 0, ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]));
    const contentSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    let approval: InvitationApprovalOutcome;
    try {
      approval = await ports.requestInvitationApproval({
        profile, node: node as unknown as TinyCloudNode, ownerDid, recipientEmail: recipient,
        subjectName: input.filename, subjectKind: "file", accessExpiresAt: expiresAt, contentSha256,
        ...(input.expiresInSeconds === undefined ? {} : { requestedDurationMs: input.expiresInSeconds * 1000 }),
      }, { fetch: ports.fetch, now: ports.now });
    } catch (error) {
      return failure("PERMISSION_DENIED", error instanceof Error ? error.message : "The invitation approval could not be requested; nothing was shared.");
    }
    if (approval.status === "pending") {
      return {
        status: "authority_required",
        missing: [{ service: "tinycloud.encryption", path: `${network}/share/`, actions: ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"] }],
        request: { requestId: approval.requestId },
        approval: { kind: "openkey", requestId: approval.requestId, url: approval.approvalUrl, fallback: "Ask the owner to open the approval link and approve the one-key invitation, then call this tool again with the same input. Tell them the agent's permission to share also lets it delete their other shares and see their encrypted copies, though not open them." },
        requiresCallerInput: true,
      };
    }
    // What the owner signed as the share's access date is the date it is issued with: never later, never recomputed.
    const approved = new Date(approval.accessExpiresAt);
    if (approval.accessExpiresAt !== expiresAt.toISOString()) {
      if (!approval.resumed || !(approved.getTime() < expiresAt.getTime()) || approved.getTime() <= now + 60_000) {
        return failure("PERMISSION_DENIED", "The approval's access date is not this share's expiry; nothing was shared.");
      }
      expiresAt = approved;
    }
    shareId = approval.shareId;
    plan = planPathBoundShare({ shareId, encryptionNetwork: network });
  }

  // 4. Publish. Order: location record, ciphertext, policy.
  const activeNode = await node.activeNodeIdentity();
  const storageName = input.filename;
  const resourcePath = `shares/${shareId}/${storageName}`;
  const mediaType = MEDIA_TYPES[(storageName.split(".").at(-1) ?? "").toLowerCase() as keyof typeof MEDIA_TYPES] ?? "text/plain";
  const plaintext = new TextEncoder().encode(input.content);
  const prepared = prepareAddressedShare({
    target: { kind: "email", address: recipient }, actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"], filename: input.filename,
  });
  if (prepared.target.kind !== "email") return failure("INTERNAL_ERROR", "The recipient could not be prepared.");
  const kv = node.kvForSpace(ownerSpaceId);
  let stored = false;
  try {
    await node.publishActiveNodeLocation(config.registryOrigin, ports.fetch);
    const sealed = await ports.sealContent({ plan, node, plaintext, mediaType, kvResource: `${ownerSpaceId}/kv/${resourcePath}` });
    const put = await kv.put(resourcePath, sealed.storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
    if (!put.ok) return failure("PERMISSION_DENIED", "TinyCloud refused to store the encrypted file, so nothing was shared.");
    stored = true;
    const published = await ports.publishEmailShareV3({
      shareId, shareOrigin: config.shareOrigin, nodeOrigin: activeNode.origin, nodeAudience: activeNode.nodeDid,
      enforcerDid: activeNode.nodeDid, spaceId: ownerSpaceId, target: prepared.target,
      resource: { kind: "exact", path: resourcePath }, actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      contentSource: sealed.contentSource,
      ...(prepared.credentialRequirement === undefined ? {} : { credentialRequirement: prepared.credentialRequirement }),
      deliveryEmail: recipient, filename: input.filename, mediaType, byteLength: plaintext.byteLength, expiresAt,
      authority: {
        ownerDid: node.credentialHolderDid,
        createOwnerRoot: (request) => node.createUnifiedOwnerRoot(request),
        sign: (bytes) => node.signSessionBytes(bytes),
        registerPolicy: (request) => node.registerPolicy(request),
      },
      credentialDescriptor: descriptor, issuerDid: descriptor.issuer.did, issuerKid: descriptor.issuer.kid,
    });
    // 5. Deliver. The link never leaves this process: a failure from here on revokes the share again.
    return await deliverOrRevoke({ node, ports, history, published, recipient, config, shareId, expiresAt, resourcePath, filename: input.filename, kvDelete: () => kv.delete(resourcePath) });
  } catch (error) {
    if (!stored) return failure("NODE_ERROR", "The share could not be created, so nothing was shared.", true);
    // The ciphertext was stored but no policy was registered: nothing can open it. Remove it.
    try { await kv.delete(resourcePath); } catch { /* it is unreachable without a policy; the owner's `shares/` listing still shows it */ }
    return failure("NODE_ERROR", `The share could not be created (${error instanceof Error ? error.name : "error"}), so nothing was shared.`, true);
  }
}

async function shareConfig(ports: ShareEmailPorts): Promise<{ registryOrigin: string; shareOrigin: string; credentialsOrigin: string } | { error: string }> {
  let response: Response;
  try {
    response = await ports.fetch(`${SHARE_ORIGIN}/.well-known/tinycloud-share/config.json`, {
      headers: { accept: "application/json" }, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000),
    });
  } catch { return { error: "Couldn't reach the TinyCloud Share service, so nothing was shared. Try again shortly." }; }
  if (!response.ok) return { error: "The TinyCloud Share service is unavailable, so nothing was shared. Try again shortly." };
  const value = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const origin = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string") return undefined;
    try { const url = new URL(candidate); return url.protocol === "https:" && url.origin === candidate ? candidate : undefined; } catch { return undefined; }
  };
  if (value?.version !== "tinycloud.share/config-v2" || origin(value.shareOrigin) === undefined || origin(value.registryOrigin) === undefined || origin(value.credentialsOrigin) === undefined) {
    return { error: "The TinyCloud Share service answered incorrectly, so nothing was shared." };
  }
  return { shareOrigin: value.shareOrigin as string, registryOrigin: value.registryOrigin as string, credentialsOrigin: value.credentialsOrigin as string };
}

async function deliverOrRevoke(input: {
  readonly node: ShareEmailNode;
  readonly ports: ShareEmailPorts;
  readonly history: SenderShareRecordStorage;
  readonly published: PublishedShare;
  readonly recipient: string;
  readonly config: { shareOrigin: string; credentialsOrigin: string };
  readonly shareId: string;
  readonly expiresAt: Date;
  readonly resourcePath: string;
  readonly filename: string;
  readonly kvDelete: () => Promise<unknown>;
}): Promise<OperationExecutionOutcome<ShareEmailOutput>> {
  const { node, ports, history, published, recipient, config, shareId, expiresAt } = input;
  const base = { shareId, recipient, expiresAt: expiresAt.toISOString() };
  try {
    const material = published.deliveryMaterial;
    if (material === undefined) throw new Error("no delivery material");
    const link = await ports.createLink({
      type: "share",
      sealed: { blob: fromBase64Url(material.sealedEnvelope), key: fromBase64Url(material.envelopeKey) },
      issuerKey: { did: node.credentialHolderDid, sign: (digest: Uint8Array) => node.signSessionBytes(digest) },
      apiOrigin: DEFAULT_LINKS_API_ORIGIN,
      linkOrigin: new URL(published.url).origin,
      expiresAt,
      now: new Date(ports.now()),
      fetch: ports.fetch,
    });
    // The history keeps the link text, as `tinycloud share publish` does; it is encrypted at rest with the profile's key.
    await history.put({ ...historyRecordForPublishedShare(published, new Date(ports.now())), link: link.link });
    const deliveryExpiry = new Date(Math.min(expiresAt.getTime(), ports.now() + 5 * 60_000)).toISOString();
    const receipt = await node.authorizeShareDeliveryV3({
      envelope: material.envelope as Parameters<typeof node.authorizeShareDeliveryV3>[0]["envelope"],
      resourcePath: input.resourcePath, recipientEmail: recipient, shareUrl: link.link, documentName: input.filename,
      expiresAt: deliveryExpiry, deliveryAudience: config.credentialsOrigin, idempotencyKey: randomUUID(), trustedOrigins: [config.shareOrigin],
    });
    await ports.deliverCredentialInvitation({ credentialsOrigin: config.credentialsOrigin, receipt: receipt as unknown as CredentialInvitationReceipt, shareUrl: link.link, fetchFn: ports.fetch });
    await history.update?.(shareId, (record) => ({ ...record, deliveredRecipients: [recipient] })).catch(() => undefined);
    return { status: "ok", output: { ...base, shared: true, delivery: "sent", message: `Shared with ${recipient}; TinyCloud emailed them the invitation.` } };
  } catch {
    // The invitation was not delivered, and the link is held only here: revoke both roots so the share admits no one.
    const revoked = await revokeShare(node, ports, published);
    if (revoked) await history.update?.(shareId, (record) => ({ ...record, revokedAt: new Date(ports.now()).toISOString() })).catch(() => undefined);
    await input.kvDelete().catch(() => undefined);
    return {
      status: "ok",
      output: {
        ...base, shared: false, delivery: "failed", revoked,
        message: revoked
          ? `The invitation to ${recipient} could not be delivered, so the share was revoked. Nothing was shared.`
          : `The invitation to ${recipient} could not be delivered and the share could not be revoked. Ask the owner to revoke share ${shareId}.`,
      },
    };
  }
}

/** Revoke both policy roots; true only when the node confirmed each. */
async function revokeShare(node: ShareEmailNode, ports: ShareEmailPorts, published: PublishedShare): Promise<boolean> {
  const metadata = published.metadata as { ownerDelegationCid?: string; enforcementDelegationCid?: string };
  if (metadata.ownerDelegationCid === undefined || metadata.enforcementDelegationCid === undefined) return false;
  const identity = await node.activeNodeIdentity().catch(() => undefined);
  if (identity === undefined) return false;
  let revoked = true;
  for (const [rootCid, targetRole] of [[metadata.enforcementDelegationCid, "policy-enforcement"], [metadata.ownerDelegationCid, "policy-authority"]] as const) {
    try {
      await ports.revokePolicyRootV3({
        nodeOrigin: identity.origin, rootCid, targetRole, ownerDid: node.credentialHolderDid, issuerDid: node.credentialHolderDid,
        nodeAudience: identity.nodeDid, reason: "share revoked", sign: (digest: Uint8Array) => node.signSessionBytes(digest),
        spaceId: node.spaceId, resourceTransport: node.resourceTransport,
      });
    } catch (error) {
      // The node answers 409 root-revocation-irreversible only for a root it already holds a signed revocation for.
      if (!(error instanceof Error && "status" in error && error.status === 409 && error.message.endsWith(" - root-revocation-irreversible"))) revoked = false;
    }
  }
  return revoked;
}
