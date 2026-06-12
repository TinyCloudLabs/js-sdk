/**
 * Tests for types.schema.ts Zod schemas.
 */

import { describe, expect, it } from "bun:test";
import {
  ServiceErrorSchema,
  KVResponseHeadersSchema,
  KVListResponseSchema,
  ServiceRequestEventSchema,
  ServiceResponseEventSchema,
  ServiceErrorEventSchema,
  ServiceRetryEventSchema,
  TelemetrySpanEventSchema,
  RetryPolicySchema,
  ServiceSessionSchema,
  GenericResultSchema,
  createResultSchema,
  createKVResponseSchema,
  validateServiceError,
  validateKVListResponse,
  validateKVResponseHeaders,
  validateServiceSession,
  validateRetryPolicy,
  validateServiceRequestEvent,
  validateServiceResponseEvent,
  validateTelemetrySpanEvent,
} from "./types.schema";
import { z } from "zod";

// =============================================================================
// Test Fixtures
// =============================================================================

const validServiceError = {
  code: "KV_NOT_FOUND",
  message: "Key not found",
  service: "kv",
};

const validServiceErrorWithMeta = {
  ...validServiceError,
  meta: { key: "test-key", path: "/data" },
};

const validKVResponseHeaders = {
  etag: '"abc123"',
  contentType: "application/json",
  lastModified: "2026-02-01T12:00:00Z",
  contentLength: 1024,
};

const validKVListResponse = {
  keys: ["key1", "key2", "key3"],
};

const validServiceRequestEvent = {
  service: "kv",
  action: "tinycloud.kv/get",
  span: "sdk.kv.get",
  key: "test-key",
  timestamp: 1706832000000,
};

const validServiceResponseEvent = {
  service: "kv",
  action: "tinycloud.kv/get",
  span: "sdk.kv.get",
  ok: true,
  duration: 150,
  durationMs: 150,
  status: 200,
};

const validTelemetrySpanEvent = {
  span: "sdk.kv.get",
  service: "kv",
  action: "get",
  ok: true,
  durationMs: 150,
};

const validRetryPolicy = {
  maxAttempts: 3,
  backoff: "exponential" as const,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableErrors: ["NETWORK_ERROR", "TIMEOUT"],
};

const validServiceSession = {
  delegationHeader: { Authorization: "Bearer token123" },
  delegationCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  spaceId: "space123",
  verificationMethod: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  jwk: { kty: "EC", crv: "P-256" },
};

// =============================================================================
// ServiceErrorSchema Tests
// =============================================================================

