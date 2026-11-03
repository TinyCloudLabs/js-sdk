import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { RuntimeOperationContext } from "../contract.js";
import { readOperationDefinitions, type ReadInput, type ReadOutput } from "./read.js";

const SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
const OTHER_SPACE = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:applications";
const ETAG = `"blake3-${"a".repeat(64)}"`;
const resource = { kind: "kv", space: "applications", key: "undocumented/capture.bin" } as const;
const operation = readOperationDefinitions[0]!;

function fixture(initial: Uint8Array) {
  const state = { bytes: initial, denied: false, acquisitions: 0 };
  const context: RuntimeOperationContext = {
    summary: {
      profile: "sender",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:sender",
      space: SPACE,
    },
    runtime: {
      granted: [],
      node: {
        kvForSpace() {
          return {
            async get() {
              state.acquisitions++;
              return state.denied
                ? { ok: false, error: { code: "AUTH_UNAUTHORIZED", meta: { status: 403 } } }
                : { ok: true, data: { data: state.bytes, headers: { etag: ETAG } } };
            },
          };
        },
      },
    },
  };
  return { state, context };
}

async function page(context: RuntimeOperationContext, input: ReadInput): Promise<ReadOutput> {
  const result = await operation.execute(context, operation.input.parse(input));
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  return operation.output.parse(result.output);
}

async function reconstruct(context: RuntimeOperationContext, input: ReadInput) {
  const pages: ReadOutput[] = [];
  const chunks: Buffer[] = [];
  let next = input;
  let end = 0;
  do {
    const output = await page(context, next);
    const bytes = Buffer.from(output.value, output.encoding === "utf8" ? "utf8" : "base64");
    expect(output.range).toEqual({ unit: "bytes", start: end, end: end + bytes.byteLength });
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(80_000);
    expect(output.complete).toBe(output.range.end === output.binding.totalBytes);
    if (pages.length > 0) expect(output.binding).toEqual(pages[0]!.binding);
    chunks.push(bytes);
    pages.push(output);
    end = output.range.end;
    if (output.continuation === null) {
      expect(output.complete).toBe(true);
      break;
    }
    expect(output.complete).toBe(false);
    expect(output.continuation.offset).toBe(end);
    expect(output.range.end).toBeGreaterThan(output.range.start);
    next = { resource: input.resource, ...output.continuation };
  } while (true);
  const bytes = Buffer.concat(chunks);
  expect(bytes.byteLength).toBe(pages[0]!.binding.totalBytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pages[0]!.binding.sha256);
  return { bytes, pages };
}

