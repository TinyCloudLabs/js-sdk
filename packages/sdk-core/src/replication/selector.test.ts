import { describe, expect, test } from "bun:test";
import { grantPathsForSelector } from "./selector";

describe("grantPathsForSelector", () => {
  test("distinguishes bare, trailing-slash, and root selectors", () => {
    expect(grantPathsForSelector("notes")).toEqual(["notes", "notes/"]);
    expect(grantPathsForSelector("notes/")).toEqual(["notes/"]);
    expect(grantPathsForSelector("")).toEqual([""]);
  });
});
