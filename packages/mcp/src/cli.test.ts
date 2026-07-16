import { expect, test } from "bun:test";

import { parseCliOptions } from "./cli.js";
import { invocationTargetForMcp } from "./tools.js";

test("parses startup options and records whether profile selection was explicit", () => {
  expect(parseCliOptions([
    "--profile",
    "owner",
    "--allow-owner-profile",
  ])).toEqual({
    profile: "owner",
    explicitProfile: true,
    allowOwnerProfile: true,
    help: false,
    version: false,
  });

  expect(parseCliOptions(["--allow-owner-profile"])).toMatchObject({
    explicitProfile: false,
    allowOwnerProfile: true,
  });
});

test("rejects unknown options and missing profile values before transport startup", () => {
  expect(() => parseCliOptions(["--profile"])).toThrow("--profile requires");
  expect(() => parseCliOptions(["--profile", ""])).toThrow("--profile requires");
  expect(() => parseCliOptions(["--profile", " \t "])).toThrow("--profile requires");
  expect(() => parseCliOptions(["--profile="])).toThrow("--profile requires");
  expect(() => parseCliOptions(["--profile= \t "])).toThrow("--profile requires");
  expect(() => parseCliOptions(["--unexpected"])).toThrow("Unknown option");
});

test("projects owner opt-in only for an explicitly selected profile", () => {
  expect(invocationTargetForMcp({
    profile: "default",
    explicitProfile: false,
    allowOwnerProfile: true,
  })).toEqual({ profile: "default" });
  expect(invocationTargetForMcp({
    profile: "owner",
    explicitProfile: true,
    allowOwnerProfile: false,
  })).toEqual({ profile: "owner" });
  expect(invocationTargetForMcp({
    profile: "owner",
    explicitProfile: true,
    allowOwnerProfile: true,
  })).toEqual({ profile: "owner", allowOwnerProfile: true });
});