describe("ServiceErrorSchema", () => {
  it("accepts valid service error with required fields", () => {
    const result = ServiceErrorSchema.safeParse(validServiceError);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("KV_NOT_FOUND");
      expect(result.data.service).toBe("kv");
    }
  });

  it("accepts service error with meta", () => {
    const result = ServiceErrorSchema.safeParse(validServiceErrorWithMeta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta).toEqual({ key: "test-key", path: "/data" });
    }
  });

  it("accepts service error with cause", () => {
    const data = {
      ...validServiceError,
      cause: new Error("Original error"),
    };
    const result = ServiceErrorSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects missing code", () => {
    const data = { message: "Error", service: "kv" };
    const result = ServiceErrorSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const data = { code: "ERROR", service: "kv" };
    const result = ServiceErrorSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects missing service", () => {
    const data = { code: "ERROR", message: "Error" };
    const result = ServiceErrorSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects empty object", () => {
    const result = ServiceErrorSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = ServiceErrorSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// KVResponseHeadersSchema Tests
// =============================================================================

describe("KVResponseHeadersSchema", () => {
  it("accepts valid headers with all fields", () => {
    const result = KVResponseHeadersSchema.safeParse(validKVResponseHeaders);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.etag).toBe('"abc123"');
      expect(result.data.contentLength).toBe(1024);
    }
  });

  it("accepts empty object (all fields optional)", () => {
    const result = KVResponseHeadersSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts partial headers", () => {
    const result = KVResponseHeadersSchema.safeParse({
      etag: '"xyz789"',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.etag).toBe('"xyz789"');
      expect(result.data.contentType).toBeUndefined();
    }
  });

  it("rejects invalid contentLength type", () => {
    const data = {
      ...validKVResponseHeaders,
      contentLength: "1024",
    };
    const result = KVResponseHeadersSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = KVResponseHeadersSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// KVListResponseSchema Tests
// =============================================================================

describe("KVListResponseSchema", () => {
  it("accepts valid list response", () => {
    const result = KVListResponseSchema.safeParse(validKVListResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keys).toEqual(["key1", "key2", "key3"]);
    }
  });

  it("accepts empty keys array", () => {
    const result = KVListResponseSchema.safeParse({ keys: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keys).toEqual([]);
    }
  });

  it("rejects missing keys", () => {
    const result = KVListResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects keys with non-string elements", () => {
    const result = KVListResponseSchema.safeParse({
      keys: ["key1", 123, "key3"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array keys", () => {
    const result = KVListResponseSchema.safeParse({
      keys: "key1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = KVListResponseSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// createResultSchema Tests
// =============================================================================

describe("createResultSchema", () => {
  it("creates schema that accepts success result", () => {
    const StringResultSchema = createResultSchema(z.string());
    const result = StringResultSchema.safeParse({
      ok: true,
      data: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.ok) {
      expect(result.data.data).toBe("hello");
    }
  });

  it("creates schema that accepts error result", () => {
    const StringResultSchema = createResultSchema(z.string());
    const result = StringResultSchema.safeParse({
      ok: false,
      error: validServiceError,
    });
    expect(result.success).toBe(true);
    if (result.success && !result.data.ok) {
      expect((result.data.error as { code: string }).code).toBe("KV_NOT_FOUND");
    }
  });

  it("rejects result with wrong data type for success", () => {
    const NumberResultSchema = createResultSchema(z.number());
    const result = NumberResultSchema.safeParse({
      ok: true,
      data: "not a number",
    });
    expect(result.success).toBe(false);
  });

  it("rejects result without ok discriminator", () => {
    const StringResultSchema = createResultSchema(z.string());
    const result = StringResultSchema.safeParse({
      data: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("works with complex nested schemas", () => {
    const UserSchema = z.object({
      id: z.string(),
      name: z.string(),
    });
    const UserResultSchema = createResultSchema(UserSchema);
    const result = UserResultSchema.safeParse({
      ok: true,
      data: { id: "123", name: "John" },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// GenericResultSchema Tests
// =============================================================================

describe("GenericResultSchema", () => {
  it("accepts success result with any data", () => {
    const cases = [
      { ok: true, data: "string" },
      { ok: true, data: 123 },
      { ok: true, data: { nested: "object" } },
      { ok: true, data: [1, 2, 3] },
      { ok: true, data: null },
    ];
    for (const testCase of cases) {
      const result = GenericResultSchema.safeParse(testCase);
      expect(result.success).toBe(true);
    }
  });

  it("accepts error result", () => {
    const result = GenericResultSchema.safeParse({
      ok: false,
      error: validServiceError,
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// createKVResponseSchema Tests
// =============================================================================

describe("createKVResponseSchema", () => {
  it("creates schema that accepts valid KV response", () => {
    const StringResponseSchema = createKVResponseSchema(z.string());
    const result = StringResponseSchema.safeParse({
      data: "hello",
      headers: validKVResponseHeaders,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data).toBe("hello");
      expect(result.data.headers.etag).toBe('"abc123"');
    }
  });

  it("accepts KV response with empty headers", () => {
    const StringResponseSchema = createKVResponseSchema(z.string());
    const result = StringResponseSchema.safeParse({
      data: "hello",
      headers: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong data type", () => {
    const NumberResponseSchema = createKVResponseSchema(z.number());
    const result = NumberResponseSchema.safeParse({
      data: "not a number",
      headers: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing headers", () => {
    const StringResponseSchema = createKVResponseSchema(z.string());
    const result = StringResponseSchema.safeParse({
      data: "hello",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ServiceRequestEventSchema Tests
// =============================================================================

describe("ServiceRequestEventSchema", () => {
  it("accepts valid request event with all fields", () => {
    const result = ServiceRequestEventSchema.safeParse(validServiceRequestEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.service).toBe("kv");
      expect(result.data.action).toBe("tinycloud.kv/get");
    }
  });

  it("accepts request event without optional key", () => {
    const { key, ...withoutKey } = validServiceRequestEvent;
    const result = ServiceRequestEventSchema.safeParse(withoutKey);
    expect(result.success).toBe(true);
  });

  it("rejects missing timestamp", () => {
    const { timestamp, ...withoutTimestamp } = validServiceRequestEvent;
    const result = ServiceRequestEventSchema.safeParse(withoutTimestamp);
    expect(result.success).toBe(false);
  });

  it("rejects non-number timestamp", () => {
    const result = ServiceRequestEventSchema.safeParse({
      ...validServiceRequestEvent,
      timestamp: "2026-02-01",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ServiceResponseEventSchema Tests
// =============================================================================

describe("ServiceResponseEventSchema", () => {
  it("accepts valid response event", () => {
    const result = ServiceResponseEventSchema.safeParse(validServiceResponseEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.duration).toBe(150);
    }
  });

  it("accepts response event without optional status", () => {
    const { status, ...withoutStatus } = validServiceResponseEvent;
    const result = ServiceResponseEventSchema.safeParse(withoutStatus);
    expect(result.success).toBe(true);
  });

  it("accepts response event with ok: false", () => {
    const result = ServiceResponseEventSchema.safeParse({
      ...validServiceResponseEvent,
      ok: false,
      status: 404,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(false);
    }
  });

  it("rejects missing duration", () => {
    const { duration, ...withoutDuration } = validServiceResponseEvent;
    const result = ServiceResponseEventSchema.safeParse(withoutDuration);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// TelemetrySpanEventSchema Tests
// =============================================================================

describe("TelemetrySpanEventSchema", () => {
  it("accepts valid named span event", () => {
    const result = TelemetrySpanEventSchema.safeParse(validTelemetrySpanEvent);
    expect(result.success).toBe(true);
  });

  it("rejects missing span", () => {
    const { span, ...withoutSpan } = validTelemetrySpanEvent;
    const result = TelemetrySpanEventSchema.safeParse(withoutSpan);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ServiceErrorEventSchema Tests
// =============================================================================

describe("ServiceErrorEventSchema", () => {
  it("accepts valid error event", () => {
    const result = ServiceErrorEventSchema.safeParse({
      service: "kv",
      error: validServiceError,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error.code).toBe("KV_NOT_FOUND");
    }
  });

  it("rejects missing error", () => {
    const result = ServiceErrorEventSchema.safeParse({
      service: "kv",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid error structure", () => {
    const result = ServiceErrorEventSchema.safeParse({
      service: "kv",
      error: { invalid: "structure" },
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ServiceRetryEventSchema Tests
// =============================================================================

describe("ServiceRetryEventSchema", () => {
  it("accepts valid retry event", () => {
    const result = ServiceRetryEventSchema.safeParse({
      service: "kv",
      attempt: 2,
      maxAttempts: 3,
      error: validServiceError,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attempt).toBe(2);
    }
  });

  it("rejects zero attempt", () => {
    const result = ServiceRetryEventSchema.safeParse({
      service: "kv",
      attempt: 0,
      maxAttempts: 3,
      error: validServiceError,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative attempt", () => {
    const result = ServiceRetryEventSchema.safeParse({
      service: "kv",
      attempt: -1,
      maxAttempts: 3,
      error: validServiceError,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer attempt", () => {
    const result = ServiceRetryEventSchema.safeParse({
      service: "kv",
      attempt: 1.5,
      maxAttempts: 3,
      error: validServiceError,
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RetryPolicySchema Tests
// =============================================================================

describe("RetryPolicySchema", () => {
  it("accepts valid retry policy", () => {
    const result = RetryPolicySchema.safeParse(validRetryPolicy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backoff).toBe("exponential");
    }
  });

  it("accepts all backoff strategies", () => {
    const strategies = ["none", "linear", "exponential"] as const;
    for (const backoff of strategies) {
      const result = RetryPolicySchema.safeParse({
        ...validRetryPolicy,
        backoff,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid backoff strategy", () => {
    const result = RetryPolicySchema.safeParse({
      ...validRetryPolicy,
      backoff: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative maxAttempts", () => {
    const result = RetryPolicySchema.safeParse({
      ...validRetryPolicy,
      maxAttempts: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero maxAttempts", () => {
    const result = RetryPolicySchema.safeParse({
      ...validRetryPolicy,
      maxAttempts: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative baseDelayMs", () => {
    const result = RetryPolicySchema.safeParse({
      ...validRetryPolicy,
      baseDelayMs: -100,
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero baseDelayMs", () => {
    const result = RetryPolicySchema.safeParse({
      ...validRetryPolicy,
      baseDelayMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty retryableErrors array", () => {
    const result = RetryPolicySchema.safeParse({
      ...validRetryPolicy,
      retryableErrors: [],
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// ServiceSessionSchema Tests
// =============================================================================

describe("ServiceSessionSchema", () => {
  it("accepts valid service session", () => {
    const result = ServiceSessionSchema.safeParse(validServiceSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spaceId).toBe("space123");
    }
  });

  it("rejects missing delegationHeader", () => {
    const { delegationHeader, ...withoutHeader } = validServiceSession;
    const result = ServiceSessionSchema.safeParse(withoutHeader);
    expect(result.success).toBe(false);
  });

  it("rejects invalid delegationHeader structure", () => {
    const result = ServiceSessionSchema.safeParse({
      ...validServiceSession,
      delegationHeader: { InvalidKey: "value" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing spaceId", () => {
    const { spaceId, ...withoutSpaceId } = validServiceSession;
    const result = ServiceSessionSchema.safeParse(withoutSpaceId);
    expect(result.success).toBe(false);
  });

  it("rejects missing jwk", () => {
    const { jwk, ...withoutJwk } = validServiceSession;
    const result = ServiceSessionSchema.safeParse(withoutJwk);
    expect(result.success).toBe(false);
  });

  it("accepts jwk with various structures", () => {
    const jwks = [
      { kty: "EC", crv: "P-256" },
      { kty: "OKP", crv: "Ed25519", x: "abc" },
      { kty: "RSA", n: "...", e: "AQAB" },
    ];
    for (const jwk of jwks) {
      const result = ServiceSessionSchema.safeParse({
        ...validServiceSession,
        jwk,
      });
      expect(result.success).toBe(true);
    }
  });
});

// =============================================================================
// Validation Function Tests
// =============================================================================

describe("validateServiceError", () => {
  it("returns ok result for valid data", () => {
    const result = validateServiceError(validServiceError);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.code).toBe("KV_NOT_FOUND");
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateServiceError({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("validation");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });
});

describe("validateKVListResponse", () => {
  it("returns ok result for valid data", () => {
    const result = validateKVListResponse(validKVListResponse);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.keys).toEqual(["key1", "key2", "key3"]);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateKVListResponse({ keys: "not-an-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("kv");
    }
  });
});

describe("validateKVResponseHeaders", () => {
  it("returns ok result for valid data", () => {
    const result = validateKVResponseHeaders(validKVResponseHeaders);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.etag).toBe('"abc123"');
    }
  });

  it("returns ok result for empty object", () => {
    const result = validateKVResponseHeaders({});
    expect(result.ok).toBe(true);
  });

  it("returns error result for null", () => {
    const result = validateKVResponseHeaders(null);
    expect(result.ok).toBe(false);
  });
});

describe("validateServiceSession", () => {
  it("returns ok result for valid data", () => {
    const result = validateServiceSession(validServiceSession);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.spaceId).toBe("space123");
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateServiceSession({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("session");
    }
  });
});

describe("validateRetryPolicy", () => {
  it("returns ok result for valid data", () => {
    const result = validateRetryPolicy(validRetryPolicy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.maxAttempts).toBe(3);
    }
  });

  it("returns error result for invalid backoff", () => {
    const result = validateRetryPolicy({
      ...validRetryPolicy,
      backoff: "invalid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("config");
    }
  });
});

describe("validateServiceRequestEvent", () => {
  it("returns ok result for valid data", () => {
    const result = validateServiceRequestEvent(validServiceRequestEvent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe("tinycloud.kv/get");
    }
  });

  it("returns error result for missing timestamp", () => {
    const { timestamp, ...withoutTimestamp } = validServiceRequestEvent;
    const result = validateServiceRequestEvent(withoutTimestamp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.service).toBe("telemetry");
    }
  });
});

describe("validateServiceResponseEvent", () => {
  it("returns ok result for valid data", () => {
    const result = validateServiceResponseEvent(validServiceResponseEvent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.duration).toBe(150);
    }
  });

  it("returns error result for missing ok", () => {
    const { ok, ...withoutOk } = validServiceResponseEvent;
    const result = validateServiceResponseEvent(withoutOk);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.service).toBe("telemetry");
    }
  });
});

describe("validateTelemetrySpanEvent", () => {
  it("returns ok result for valid data", () => {
    const result = validateTelemetrySpanEvent(validTelemetrySpanEvent);
    expect(result.ok).toBe(true);
  });

  it("returns error result for missing durationMs", () => {
    const { durationMs, ...withoutDuration } = validTelemetrySpanEvent;
    const result = validateTelemetrySpanEvent(withoutDuration);
    expect(result.ok).toBe(false);
  });
});
