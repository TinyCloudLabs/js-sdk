import { expect, test } from "bun:test";

import { lookupOperation } from "./registry.js";

test("I1 registry has no implicit fallback operation", () => {
  expect(lookupOperation("tinycloud.unknown.get", 1)).toEqual({
    status: "operation_not_found",
  });
});