describe("digest-bound generic reads", () => {
  test("reconstructs large original bytes with exact intervals and deterministic replay", async () => {
    const original = Buffer.from("capture: \"quoted\"\\\n🎙漢字\u0000".repeat(5_000));
    const { context, state } = fixture(original);
    const { bytes, pages } = await reconstruct(context, { resource });
    expect(bytes).toEqual(original);
    expect(pages[0]!.provenance).toMatchObject({
      representation: "original-bytes",
      digestAlgorithm: "sha256",
      etag: ETAG,
    });
    expect(pages[0]!.binding.resource).toEqual({ ...resource, space: SPACE });
    expect(state.acquisitions).toBe(pages.length);
    const replayInput = { resource, ...pages[0]!.continuation! };
    const replay = await page(context, replayInput);
    expect({ ...replay, provenance: { ...replay.provenance, acquiredAt: null } }).toEqual({
      ...pages[1]!, provenance: { ...pages[1]!.provenance, acquiredAt: null },
    });
    expect(state.acquisitions).toBe(pages.length + 1);
  });

  test("preserves empty, BOM, multibyte, invalid UTF-8, and binary data", async () => {
    for (const original of [
      Buffer.alloc(0),
      Buffer.from("\ufeff😀é漢a\ufeffz"),
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc0, 0xaf, 0xed, 0xa0, 0x80]),
    ]) {
      const { context } = fixture(original);
      const { bytes, pages } = await reconstruct(context, { resource, pageBytes: 4 });
      expect(bytes).toEqual(original);
      if (original.byteLength === 0) {
        expect(pages).toHaveLength(1);
        expect(pages[0]).toMatchObject({ range: { start: 0, end: 0 }, complete: true, continuation: null });
      } else if (original[0] === 0xff) {
        expect(pages.every((output) => output.encoding === "base64")).toBe(true);
      } else {
        expect(pages.every((output) => output.encoding === "utf8")).toBe(true);
      }
    }
  });

  test("honors explicit encoding and refuses invalid UTF-8 offsets or too-small characters", async () => {
    const { context } = fixture(Buffer.from("😀éx"));
    const first = await page(context, { resource, pageBytes: 4 });
    expect(first.value).toBe("😀");
    expect(first.range).toEqual({ unit: "bytes", start: 0, end: 4 });
    for (const input of [
      { resource, pageBytes: 3, encoding: "utf8" as const },
      { resource, offset: 1, expected: first.binding, encoding: "utf8" as const },
      { resource, offset: 100, expected: first.binding },
    ]) {
      expect(await operation.execute(context, input)).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });
    }
    const base64 = await reconstruct(context, { resource, encoding: "base64", pageBytes: 1 });
    expect(base64.bytes).toEqual(Buffer.from("😀éx"));
    expect(base64.pages.every((output) => output.encoding === "base64")).toBe(true);
    const binary = fixture(Buffer.from([0xff]));
    expect(await operation.execute(binary.context, { resource, encoding: "utf8" })).toMatchObject({
      status: "error", error: { code: "INPUT_INVALID" },
    });
  });

  test("budgets escaped values and repeated long locators in the serialized envelope", async () => {
    const original = Buffer.alloc(40_000, 0x01);
    const { context } = fixture(original);
    const escaped = await reconstruct(context, { resource });
    expect(escaped.bytes).toEqual(original);
    const longLocator = await reconstruct(context, { resource: { ...resource, key: "long/" + "x".repeat(8_000) } });
    expect(longLocator.bytes).toEqual(original);
    expect(longLocator.pages[0]!.range.end).toBeLessThan(escaped.pages[0]!.range.end);
    expect(await operation.execute(context, { resource: { ...resource, key: "x".repeat(80_000) } })).toMatchObject({
      status: "error", error: { code: "INPUT_INVALID" },
    });
  });

  test("rejects changed bytes and expected digest or length even on a recipient's first page", async () => {
    const { context, state } = fixture(Buffer.from("first body"));
    const first = await page(context, { resource, pageBytes: 4 });
    for (const changed of [Buffer.from("other body"), Buffer.from("longer replacement body")]) {
      state.bytes = changed;
      expect(await operation.execute(context, { resource, ...first.continuation! })).toMatchObject({
        status: "error", error: { code: "READ_SOURCE_CHANGED" },
      });
    }
    state.bytes = Buffer.from("first body");
    for (const expected of [
      { ...first.binding, sha256: "0".repeat(64) },
      { ...first.binding, totalBytes: first.binding.totalBytes + 1 },
    ]) {
      expect(await operation.execute(context, { resource, expected })).toMatchObject({
        status: "error", error: { code: "READ_SOURCE_CHANGED" },
      });
    }
    const complete = await page(context, { resource, offset: first.binding.totalBytes, expected: first.binding });
    expect(complete).toMatchObject({ value: "", complete: true, continuation: null });
  });

  test("rejects host, owner, space, and exact resource mismatches", async () => {
    const { context } = fixture(Buffer.from("first body"));
    const first = await page(context, { resource, pageBytes: 4 });
    for (const input of [
      { resource: { ...resource, key: "undocumented/sibling.bin" }, ...first.continuation! },
      { resource: { ...resource, space: "default" }, ...first.continuation! },
      { resource: { ...resource, space: OTHER_SPACE }, ...first.continuation! },
      { resource, expected: { ...first.binding, ownerDid: "did:key:other" } },
      { resource, expected: { ...first.binding, host: "https://other.test" } },
    ]) {
      expect(await operation.execute(context, input)).toMatchObject({ status: "error", error: { code: "READ_CONTEXT_MISMATCH" } });
    }
    const changedContext = { ...context, summary: { ...context.summary, host: "https://other.test" } };
    expect(await operation.execute(changedContext, { resource, ...first.continuation! })).toMatchObject({
      status: "error", error: { code: "READ_CONTEXT_MISMATCH" },
    });
    expect(operation.input.safeParse({ resource, offset: 1 }).success).toBe(false);
    expect(await operation.execute(context, { resource, offset: 1 })).toMatchObject({
      status: "error", error: { code: "INPUT_INVALID" },
    });
  });

  test("allows an independently authorized session but reacquires and respects remote denial", async () => {
    const { context, state } = fixture(Buffer.from("portable original bytes"));
    const first = await page(context, { resource, pageBytes: 4 });
    const recipient = {
      ...context,
      summary: { ...context.summary, profile: "recipient", sessionDid: "did:key:recipient" },
    };
    const checked = await page(recipient, { resource, expected: first.binding });
    expect(checked.binding).toEqual(first.binding);
    expect(Buffer.from(checked.value)).toEqual(Buffer.from(state.bytes));
    state.denied = true;
    for (const input of [{ resource, expected: first.binding }, { resource, ...first.continuation! }]) {
      expect(await operation.execute(recipient, input)).toMatchObject({ status: "error", error: { code: "PERMISSION_DENIED" } });
    }
    expect(state.acquisitions).toBe(4);
  });

  test("retains original acquisition limits instead of claiming paging bypasses them", async () => {
    const { context } = fixture(new Uint8Array(1024 * 1024 + 1));
    expect(await operation.execute(context, { resource })).toMatchObject({ status: "error", error: { code: "KV_RESPONSE_TOO_LARGE" } });
  });

  test("treats explicitly undefined SQL options like omitted options across handoff", async () => {
    const { context } = fixture(Buffer.alloc(0));
    const sqlContext = {
      ...context,
      runtime: {
        ...context.runtime,
        node: {
          sqlForSpace() {
            return {
              db() {
                return {
                  async query() {
                    return { ok: true, data: { columns: ["content"], rows: [["stored value"]] } };
                  },
                };
              },
            };
          },
        },
      },
    };
    const queryResource = {
      kind: "sql" as const, space: "applications", database: "unregistered/app",
      sql: "SELECT content FROM documents",
    };
    const first = await page(sqlContext, { resource: queryResource });
    const explicitUndefined = await page(sqlContext, {
      resource: { ...queryResource, params: undefined, maxRows: undefined, maxBytes: undefined },
      expected: first.binding,
    });
    expect(explicitUndefined.binding).toEqual(first.binding);
    expect(explicitUndefined.value).toBe(first.value);
  });

  test("reconstructs one oversized SQL cell without echoing query parameters", async () => {
    const cell = "large SQL field: 😀\\\"\n".repeat(8_000);
    const queryResource = {
      kind: "sql" as const,
      space: "applications",
      database: "unregistered/app",
      sql: "SELECT content FROM documents WHERE id = ?",
      params: ["private-id".repeat(5_000)],
    };
    const { context } = fixture(Buffer.alloc(0));
    let acquisitions = 0;
    let currentCell = cell;
    const sqlContext = {
      ...context,
      runtime: {
        ...context.runtime,
        node: {
          sqlForSpace() {
            return {
              db() {
                return {
                  async query() {
                    acquisitions++;
                    return { ok: true, data: { columns: ["content"], rows: [[currentCell]] } };
                  },
                };
              },
            };
          },
        },
      },
    };
    const result = await reconstruct(sqlContext, { resource: queryResource });
    expect(JSON.parse(result.bytes.toString("utf8"))).toEqual({
      space: SPACE,
      database: queryResource.database,
      columns: ["content"],
      rows: [[cell]],
      rowCount: 1,
      limits: { maxRows: 100, maxBytes: 1024 * 1024, enforcement: "node-requested-client-verified" },
    });
    expect(acquisitions).toBe(result.pages.length);
    expect(result.pages[0]!.provenance.representation).toBe("normalized-sql-result-json");
    expect(result.pages[0]!.binding.resource).toMatchObject({ kind: "sql", space: SPACE, database: queryResource.database });
    expect(JSON.stringify(result.pages)).not.toContain(queryResource.params[0]!);
    expect(JSON.stringify(result.pages)).not.toContain(queryResource.sql);
    const first = result.pages[0]!;
    for (const changedResource of [
      { ...queryResource, params: ["another-id"] },
      { ...queryResource, sql: "SELECT other FROM documents WHERE id = ?" },
      { ...queryResource, maxRows: 2 },
    ]) {
      expect(await operation.execute(sqlContext, { resource: changedResource, ...first.continuation! })).toMatchObject({
        status: "error", error: { code: "READ_CONTEXT_MISMATCH" },
      });
    }
    currentCell = "new SQL result";
    expect(await operation.execute(sqlContext, { resource: queryResource, ...first.continuation! })).toMatchObject({
      status: "error", error: { code: "READ_SOURCE_CHANGED" },
    });
    expect(operation.input.safeParse({ resource: { ...queryResource, sql: "DELETE FROM documents" } }).success).toBe(false);
    currentCell = "x".repeat(1024 * 1024 + 1);
    expect(await operation.execute(sqlContext, { resource: queryResource })).toMatchObject({
      status: "error", error: { code: "SQL_RESULT_LIMIT_EXCEEDED" },
    });
  });
});
