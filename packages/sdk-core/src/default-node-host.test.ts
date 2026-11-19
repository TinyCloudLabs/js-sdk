import { describe, expect, test } from "bun:test";
import { DEFAULT_NEW_USER_HOST } from "./registry-policy.js";
import { DEFAULT_TINYCLOUD_FALLBACK_HOST } from "./location.js";

const TEE = "https://tee.node.tinycloud.xyz";

describe("the default TinyCloud node", () => {
  test("the fallback host and the new-user host are tee.node.tinycloud.xyz", () => {
    expect(DEFAULT_TINYCLOUD_FALLBACK_HOST).toBe(TEE);
    expect(DEFAULT_NEW_USER_HOST).toBe(TEE);
  });
});
