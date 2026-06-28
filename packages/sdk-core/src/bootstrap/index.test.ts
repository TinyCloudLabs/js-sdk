import { expect, test } from "bun:test";

import {
  BOOTSTRAP_ALLOWLIST as DIRECT_ALLOWLIST,
  BOOTSTRAP_MANIFEST as DIRECT_MANIFEST,
  BOOTSTRAP_SESSION_REQUESTS as DIRECT_SESSION_REQUESTS,
  bootstrapSteps as directBootstrapSteps,
} from "@tinycloud/bootstrap";
import {
  BOOTSTRAP_ALLOWLIST,
  BOOTSTRAP_MANIFEST,
  BOOTSTRAP_SESSION_REQUESTS,
  bootstrapSteps,
} from "./index";

test("sdk-core bootstrap exports are the standalone @tinycloud/bootstrap objects", () => {
  expect(BOOTSTRAP_MANIFEST).toBe(DIRECT_MANIFEST);
  expect(BOOTSTRAP_ALLOWLIST).toBe(DIRECT_ALLOWLIST);
  expect(BOOTSTRAP_SESSION_REQUESTS).toBe(DIRECT_SESSION_REQUESTS);
  expect(bootstrapSteps).toBe(directBootstrapSteps);
});
