import { z } from "zod";
import { parseKey, parsePrefix, type KeyParts } from "./layout.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export const JsonSchema: z.ZodLazy<z.ZodType<Json>> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonSchema), z.record(JsonSchema),
]));
export const ObjectSchema = z.record(JsonSchema);
const name = /^[a-z0-9-]+$/;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const KeySchema = z.string().refine((key) => parseKey(key) !== undefined, "Invalid personal-record key.");
export const RecordKeySchema = KeySchema.refine((key) => parseKey(key)?.area === "record", "A record key is required.");
export const PrefixSchema = z.string().refine((prefix) => parsePrefix(prefix) !== undefined, "Invalid personal-record prefix.");
export const EtagSchema = z.string().regex(/^"blake3-[0-9a-f]{64}"$/, "A strong TinyCloud BLAKE3 ETag is required.");

export type RecordParts = Extract<KeyParts, { area: "record" }>;
/** The parts of a key already validated by a schema. */
export function keyParts(key: string): KeyParts {
  const parts = parseKey(key);
  if (!parts) throw new TypeError("Invalid personal-record key.");
  return parts;
}
export function recordParts(key: string): RecordParts {
  const parts = keyParts(key);
  if (parts.area !== "record") throw new TypeError("A record key is required.");
  return parts;
}

export function valueSyntax(key: string, value: JsonObject): string | undefined {
  const parts = keyParts(key);
  if (parts.area === "discovery") {
    if (Object.keys(value).some((field) => !["v", "app", "id", "title"].includes(field)) || Object.keys(value).length !== 4) return "a discovery entry holds only v, app, id and title";
    if (value.v !== 1 || value.app !== parts.app || value.id !== `xyz.tinycloud.tinyapps.${parts.app}` || typeof value.title !== "string") return "a discovery entry is {v:1, app, id, title} for its own app";
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, "by")) return "by is set by the server";
  if (parts.area === "stale") return "stale markers are server owned";
  if (parts.area === "record") {
    if (!isObject(value.data)) return "record data must be an object";
    if (value.v !== undefined && (!Number.isInteger(value.v) || (value.v as number) < 1)) return "record v must be a positive integer";
    if (value.at !== undefined && typeof value.at !== "string") return "record at must be text";
    if (Object.keys(value).some((field) => !["v", "at", "data"].includes(field))) return "record fields are v, at and data";
    return undefined;
  }
  if (value.app !== parts.app) return "catalog app must match its key";
  if (typeof value.about !== "string" || typeof value.created !== "string") return "catalog requires about and created";
  if (!parts.kind) return typeof value.title === "string" ? undefined : "app requires title";
  if (value.kind !== parts.kind) return "catalog kind must match its key";
  if (!Number.isInteger(value.v) || (value.v as number) < 1 || !isObject(value.fields)) return "kind requires positive v and fields object";
  if (Object.values(value.fields).some((field) => typeof field !== "string")) return "field descriptions must be text";
  if (value.shape === "log" && (value.per === "day" || value.per === "time")) return undefined;
  if (value.shape === "item" && Array.isArray(value.states) && value.states.length > 0 && value.states.every((state) => typeof state === "string" && name.test(state))) return undefined;
  return "kind requires log/day, log/time or item/states";
}

const WriteValueSchema = z.object({
  by: z.never({ invalid_type_error: "by is set by the server; omit it from the write value." }).optional(),
}).catchall(JsonSchema).describe("Record, catalog or discovery-entry value without top-level by. Remove by from read-back values before edits or moves; the server supplies it.");
const PutSchema = z.object({ op: z.literal("put"), key: KeySchema, value: WriteValueSchema, etag: EtagSchema.optional() }).strict();
const MoveSchema = z.object({ op: z.literal("move"), from: RecordKeySchema, to: RecordKeySchema, value: WriteValueSchema, etag: EtagSchema }).strict();
const DeleteSchema = z.object({ op: z.literal("delete"), key: RecordKeySchema, etag: EtagSchema.optional() }).strict();
export const WriteInputSchema = z.object({ ops: z.array(z.discriminatedUnion("op", [PutSchema, MoveSchema, DeleteSchema])).min(1).max(10) }).strict().superRefine((input, context) => {
  input.ops.forEach((op, index) => {
    if (op.op === "delete") return;
    const target = parseKey(op.op === "move" ? op.to : op.key);
    const from = op.op === "move" ? parseKey(op.from) : undefined;
    if (!target || (op.op === "move" && !from)) return;
    if (from && (from.app !== target.app || from.layout !== target.layout)) context.addIssue({ code: "custom", path: ["ops", index, "to"], message: "a move stays inside one app and layout" });
    const reason = valueSyntax(op.op === "move" ? op.to : op.key, op.value);
    if (reason) context.addIssue({ code: "custom", path: ["ops", index, "value"], message: reason });
  });
});
export type WriteInput = z.infer<typeof WriteInputSchema>;
export type WriteOp = WriteInput["ops"][number];

export function catalogChangeAllowed(current: JsonObject, next: JsonObject): boolean {
  if (typeof next.v === "number" && typeof current.v === "number" && next.v > current.v && next.history !== undefined && next.history !== null && next.history !== "") return true;
  if (current.shape !== next.shape || current.per !== next.per) return false;
  if (isObject(current.fields) && (!isObject(next.fields) || Object.entries(current.fields).some(([key, value]) => next.fields && (next.fields as JsonObject)[key] !== value))) return false;
  if (Array.isArray(current.states)) {
    if (!Array.isArray(next.states)) return false;
    let cursor = 0;
    for (const state of next.states) if (state === current.states[cursor]) cursor++;
    if (cursor !== current.states.length) return false;
  }
  return true;
}

export function newRecordFits(key: string, kind: JsonObject): boolean {
  const { folder, id } = recordParts(key);
  if (kind.shape === "item") return Array.isArray(kind.states) && kind.states.includes(folder);
  if (kind.shape !== "log" || !/^\d{4}-\d{2}$/.test(folder) || !id.startsWith(`${folder}-`)) return false;
  return kind.per === "day" ? /^\d{4}-\d{2}-\d{2}$/.test(id) : kind.per === "time" && /^\d{4}-\d{2}-\d{2}T\d{4}-[a-z0-9-]+$/.test(id);
}

export function recordWarnings(key: string, value: JsonObject, kind?: JsonObject): string[] {
  const warnings: string[] = [];
  if (isObject(value.data)) for (const field of Object.keys(value.data)) {
    if (!/^[a-z0-9_]+$/.test(field)) warnings.push(`Field ${field} does not use lowercase letters, digits and underscores.`);
    if (field !== "due" && field !== "done" && isObject(kind?.fields) && !Object.prototype.hasOwnProperty.call(kind.fields, field)) warnings.push(`Field ${field} is not in the kind's fields.`);
    if ((field === "due" || field === "done") && (typeof value.data[field] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.data[field] as string))) warnings.push(`${field} should be YYYY-MM-DD.`);
  }
  if (typeof value.at === "string") {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value.at) || Number.isNaN(Date.parse(value.at))) warnings.push("at should be a date or a local date and time with UTC offset.");
    const id = recordParts(key).id;
    if (/^\d{4}-\d{2}-\d{2}/.test(id) && value.at.slice(0, 10) !== id.slice(0, 10)) warnings.push("at falls on a different date than the record id.");
  }
  return warnings;
}
