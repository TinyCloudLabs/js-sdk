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
}).passthrough();
