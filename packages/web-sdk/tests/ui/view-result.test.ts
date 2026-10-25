import { describe, expect, test } from "bun:test";

import { viewError, viewLoading, viewNeedsPermission, viewReady } from "../../src/ui/view-result";

describe("ViewResult constructors", () => {
  test("each state carries only its own field, so a view cannot read data from a loading result", () => {
    expect(Object.keys(viewLoading())).toEqual(["state"]);
    expect(Object.keys(viewReady(1))).toEqual(["state", "data"]);
    expect(Object.keys(viewNeedsPermission("space/list"))).toEqual(["state", "ability"]);
    expect(Object.keys(viewError("failed"))).toEqual(["state", "code"]);
  });
});
