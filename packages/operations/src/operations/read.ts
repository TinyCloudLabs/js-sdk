import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { parseSpaceUri } from "@tinycloud/node-sdk";
import { jcsCanonicalize } from "@tinycloud/sdk-core/policy";
import { z } from "zod";

import type {
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  RuntimeOperationContext,
} from "../contract.js";
import { OperationInvocationError, operationError } from "../errors.js";
import {
  caughtKvFailure,
  genericKv,
  KvGetInputSchema,
  kvFailure,
  MAX_KV_VALUE_BYTES,
  planKvGet,
  runtimeContext,
} from "./exploration.js";
import { executeSqlQuery, planSqlRead, SqlQueryInputSchema } from "./sql.js";

const MAX_PAGE_BYTES = 12 * 1024;
const MAX_PAGE_OUTPUT_BYTES = 80_000;
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ByteOffsetSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const EncodingSchema = z.enum(["utf8", "base64"]);
const PageBytesSchema = z.number().int().min(1).max(MAX_PAGE_BYTES);
const ResourceSchema = z.discriminatedUnion("kind", [
  KvGetInputSchema.omit({ representation: true }).extend({ kind: z.literal("kv") }),
  SqlQueryInputSchema.extend({ kind: z.literal("sql") }),
]);
const ResourceIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("kv"),
    space: z.string().min(1),
    key: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("sql"),
    space: z.string().min(1),
    database: z.string().min(1),
    querySha256: Sha256Schema,
  }).strict(),
]);
const ReadBindingSchema = z.object({
  host: z.string().min(1),
  ownerDid: z.string().min(1),
  resource: ResourceIdentitySchema,
  sha256: Sha256Schema,
  totalBytes: ByteOffsetSchema,
}).strict();
const ContinuationSchema = z.object({
  offset: ByteOffsetSchema,
  pageBytes: PageBytesSchema,
  encoding: EncodingSchema,
  expected: ReadBindingSchema,
}).strict();

export const ReadInputSchema = z.object({
  resource: ResourceSchema,
  offset: ByteOffsetSchema.optional(),
  pageBytes: PageBytesSchema.optional(),
  encoding: EncodingSchema.optional(),
  expected: ReadBindingSchema.optional(),
}).strict().superRefine((input, context) => {
  if ((input.offset ?? 0) > 0 && input.expected === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expected"],
      message: "A nonzero byte offset requires the previous page's expected binding.",
    });
  }
});

export const ReadOutputSchema = z.object({
  value: z.string(),
  encoding: EncodingSchema,
  range: z.object({
    unit: z.literal("bytes"),
    start: ByteOffsetSchema,
    end: ByteOffsetSchema,
  }).strict(),
  binding: ReadBindingSchema,
  provenance: z.object({
    digestAlgorithm: z.literal("sha256"),
    representation: z.enum(["original-bytes", "normalized-sql-result-json"]),
    acquiredAt: z.string().datetime(),
    etag: z.string().nullable(),
  }).strict(),
  complete: z.boolean(),
  continuation: ContinuationSchema.nullable(),
}).strict();

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;
type ResourceIdentity = z.infer<typeof ResourceIdentitySchema>;

export const readOperationDefinitions: readonly OperationDefinition<ReadInput, ReadOutput>[] = [{
  id: "tinycloud.read",
  version: 1,
  title: "Read complete TinyCloud resource bytes in bounded pages",
  description: "Read original KV bytes or normalized read-only SQL result JSON in digest-bound byte pages. Every call reacquires the resource with current authority. Replay the original resource with continuation fields; a recipient can validate the first page with expected: binding. SQL locators require retaining the original query and parameters. Paging does not increase acquisition limits.",
  input: ReadInputSchema,
  output: ReadOutputSchema,
  effects: ["read"],
  runtime: "authenticated",
  postures: ["owner-openkey", "delegate-session", "local-owner-key"],
  exposure: {
    cli: { status: "excluded", reason: "Existing CLI KV and SQL reads remain the CLI surface." },
    mcp: { status: "required" },
    skill: { status: "required" },
    docs: { status: "required" },
  },
  sensitivity: { input: ["/resource", "/expected"], output: ["/value", "/binding", "/continuation"] },
  authority: planRead,
  execute: executeRead,
}];

async function planRead(context: RuntimeOperationContext, input: ReadInput) {
  return input.resource.kind === "kv"
    ? planKvGet(context, input.resource)
    : planSqlRead(context, input.resource);
}

