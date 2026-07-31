import { z } from "zod";

export const ShareRecipientTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exactEmail"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("emailDomain"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("bearer") }).strict(),
]);

export const ShareResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("prefix"), path: z.string().min(1) }).strict(),
]);

export const ShareActionSchema = z.enum(["read", "list", "edit"]);

export const ShareRecipientPolicySchema = z.object({
  recipientMatcher: ShareRecipientTargetSchema,
  spaceId: z.string().min(1),
  resource: ShareResourceSchema,
  actions: z.array(ShareActionSchema).min(1),
  expiresAt: z.date(),
}).strict();

export const ShareRecipientClientOptionsSchema = z.object({
  trustedOrigins: z.array(z.string().url()).min(1),
  maxInlineBytes: z.number().int().positive().optional(),
  maxArtifactBytes: z.number().int().positive().optional(),
  maxContentBytes: z.number().int().positive().optional(),
  maxSealedContentBytes: z.number().int().positive().optional(),
}).strict();

const ShareNativeActionSchema = z.enum(["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/list", "tinycloud.kv/put"]);
const ShareWireActionSchema = z.enum(["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.sql/read"]);
const ShareContentSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("kv"),
    action: ShareNativeActionSchema,
    space: z.string().min(1),
    path: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("sql"),
    action: z.literal("tinycloud.sql/read"),
    space: z.string().min(1),
    database: z.string().min(1),
    path: z.string().min(1),
    statement: z.string().min(1),
    arguments: z.record(z.number().int().safe()),
    argumentsDigest: z.string().min(1),
  }).strict(),
]);
const ShareAddressedRecipientSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exactEmail"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("emailDomain"), value: z.string().min(1) }).strict(),
]);

export const ShareAddressedDelegationRequestV2Schema = z.object({
  version: z.literal(2),
  nonce: z.string().min(1),
  jti: z.string().min(1),
  senderDid: z.string().min(1),
  recipientMatcher: ShareAddressedRecipientSchema,
  targetOrigin: z.string().url(),
  nodeAudience: z.string().min(1),
  shareCid: z.string().min(1),
  shareId: z.string().min(1),
  delegationCid: z.string().min(1),
  authorityMaterialHandle: z.string().min(1),
  authorityMaterialDigest: z.string().min(1),
  contentSource: ShareContentSourceSchema,
  contentSourceDigest: z.string().min(1),
  actions: z.array(ShareWireActionSchema).min(1).refine((actions) => new Set(actions).size === actions.length),
  resource: z.object({ kind: z.enum(["exact", "prefix"]), value: z.string().min(1) }).strict(),
  expiresAt: z.string().datetime({ offset: true }),
  requestBodyDigest: z.string().min(1),
}).strict();

export const ShareAddressedDelegationEnvelopeV2Schema = z.object({
  request: ShareAddressedDelegationRequestV2Schema,
  proof: z.object({ alg: z.literal("EdDSA"), kid: z.string().min(1), signature: z.string().min(1) }).strict(),
}).strict();

export const ShareAddressedDelegationResponseV2Schema = z.object({
  type: z.literal("TinyCloudShareAddressedDelegation"),
  version: z.literal(2),
  nonce: z.string().min(1),
  jti: z.string().min(1),
  policyCid: z.string().min(1),
  policyBytes: z.string().min(1),
  policyDigest: z.string().min(1),
  delegationCid: z.string().min(1),
  delegationBytes: z.string().min(1),
  delegationDigest: z.string().min(1),
  authorityMaterialHandle: z.string().min(1),
  authorityMaterialDigest: z.string().min(1),
  actions: z.array(ShareWireActionSchema).min(1).refine((actions) => new Set(actions).size === actions.length),
  resource: z.object({ kind: z.enum(["exact", "prefix"]), value: z.string().min(1) }).strict(),
  expiresAt: z.string().datetime({ offset: true }),
  proof: z.object({ alg: z.literal("EdDSA"), kid: z.string().min(1), signature: z.string().min(1) }).strict(),
}).strict();

const ShareNativeResponseEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "folder"]),
}).strict();

/**
 * Closed response envelope for the addressed Node data plane.
 * Addressed native responses are closed v2 envelopes.  Every operation binds
 * its exact action and resource before action-specific fields are consumed.
 */
const ShareNativeResponseBase = {
  type: z.literal("TinyCloudShareInvokeResponse"),
  version: z.literal(2),
  resource: z.string().min(1),
};

export const ShareNativeResponseSchema = z.discriminatedUnion("action", [
  z.object({
    ...ShareNativeResponseBase,
    action: z.literal("tinycloud.kv/metadata"),
    metadata: z.record(z.string()),
    etag: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    ...ShareNativeResponseBase,
    action: z.literal("tinycloud.kv/get"),
    mediaType: z.string().min(1),
    content: z.string(),
    bodyDigest: z.string().min(1),
    etag: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    ...ShareNativeResponseBase,
    action: z.literal("tinycloud.kv/list"),
    entries: z.array(ShareNativeResponseEntrySchema),
    nextCursor: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    ...ShareNativeResponseBase,
    action: z.literal("tinycloud.kv/put"),
    etag: z.string().min(1),
    bodyDigest: z.string().min(1),
    contentType: z.string().min(1),
  }).strict(),
]);

export type ShareNativeResponse = z.infer<typeof ShareNativeResponseSchema>;
