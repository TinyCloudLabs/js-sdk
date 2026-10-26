import { expect, test } from "bun:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

import { toolBindingsForTest } from "./tools.js";
import { toMcpJsonSchema } from "./schemas.js";


test("registers exact SQL read and mutation annotations", () => {
  for (const binding of toolBindingsForTest().filter((candidate) =>
    candidate.name.startsWith("tinycloud_sql_") && candidate.name !== "tinycloud_sql_execute")) {
    expect(binding).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  }
  expect(toolBindingsForTest().find((candidate) => candidate.name === "tinycloud_sql_execute"))
    .toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
});


test("default v2 validation preserves nested references, literals, and exclusive bounds", () => {
  const literal = { $schema: "literal-data", items: [{ type: "not-a-schema" }] };
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      measurements: {
        type: "array",
        items: { $ref: "#/$defs/measurement" },
        minItems: 1,
      },
      metadata: { const: literal },
    },
    required: ["measurements", "metadata"],
    additionalProperties: false,
    $defs: {
      measurement: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          value: { type: "number", exclusiveMinimum: 0 },
          unit: { enum: ["kg", "lb"] },
        },
        required: ["value", "unit"],
        additionalProperties: false,
      },
    },
  };
  const validate = new AjvJsonSchemaValidator().getValidator(toMcpJsonSchema(schema));
  const valid = { measurements: [{ value: 0.1, unit: "kg" }], metadata: literal };
  expect(validate(valid).valid).toBe(true);
  expect(validate({ ...valid, measurements: [{ value: 0, unit: "kg" }] }).valid).toBe(false);
  expect(validate({ ...valid, measurements: [{ value: 1 }] }).valid).toBe(false);
  expect(validate({ ...valid, measurements: [{ value: 1, unit: "metres" }] }).valid).toBe(false);
  expect(validate({ ...valid, metadata: { ...literal, $schema: "https://json-schema.org/draft/2020-12/schema" } }).valid)
    .toBe(false);
});

test("rejects dialect-specific forms instead of silently changing their validation", () => {
  for (const schema of [
    { type: "array", items: [{ type: "string" }], additionalItems: false },
    { type: "object", dependencies: { first: ["second"] } },
    { $ref: "#/$defs/value", minLength: 10 },
  ]) {
    expect(() => toMcpJsonSchema(schema)).toThrow();
  }
});

test("personal-app write schemas reserve attribution without restricting nested data or read-back values", async () => {
  const catalog = await Bun.file(new URL("../../operations/generated/operations.json", import.meta.url)).json() as {
    operations: Array<{ id: string; input: Record<string, unknown>; output: Record<string, unknown> }>;
  };
  const validator = new AjvJsonSchemaValidator();
  const write = validator.getValidator(toMcpJsonSchema(catalog.operations.find((operation) => operation.id === "tinycloud.apps.write")!.input));
  const read = validator.getValidator(toMcpJsonSchema(catalog.operations.find((operation) => operation.id === "tinycloud.apps.read")!.output));
  const root = "xyz.tinycloud.agent-data/";
  const etag = `"blake3-${"a".repeat(64)}"`;
  const key = `${root}todos/todo/open/2026-10-06-example`;
  const record = { v: 1, at: "2026-10-06", data: { title: "Example", by: "owner", detail: { by: "guest" } } };
  const ops = [
    { op: "put", key: `${root}catalog/todos`, value: { app: "todos", title: "Todos", about: "Tasks", created: "2026-10-06" } },
    { op: "put", key: `${root}catalog/todos/todo`, value: { app: "todos", kind: "todo", about: "Tasks", shape: "item", states: ["open", "done"], v: 1, fields: { title: "text", by: "text: author" }, created: "2026-10-06" } },
    { op: "put", key, value: record, etag },
    { op: "move", from: key, to: `${root}todos/todo/done/2026-10-06-example`, value: { ...record, data: { ...record.data, done: "2026-10-07" } }, etag },
  ];
  expect(write({ ops }).valid).toBe(true);
  for (const op of ops) {
    for (const by of ["claude-code", "tinycloud-mcp", null]) {
      expect(write({ ops: [{ ...op, value: { ...op.value, by } }] }).valid).toBe(false);
    }
  }
  expect(read({ lists: [], records: [{ key, etag, value: { ...record, by: "codex" } }] }).valid).toBe(true);
});
