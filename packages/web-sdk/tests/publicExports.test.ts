import { expect, test } from "bun:test";
import type { CaveatedDelegationUnsupportedError as SdkCoreError } from "@tinycloud/sdk-core";
import type { CaveatedDelegationUnsupportedError as WebError } from "../src/index";

type Assert<T extends true> = T;
type SamePublicError = WebError extends SdkCoreError
  ? SdkCoreError extends WebError
    ? true
    : false
  : false;
const hasPublicError: Assert<SamePublicError> = true;

test("exports CaveatedDelegationUnsupportedError from the web facade", () => {
  expect(hasPublicError).toBe(true);
});
