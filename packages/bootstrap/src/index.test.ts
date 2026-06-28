import { expect, test } from "bun:test";

import {
  BOOTSTRAP_ALLOWLIST,
  BOOTSTRAP_MANIFEST,
  bootstrapSteps,
} from "./index";

test("@tinycloud/bootstrap re-exports the canonical bootstrap surface", () => {
  expect(BOOTSTRAP_MANIFEST.spaces).toHaveLength(5);
  expect(BOOTSTRAP_ALLOWLIST).toHaveLength(10);
  expect(bootstrapSteps("0x1234567890abcdef1234567890abcdef12345678", 1).length)
    .toBeGreaterThan(10);
});
