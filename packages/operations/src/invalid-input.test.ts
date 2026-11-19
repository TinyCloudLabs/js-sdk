import "../test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { z } from "zod";

import { invalidInputMessage } from "./invalid-input.js";
import { appsOperationDefinitions } from "./operations/apps.js";

function message(schema: z.ZodTypeAny, input: unknown): string {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("The input was expected to be invalid.");
  return invalidInputMessage(schema, parsed.error);
}

function apps(tool: "context" | "read" | "write" | "query", input: unknown): string {
  return message(appsOperationDefinitions.find((definition) => definition.id === `tinycloud.apps.${tool}`)!.input, input);
}

test("personal-record tools name the field and what it accepts", () => {
  expect(apps("context", { timezone: "Mars/Olympus" }))
    .toBe("The operation input is invalid. timezone: An IANA timezone is required.");
  expect(apps("query", { kinds: [{ app: "todos", kind: "todo" }], sql: "DELETE FROM entries" }))
    .toBe("The operation input is invalid. sql: SQL must be one SELECT or WITH query.");
  expect(apps("query", { kinds: [{ app: "todos", kind: "todo" }, { app: "books", kind: "note" }], sql: "SELECT 1" }))
    .toBe("The operation input is invalid. kinds: One query covers one app; query each app separately.");
  expect(apps("read", { keys: ["xyz.tinycloud.tinyapps.todos/catalog", "xyz.tinycloud.secrets/private-key"] }))
    .toBe("The operation input is invalid. keys[1]: A personal-record key is xyz.tinycloud.tinyapps.<app>/<kind>/<folder>/<id>, one of that app's catalog keys, or an existing xyz.tinycloud.agent-data/ key.");
  expect(apps("read", { prefixes: ["elsewhere/"] }))
    .toBe("The operation input is invalid. prefixes[0]: A personal-record prefix starts with xyz.tinycloud.tinyapps.<app>/ or xyz.tinycloud.agent-data/ and follows the key layout.");
  expect(apps("write", { ops: [{ op: "put", key: "xyz.tinycloud.tinyapps.todos/todo/open/a", value: { data: "text" } }] }))
    .toBe("The operation input is invalid. ops[0]: record data must be an object.");
});

test("limits and types come from the schema, and every failing field is listed", () => {
  expect(apps("write", { ops: [] })).toBe("The operation input is invalid. ops: minimum items 1.");
  expect(apps("context", { access: "delete" })).toBe("The operation input is invalid. access: must be one of read, change.");
  expect(apps("query", { kinds: [{ app: "todos", kind: "todo" }] })).toBe("The operation input is invalid. sql: required.");
  expect(apps("read", { keys: [7, 7], prefixes: "all" }))
    .toBe("The operation input is invalid. prefixes: must be array; keys[0]: must be string; keys[1]: must be string.");
});

test("a long list of failures is cut to the first five", () => {
  const reasons = apps("read", { keys: Array.from({ length: 40 }, () => 7) }).split("; ");
  expect(reasons).toHaveLength(5);
  expect(reasons.at(-1)).toBe("keys[4]: must be string.");
});

test("no key or value from the input reaches the message", () => {
  const canary = "CANARY-9f3a";
  const schema = z.object({
    mode: z.enum(["read", "change"]),
    label: z.string().max(3),
    record: z.object({ title: z.string() }).strict(),
    tags: z.record(z.string().regex(/^[a-z]+$/)),
  }).strict();
  const text = message(schema, {
    mode: canary,
    label: canary,
    record: { title: 1, [canary]: true },
    tags: { [canary]: canary },
    [canary]: canary,
  });
  expect(text).not.toContain(canary);
  // A name below the top level may be the caller's own key, so only the declared field is named.
  expect(text).toBe(
    "The operation input is invalid. mode: must be one of read, change; label: maximum characters 3; record: must be string; " +
    "record: has a property this operation does not accept; tags: not in an accepted form.",
  );
  expect(apps("write", { ops: [{ op: "put", key: `xyz.tinycloud.secrets/${canary}`, value: { [canary]: canary } }] }))
    .not.toContain(canary);
});

test("an input that is not an object is described without a field name", () => {
  expect(message(z.object({ name: z.string() }), "not-an-object")).toBe("The operation input is invalid. input: must be object.");
});
