import { expect, test } from "bun:test";
import { CaveatedDelegationUnsupportedError as SdkCoreError } from "@tinycloud/sdk-core";

import { CaveatedDelegationUnsupportedError as CoreError } from "./core";
import { CaveatedDelegationUnsupportedError as RootError } from "./index";

test("exports CaveatedDelegationUnsupportedError from node root and core", () => {
  expect(RootError).toBe(SdkCoreError);
  expect(CoreError).toBe(SdkCoreError);
});
