/**
 * Tests for TinyCloud configuration schemas.
 */

import { describe, it, expect } from "bun:test";
import {
  BackoffStrategySchema,
  RetryPolicySchema,
  PartialRetryPolicySchema,
  TinyCloudConfigSchema,
  validateTinyCloudConfig,
  validateRetryPolicy,
} from "./TinyCloud.schema";

describe("BackoffStrategySchema", () => {
  it("should accept valid backoff strategies", () => {
    expect(BackoffStrategySchema.safeParse("none").success).toBe(true);
    expect(BackoffStrategySchema.safeParse("linear").success).toBe(true);
    expect(BackoffStrategySchema.safeParse("exponential").success).toBe(true);
  });

  it("should reject invalid backoff strategies", () => {
    expect(BackoffStrategySchema.safeParse("invalid").success).toBe(false);
    expect(BackoffStrategySchema.safeParse("").success).toBe(false);
    expect(BackoffStrategySchema.safeParse(123).success).toBe(false);
  });
});

describe("RetryPolicySchema", () => {
  const validPolicy = {
    maxAttempts: 3,
    backoff: "exponential" as const,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    retryableErrors: ["NETWORK_ERROR", "TIMEOUT"],
  };

  it("should accept valid retry policy", () => {
    const result = RetryPolicySchema.safeParse(validPolicy);
    expect(result.success).toBe(true);
  });

  it("should accept zero delays", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty retryableErrors array", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      retryableErrors: [],
    });
    expect(result.success).toBe(true);
  });

  it("should reject negative maxAttempts", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      maxAttempts: -1,
    });
    expect(result.success).toBe(false);
  });

  it("should reject zero maxAttempts", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      maxAttempts: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-integer maxAttempts", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      maxAttempts: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("should reject negative delays", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      baseDelayMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid backoff strategy", () => {
    const result = RetryPolicySchema.safeParse({
      ...validPolicy,
      backoff: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("should reject missing required fields", () => {
    expect(RetryPolicySchema.safeParse({}).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ maxAttempts: 3 }).success).toBe(false);
  });
});

describe("PartialRetryPolicySchema", () => {
  it("should accept empty object", () => {
    const result = PartialRetryPolicySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept partial policy", () => {
    const result = PartialRetryPolicySchema.safeParse({
      maxAttempts: 5,
    });
    expect(result.success).toBe(true);
  });

  it("should accept full policy", () => {
    const result = PartialRetryPolicySchema.safeParse({
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: ["NETWORK_ERROR"],
    });
    expect(result.success).toBe(true);
  });

  it("should still validate values when present", () => {
    const result = PartialRetryPolicySchema.safeParse({
      maxAttempts: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("TinyCloudConfigSchema", () => {
  it("should accept empty config", () => {
    const result = TinyCloudConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept minimal config", () => {
    const result = TinyCloudConfigSchema.safeParse({
      hosts: ["https://node.tinycloud.xyz"],
    });
    expect(result.success).toBe(true);
  });

  it("should accept full config", () => {
    const result = TinyCloudConfigSchema.safeParse({
      resolveEns: true,
      hosts: ["https://node.tinycloud.xyz"],
      invoke: () => {},
      fetch: () => {},
      services: {
        kv: class KVService {},
        custom: class CustomService {},
      },
      serviceConfigs: {
        kv: { prefix: "myapp" },
        custom: { maxSize: 1000 },
      },
      retryPolicy: {
        maxAttempts: 5,
        backoff: "linear",
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept resolveEns boolean", () => {
    expect(
      TinyCloudConfigSchema.safeParse({ resolveEns: true }).success
    ).toBe(true);
    expect(
      TinyCloudConfigSchema.safeParse({ resolveEns: false }).success
    ).toBe(true);
  });

  it("should reject non-boolean resolveEns", () => {
    const result = TinyCloudConfigSchema.safeParse({
      resolveEns: "true",
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-array hosts", () => {
    const result = TinyCloudConfigSchema.safeParse({
      hosts: "https://node.tinycloud.xyz",
    });
    expect(result.success).toBe(false);
  });

  it("should accept function invoke", () => {
    const result = TinyCloudConfigSchema.safeParse({
      invoke: () => {},
    });
    expect(result.success).toBe(true);
  });

  it("should reject non-function invoke", () => {
    const result = TinyCloudConfigSchema.safeParse({
      invoke: "not a function",
    });
    expect(result.success).toBe(false);
  });

  it("should accept function fetch", () => {
    const result = TinyCloudConfigSchema.safeParse({
      fetch: () => {},
    });
    expect(result.success).toBe(true);
  });

  it("should reject non-function fetch", () => {
    const result = TinyCloudConfigSchema.safeParse({
      fetch: "not a function",
    });
    expect(result.success).toBe(false);
  });

  it("should accept services record with constructors", () => {
    class MyService {}
    const result = TinyCloudConfigSchema.safeParse({
      services: { myService: MyService },
    });
    expect(result.success).toBe(true);
  });

  it("should reject services with non-function values", () => {
    const result = TinyCloudConfigSchema.safeParse({
      services: { myService: "not a constructor" },
    });
    expect(result.success).toBe(false);
  });

  it("should accept serviceConfigs record", () => {
    const result = TinyCloudConfigSchema.safeParse({
      serviceConfigs: {
        kv: { prefix: "test", nested: { deep: true } },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept partial retryPolicy", () => {
    const result = TinyCloudConfigSchema.safeParse({
      retryPolicy: { maxAttempts: 5 },
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid retryPolicy values", () => {
    const result = TinyCloudConfigSchema.safeParse({
      retryPolicy: { maxAttempts: -1 },
    });
    expect(result.success).toBe(false);
  });
});

describe("validateTinyCloudConfig", () => {
  it("should return ok result for valid config", () => {
    const result = validateTinyCloudConfig({
      hosts: ["https://node.tinycloud.xyz"],
      resolveEns: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hosts).toEqual(["https://node.tinycloud.xyz"]);
      expect(result.data.resolveEns).toBe(true);
    }
  });

  it("should return ok result for empty config", () => {
    const result = validateTinyCloudConfig({});
    expect(result.ok).toBe(true);
  });

  it("should return error result for invalid config", () => {
    const result = validateTinyCloudConfig({
      hosts: "not an array",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("tinycloud");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });
});

describe("validateRetryPolicy", () => {
  it("should return ok result for valid policy", () => {
    const result = validateRetryPolicy({
      maxAttempts: 3,
      backoff: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      retryableErrors: ["NETWORK_ERROR"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.maxAttempts).toBe(3);
      expect(result.data.backoff).toBe("exponential");
    }
  });

  it("should return error result for invalid policy", () => {
    const result = validateRetryPolicy({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("tinycloud");
    }
  });
});
