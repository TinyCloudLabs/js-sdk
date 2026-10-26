import { z } from "zod";
import { TC_APPS_ROOT } from "../tc-apps.js";

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

export function validPath(key: string, prefix = false): boolean {
  if (!key.startsWith(TC_APPS_ROOT) || !/^[A-Za-z0-9/._~:+@=,-]+$/.test(key)) return false;
  const relative = key.slice(TC_APPS_ROOT.length);
  if (prefix && relative === "") return true;
  const segments = (prefix && relative.endsWith("/") ? relative.slice(0, -1) : relative).split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) return false;
  const [first, second, third] = segments;
  if (first === "catalog" || first === "index-stale") {
    return (prefix || segments.length === 2 || segments.length === 3) &&
      (second === undefined || validApp(second)) && (third === undefined || name.test(third)) && segments.length <= 3;
  }
  return validApp(first!) && (second === undefined || name.test(second)) &&
    (third === undefined || name.test(third)) && (prefix ? segments.length <= 4 : segments.length === 4);
}
function validApp(value: string): boolean { return name.test(value) && value !== "catalog" && value !== "index-stale"; }
export const KeySchema = z.string().refine((key) => validPath(key), "Invalid personal-record key.");
export const RecordKeySchema = KeySchema.refine((key) => !key.startsWith(`${TC_APPS_ROOT}catalog/`) && !key.startsWith(`${TC_APPS_ROOT}index-stale/`), "A record key is required.");
export const PrefixSchema = z.string().refine((key) => validPath(key, true), "Invalid personal-record prefix.");
export const EtagSchema = z.string().regex(/^"blake3-[0-9a-f]{64}"$/, "A strong TinyCloud BLAKE3 ETag is required.");

export function catalogParts(key: string): { app: string; kind?: string } | undefined {
  if (!key.startsWith(`${TC_APPS_ROOT}catalog/`)) return undefined;
  const [app, kind] = key.slice(`${TC_APPS_ROOT}catalog/`.length).split("/");
  return { app: app!, ...(kind === undefined ? {} : { kind }) };
}
export function recordParts(key: string): { app: string; kind: string; folder: string; id: string } {
  const [app, kind, folder, id] = key.slice(TC_APPS_ROOT.length).split("/");
  return { app: app!, kind: kind!, folder: folder!, id: id! };
}

export function valueSyntax(key: string, value: JsonObject): string | undefined {
  if (Object.prototype.hasOwnProperty.call(value, "by")) return "by is set by the server";
  const catalog = catalogParts(key);
  if (!catalog) {
    if (key.startsWith(`${TC_APPS_ROOT}index-stale/`)) return "stale markers are server owned";
    if (!isObject(value.data)) return "record data must be an object";
    if (value.v !== undefined && (!Number.isInteger(value.v) || (value.v as number) < 1)) return "record v must be a positive integer";
    if (value.at !== undefined && typeof value.at !== "string") return "record at must be text";
    if (Object.keys(value).some((field) => !["v", "at", "data"].includes(field))) return "record fields are v, at and data";
    return undefined;
  }
  if (value.app !== catalog.app) return "catalog app must match its key";
  if (typeof value.about !== "string" || typeof value.created !== "string") return "catalog requires about and created";
  if (!catalog.kind) return typeof value.title === "string" ? undefined : "app requires title";
  if (value.kind !== catalog.kind) return "catalog kind must match its key";
  if (!Number.isInteger(value.v) || (value.v as number) < 1 || !isObject(value.fields)) return "kind requires positive v and fields object";
  if (Object.values(value.fields).some((field) => typeof field !== "string")) return "field descriptions must be text";
  if (value.shape === "log" && (value.per === "day" || value.per === "time")) return undefined;
  if (value.shape === "item" && Array.isArray(value.states) && value.states.length > 0 && value.states.every((state) => typeof state === "string" && name.test(state))) return undefined;
  return "kind requires log/day, log/time or item/states";
}

const WriteValueSchema = z.object({
  by: z.never({ invalid_type_error: "by is set by the server; omit it from the write value." }).optional(),
}).catchall(JsonSchema).describe("Record or catalog value without top-level by. Remove by from read-back values before edits or moves; the server supplies it.");
const PutSchema = z.object({ op: z.literal("put"), key: KeySchema, value: WriteValueSchema, etag: EtagSchema.optional() }).strict();
const MoveSchema = z.object({ op: z.literal("move"), from: RecordKeySchema, to: RecordKeySchema, value: WriteValueSchema, etag: EtagSchema }).strict();
const DeleteSchema = z.object({ op: z.literal("delete"), key: RecordKeySchema, etag: EtagSchema.optional() }).strict();
export const WriteInputSchema = z.object({ ops: z.array(z.discriminatedUnion("op", [PutSchema, MoveSchema, DeleteSchema])).min(1).max(10) }).strict().superRefine((input, context) => {
  input.ops.forEach((op, index) => {
    if (op.op === "delete") return;
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