async function executeRead(
  context: OperationContext,
  input: ReadInput,
): Promise<OperationExecutionOutcome<ReadOutput>> {
  try {
    const runtime = runtimeContext(context);
    // Reuse the canonical planners' exact target resolution and protected-space policy.
    const requirements = await planRead(runtime, input);
    const space = requirements[0]?.space;
    if (typeof space !== "string") throw new TypeError("Read target space is unavailable.");
    const ownerDid = parseSpaceUri(space)?.owner;
    if (ownerDid === undefined) return invalidInput("The read target must resolve to an owner-scoped space.");
    const resource = resourceIdentity(input.resource, space);
    const expected = input.expected;
    const offset = input.offset ?? 0;
    if (offset > 0 && expected === undefined) {
      return invalidInput("A nonzero byte offset requires the previous page's expected binding.");
    }
    if (expected !== undefined && (
      expected.host !== context.summary.host ||
      expected.ownerDid !== ownerDid ||
      jcsCanonicalize(expected.resource) !== jcsCanonicalize(resource)
    )) {
      return {
        status: "error",
        error: operationError("READ_CONTEXT_MISMATCH", "The expected read binding identifies a different host, owner, space, or resource."),
      };
    }

    let bytes: Uint8Array;
    let etag: string | null = null;
    if (input.resource.kind === "kv") {
      const result = await genericKv(runtime, space).get(input.resource.key, {
        binary: true,
        maxResponseBytes: MAX_KV_VALUE_BYTES,
      });
      if (!result.ok) return kvFailure(result.error, "read the KV value");
      bytes = result.data.data;
      if (bytes.byteLength > MAX_KV_VALUE_BYTES) {
        return kvFailure({ code: "KV_RESPONSE_TOO_LARGE" }, "read the KV value");
      }
      etag = result.data.headers.etag ?? null;
    } else {
      const result = await executeSqlQuery(context, input.resource);
      if (result.status !== "ok") return result;
      // This representation is derived, unlike KV's unmodified stored bytes.
      bytes = Buffer.from(JSON.stringify(result.output), "utf8");
    }
    const acquiredAt = new Date().toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected !== undefined && (
      expected.sha256 !== sha256 || expected.totalBytes !== bytes.byteLength
    )) {
      return {
        status: "error",
        error: operationError("READ_SOURCE_CHANGED", "The acquired bytes no longer match the expected digest and byte length. Start a new read explicitly to accept a new source revision."),
      };
    }
    if (offset > bytes.byteLength) return invalidInput("The byte offset exceeds the acquired body length.");
    const validUtf8 = input.encoding === "base64" ? false : isUtf8(bytes);
    const encoding = input.encoding ?? (validUtf8 ? "utf8" : "base64");
    if (encoding === "utf8" && !validUtf8) {
      return invalidInput("The acquired body is not valid UTF-8. Request base64 to preserve its original bytes.");
    }
    if (encoding === "utf8" && isContinuationByte(bytes[offset])) {
      return invalidInput("The byte offset is inside a UTF-8 character.");
    }

    const pageBytes = input.pageBytes ?? MAX_PAGE_BYTES;
    const binding: ReadOutput["binding"] = {
      host: context.summary.host,
      ownerDid,
      resource,
      sha256,
      totalBytes: bytes.byteLength,
    };
    const provenance: ReadOutput["provenance"] = {
      digestAlgorithm: "sha256",
      representation: input.resource.kind === "kv" ? "original-bytes" : "normalized-sql-result-json",
      acquiredAt,
      etag,
    };
    let end = Math.min(offset + pageBytes, bytes.byteLength);
    for (;;) {
      if (encoding === "utf8") {
        while (end > offset && isContinuationByte(bytes[end])) end--;
      }
      if (end === offset && offset < bytes.byteLength) {
        return invalidInput("The requested UTF-8 character or resource provenance cannot fit the bounded page. Use a larger pageBytes (at least 4 for UTF-8), base64, or a shorter locator.");
      }
      // A Buffer view avoids copying the full acquisition or the page's byte slice.
      const value = Buffer.from(bytes.buffer, bytes.byteOffset + offset, end - offset).toString(
        encoding === "utf8" ? "utf8" : "base64",
      );
      const complete = end === bytes.byteLength;
      const output: ReadOutput = {
        value,
        encoding,
        range: { unit: "bytes", start: offset, end },
        binding,
        provenance,
        complete,
        continuation: complete ? null : { offset: end, pageBytes, encoding, expected: binding },
      };
      // Count serialized UTF-8 bytes, including escape expansion and repeated provenance.
      // The canonical/MCP wrapper retains margin below its existing 100,000-unit cap.
      if (Buffer.byteLength(JSON.stringify(output), "utf8") < MAX_PAGE_OUTPUT_BYTES) {
        return { status: "ok", output };
      }
      if (end === offset) {
        return invalidInput("The resource provenance cannot fit the bounded page; use a shorter locator.");
      }
      end = offset + Math.floor((end - offset) / 2);
    }
  } catch (error) {
    if (error instanceof OperationInvocationError) return { status: "error", error: error.operationError };
    return caughtKvFailure(error, "read the resource");
  }
}

function resourceIdentity(resource: ReadInput["resource"], space: string): ResourceIdentity {
  if (resource.kind === "kv") return { kind: "kv", space, key: resource.key };
  const query: Record<string, unknown> = { database: resource.database, sql: resource.sql };
  if (resource.params !== undefined) query.params = resource.params;
  if (resource.maxRows !== undefined) query.maxRows = resource.maxRows;
  if (resource.maxBytes !== undefined) query.maxBytes = resource.maxBytes;
  return {
    kind: "sql",
    space,
    database: resource.database,
    querySha256: createHash("sha256").update(jcsCanonicalize(query), "utf8").digest("hex"),
  };
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function invalidInput(message: string): OperationExecutionOutcome<never> {
  return { status: "error", error: operationError("INPUT_INVALID", message) };
}
