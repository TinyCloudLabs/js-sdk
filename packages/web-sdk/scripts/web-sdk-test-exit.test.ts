import { expect, test } from "bun:test";
import { webSdkTestExitFailure } from "./web-sdk-test-exit";

test("a clean web-sdk test run is not a failure", () => {
  expect(webSdkTestExitFailure(0, null)).toBeUndefined();
});

test("a non-zero exit status fails and names the status", () => {
  expect(webSdkTestExitFailure(1, null)).toMatch(/status 1\b/);
});

test("a run killed by a signal fails even without an exit status", () => {
  expect(webSdkTestExitFailure(null, "SIGKILL")).toMatch(/SIGKILL/);
});

test("a run with neither an exit status nor a signal fails", () => {
  expect(webSdkTestExitFailure(null, null)).toMatch(/status null/);
});
