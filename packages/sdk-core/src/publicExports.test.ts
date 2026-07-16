import { expect, test } from "bun:test";

import { CaveatedDelegationUnsupportedError as PublicError } from "@tinycloud/sdk-core";

test("exports CaveatedDelegationUnsupportedError from sdk-core", () => {
  const error = new PublicError([]);
  expect(error.name).toBe("CaveatedDelegationUnsupportedError");
  expect(error.code).toBe("CAVEATED_DELEGATION_UNSUPPORTED");
});
