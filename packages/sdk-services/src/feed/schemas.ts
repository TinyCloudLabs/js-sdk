import { z } from "zod";
import type { FeedCard, FeedHandling, FeedResponsePayload, JSONValue, NewFeedResponse } from "./types";

function isJSONValue(value: unknown, active = new Set<object>()): value is JSONValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  active.add(value);
  let valid = true;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (!isJSONValue(child, active)) { valid = false; break; }
  }
  active.delete(value);
  return valid;
}

// Validate without cloning or dropping literal JSON keys such as "__proto__".
const jsonValueSchema = z.custom<JSONValue>((value) => isJSONValue(value));

export const feedResponsePayloadSchema: z.ZodType<FeedResponsePayload> = z.object({
  type: z.string().min(1), version: z.number().int().positive(), data: jsonValueSchema,
}).strict();

const identity = {
  cardId: z.string().min(1), revision: z.number().int().positive(), issuanceId: z.string().min(1),
};
export const feedCardSchema: z.ZodType<FeedCard> = z.object({
  ...identity, kind: z.string().min(1), needsResponse: z.boolean(), title: z.string(), body: z.string(),
  choices: z.array(z.object({ id: z.string().min(1), label: z.string() })).optional(),
  urgency: z.number().finite(), createdAt: z.string().min(1), payload: z.record(z.unknown()).optional(),
});
export const newFeedResponseSchema: z.ZodType<NewFeedResponse> = z.object({
  ...identity, responseId: z.string().min(1), kind: z.enum(["answer", "followup"]),
  choiceId: z.string().min(1).optional(), text: z.string().optional(),
  supersedesResponseId: z.string().min(1).optional(), createdAt: z.string().min(1),
});
export const feedHandlingSchema: z.ZodType<FeedHandling> = z.object({
  ...identity, handlingId: z.string().min(1), responseId: z.string().min(1),
  phase: z.enum(["acknowledged", "succeeded", "failed"]), createdAt: z.string().min(1),
  detail: z.record(z.unknown()).optional(),
});
