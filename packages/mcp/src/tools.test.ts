import { expect, test } from "bun:test";

import { toolBindingsForTest } from "./tools.js";


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

