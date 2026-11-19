import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { GEMINI_INSTRUCTIONS, GEMINI_TOOLS } from "./gemini-tools.js";

const published = JSON.parse(await readFile(new URL("./gemini-tools.snapshot.json", import.meta.url), "utf8")) as {
  instructions: string; tools: unknown[];
};

test("the Gemini tools and instructions are the published snapshot; a change is a new version on a new address", () => {
  // Google snapshots the tools, their arguments and the instructions when a version is published and may disable an
  // app whose server then differs. Do not update the snapshot to make this pass: add a new address with its own tools.
  expect(GEMINI_INSTRUCTIONS).toBe(published.instructions);
  expect(JSON.parse(JSON.stringify(GEMINI_TOOLS))).toEqual(published.tools);
});

test("every Gemini tool states its effect, and only the connection check neither reads only nor asks first", () => {
  const effects = Object.fromEntries(GEMINI_TOOLS.map((tool) => [
    tool.name, [tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.openWorldHint],
  ]));
  expect(effects).toEqual({
    tinycloud_connect: [false, false, false],
    tinycloud_list_apps: [true, false, false],
    tinycloud_get_app: [true, false, false],
    tinycloud_list_records: [true, false, false],
    tinycloud_set_timezone: [false, true, false],
    tinycloud_create_app: [false, true, false],
    tinycloud_create_kind: [false, true, false],
    tinycloud_create_record: [false, true, false],
    tinycloud_update_record: [false, true, false],
    tinycloud_move_record: [false, true, false],
    tinycloud_delete_record: [false, true, false],
  });
  for (const tool of GEMINI_TOOLS) expect(typeof tool.annotations.idempotentHint, tool.name).toBe("boolean");
});

test("the Gemini schemas stay flat, typed and free of batch or dispatch inputs", () => {
  const depth = (schema: unknown): number => {
    if (typeof schema !== "object" || schema === null) return 0;
    const node = schema as { properties?: Record<string, unknown>; items?: unknown; additionalProperties?: unknown };
    const children = [...Object.values(node.properties ?? {}), node.items, node.additionalProperties];
    return (node.properties === undefined ? 0 : 1) + Math.max(0, ...children.map(depth));
  };
  for (const tool of GEMINI_TOOLS) {
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema, tool.name).not.toMatch(/"(anyOf|oneOf|allOf|\$ref)"/);
    expect(schema, tool.name).not.toMatch(/"(sql|query|ops|command|tool|prompt|conversation|context)"/);
    // An argument object, and at most one object below it: a field of a new kind.
    expect(depth(tool.inputSchema), tool.name).toBeLessThanOrEqual(2);
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(tool.name).toMatch(/^tinycloud_[a-z]+(_[a-z]+)*$/);
  }
});

test("the Gemini instructions describe the service and name no tool", () => {
  expect(GEMINI_INSTRUCTIONS).not.toMatch(/tinycloud_/);
  expect(GEMINI_INSTRUCTIONS.length).toBeLessThan(1000);
});
