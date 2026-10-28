import { expect, test } from "bun:test";
import { isolatedRunFailure, mergeWebSdkRuns, parseWebSdkRun } from "./web-sdk-test-report";

const junit = (...cases: string[]) => `<testsuites>${cases.join("")}</testsuites>`;
const passing = (file: string, name: string) => `<testcase name="${name}" file="${file}"/>`;
const failing = (file: string, name: string) => `<testcase name="${name}" file="${file}"><failure message="boom"/></testcase>`;
const unhandled = (message: string) => `# Unhandled error between tests\n${"-".repeat(40)}\nerror: ${message}\n${"-".repeat(40)}\n`;

test("a run counts its cases and names only the failing ones", () => {
  const run = parseWebSdkRun(junit(passing("a.test.ts", "ok"), failing("a.test.ts", "bad &amp; sad")), "");
  expect(run.caseCount).toBe(2);
  expect(run.failedNames).toEqual(["a.test.ts::bad & sad"]);
});

test("merged runs keep the cases, failures and unhandled signatures of both", () => {
  const main = parseWebSdkRun(junit(passing("a.test.ts", "one"), failing("a.test.ts", "two")), unhandled("Cannot find package 'eth-testing'"));
  const isolated = parseWebSdkRun(junit(passing("b.isolated.ts", "three"), failing("b.isolated.ts", "four")), unhandled("something new"));
  const merged = mergeWebSdkRuns([main, isolated]);
  expect(merged.caseCount).toBe(4);
  expect(merged.failedNames).toEqual(["a.test.ts::two", "b.isolated.ts::four"]);
  expect(merged.unhandledSignatures).toEqual(["Cannot find package 'eth-testing'", "unrecognized: something new"]);
  expect(merged.unhandledErrors).toBe(2);
});

test("a failure in the isolated run alone survives the merge", () => {
  const main = parseWebSdkRun(junit(passing("a.test.ts", "one")), "");
  const isolated = parseWebSdkRun(junit(failing("b.isolated.ts", "only")), "");
  expect(mergeWebSdkRuns([main, isolated]).failedNames).toEqual(["b.isolated.ts::only"]);
});

test("an isolated run with 0 cases fails and names the label", () => {
  expect(isolatedRunFailure("isolated DecryptExpiry", 0)).toMatch(/isolated DecryptExpiry.*0 test cases/);
});

test("an isolated run with cases is not a failure", () => {
  expect(isolatedRunFailure("isolated DecryptExpiry", 2)).toBeUndefined();
});
