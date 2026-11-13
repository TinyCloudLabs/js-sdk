import { approvalRenewalRequestSchema } from "./approval-renewal.js";
import { p256 } from "@noble/curves/p256";
import { z } from "zod";
import { didKeyFromEd25519PublicKey } from "../didkey.js";
import { ed25519KeyProblem } from "./ed25519-strict.js";
import { decodeStrictBase64Url } from "./header.js";
import { LinkError } from "./errors.js";

const bytes32 = z.string().refine((value) => decodeStrictBase64Url(value)?.length === 32);
const ed25519Jwk = z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: bytes32 }).strict();
const p256Jwk = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: bytes32, y: bytes32 }).strict()
  .refine((key) => {
    try {
      const point = new Uint8Array(65);
      point[0] = 4;
      point.set(decodeStrictBase64Url(key.x)!, 1);
      point.set(decodeStrictBase64Url(key.y)!, 33);
      p256.ProjectivePoint.fromHex(point).assertValidity();
      return true;
    } catch { return false; }
  });
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
});
const permission = z.object({
  service: z.string().min(1), space: z.string().min(1), path: z.string(),
  actions: z.array(z.string().min(1)).min(1), caveats: z.array(z.unknown()).optional(),
}).strict();
const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => new Date(value).toISOString() === value);
/**
 * A share-invitation intent, sealed into the signed request body. It names NO key: the approver's service chooses the
 * random share key id while preparing the request and returns it in the signed result. The request carries no
 * permissions of its own; the grant that comes back is exactly one key.create + decrypt pair on that one key.
 */
const invitationContext = z.object({
  kind: z.literal("share-invitation"), version: z.literal(1),
  invitationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  recipientEmail: z.string().min(3).max(254),
  subjectKind: z.enum(["session", "file"]), subjectName: z.string().min(1).max(120),
  acceptanceExpiresAt: isoUtc, accessExpiresAt: isoUtc,
 }).strict();
const requestSchema = z.object({
  issuer: z.string(), requestVersion: z.literal(1), targetDid: z.string(),
  targetPublicJwk: ed25519Jwk, nodeOrigin: origin,
  permissions: z.array(permission), reason: z.string().optional(),
  grantLifetimeSeconds: z.number().int().positive(), resultEncryptionPublicJwk: p256Jwk,
  context: invitationContext.optional(),
  renewal: approvalRenewalRequestSchema.optional(),
  /**
   * The lifetime the requester suggests approving, in seconds. Absent means the maximum, `grantLifetimeSeconds`. When present it is at most that
   * maximum; it has no upper bound of its own, and the approver may still choose less.
   */
  suggestedLifetimeSeconds: z.number().int().positive().optional(),
}).strict().refine((request) => request.suggestedLifetimeSeconds === undefined || request.suggestedLifetimeSeconds <= request.grantLifetimeSeconds)
  .refine((request) => request.context === undefined ? request.permissions.length > 0 : request.permissions.length === 0);

export type OpenKeyApprovalRequestV1 = z.infer<typeof requestSchema>;
export type ShareInvitationApprovalContext = z.infer<typeof invitationContext>;

const DAY_SECONDS = 86_400;

/**
 * The intent request for ONE invitation: no permissions and no key id. The approver's service picks the key id and the
 * approval is valid until `context.acceptanceExpiresAt` (at most 24 hours from `now`).
 */
export function buildShareInvitationApprovalSpec(input: {
  readonly targetDid: string; readonly targetPublicJwk: OpenKeyApprovalRequestV1["targetPublicJwk"];
  readonly nodeOrigin: string; readonly context: ShareInvitationApprovalContext; readonly now: number;
}): Omit<OpenKeyApprovalRequestV1, "resultEncryptionPublicJwk"> {
  const { context } = input;
  const lifetime = Math.floor((Date.parse(context.acceptanceExpiresAt) - input.now) / 1000);
  if (!(lifetime > 0) || lifetime > DAY_SECONDS) throw new LinkError("body_validation_failed", "approval must expire within 24 hours");
  return {
    issuer: input.targetDid, requestVersion: 1, targetDid: input.targetDid, targetPublicJwk: input.targetPublicJwk, nodeOrigin: input.nodeOrigin,
    permissions: [], grantLifetimeSeconds: lifetime, suggestedLifetimeSeconds: lifetime, context,
  };
}

/** The signed request names exactly its issuer's public session key; no private JWK fields are accepted. */
export function parseApprovalRequest(value: unknown, options: { readonly issuer?: string } = {}): OpenKeyApprovalRequestV1 {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new LinkError("body_validation_failed", "invalid approval request");
  const request = parsed.data;
  const publicKey = decodeStrictBase64Url(request.targetPublicJwk.x)!;
  if (ed25519KeyProblem(publicKey) !== null || didKeyFromEd25519PublicKey(publicKey) !== request.targetDid ||
      request.issuer !== request.targetDid || (options.issuer !== undefined && request.issuer !== options.issuer)) {
    throw new LinkError("issuer_binding_mismatch");
  }
  return request;
}

