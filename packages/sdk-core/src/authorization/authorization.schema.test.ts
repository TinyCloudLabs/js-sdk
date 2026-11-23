/**
 * Tests for authorization.schema.ts Zod schemas.
 */

import { describe, expect, it } from "bun:test";
import {
  // Schemas
  SignTypeSchema,
  SignRequestSchema,
  SignResponseSchema,
  SignCallbackSchema,
  AutoSignStrategySchema,
  AutoRejectStrategySchema,
  CallbackStrategySchema,
  EventEmitterStrategySchema,
  SignStrategySchema,
  SpaceCreationContextSchema,
  // Validation functions
  validateSignRequest,
  validateSignResponse,
  validateSignStrategy,
  validateSpaceCreationContext,
  createAuthorizationValidator,
} from "./authorization.schema";

// =============================================================================
// Test Fixtures
// =============================================================================

const validAddress = "0x1234567890123456789012345678901234567890";

const validSignRequest = {
  address: validAddress,
  chainId: 1,
  message: "Sign this message to authenticate",
  type: "siwe" as const,
};

const validSignResponse = {
  approved: true,
  signature: "0xabcdef1234567890",
};

const validSpaceCreationContext = {
  spaceId: "space-123",
  address: validAddress,
  chainId: 1,
  host: "https://node.tinycloud.xyz",
};

// =============================================================================
// SignType Schema Tests
// =============================================================================

describe("SignTypeSchema", () => {
  it("accepts 'siwe'", () => {
    const result = SignTypeSchema.safeParse("siwe");
    expect(result.success).toBe(true);
  });

  it("accepts 'message'", () => {
    const result = SignTypeSchema.safeParse("message");
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = SignTypeSchema.safeParse("invalid");
    expect(result.success).toBe(false);
  });

  it("rejects non-string values", () => {
    const result = SignTypeSchema.safeParse(123);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SignRequest Schema Tests
// =============================================================================

describe("SignRequestSchema", () => {
  it("accepts valid sign request", () => {
    const result = SignRequestSchema.safeParse(validSignRequest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.address).toBe(validAddress);
      expect(result.data.chainId).toBe(1);
      expect(result.data.type).toBe("siwe");
    }
  });

  it("accepts sign request with message type", () => {
    const result = SignRequestSchema.safeParse({
      ...validSignRequest,
      type: "message",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("message");
    }
  });

  describe("address validation", () => {
    it("rejects missing address", () => {
      const { address, ...request } = validSignRequest;
      const result = SignRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it("accepts any string as address (schema does not validate format)", () => {
      const result = SignRequestSchema.safeParse({
        ...validSignRequest,
        address: "any-string",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("chainId validation", () => {
    it("rejects negative chainId", () => {
      const result = SignRequestSchema.safeParse({
        ...validSignRequest,
        chainId: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero chainId", () => {
      const result = SignRequestSchema.safeParse({
        ...validSignRequest,
        chainId: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects floating point chainId", () => {
      const result = SignRequestSchema.safeParse({
        ...validSignRequest,
        chainId: 1.5,
      });
      expect(result.success).toBe(false);
    });

    it("accepts common chain IDs", () => {
      const chainIds = [1, 5, 10, 137, 42161, 8453];
      for (const chainId of chainIds) {
        const result = SignRequestSchema.safeParse({
          ...validSignRequest,
          chainId,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("message validation", () => {
    it("rejects missing message", () => {
      const { message, ...request } = validSignRequest;
      const result = SignRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it("accepts empty message", () => {
      const result = SignRequestSchema.safeParse({
        ...validSignRequest,
        message: "",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("type validation", () => {
    it("rejects invalid type", () => {
      const result = SignRequestSchema.safeParse({
        ...validSignRequest,
        type: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing type", () => {
      const { type, ...request } = validSignRequest;
      const result = SignRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });

  it("rejects empty object", () => {
    const result = SignRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = SignRequestSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = SignRequestSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SignResponse Schema Tests
// =============================================================================

describe("SignResponseSchema", () => {
  it("accepts valid approved response", () => {
    const result = SignResponseSchema.safeParse(validSignResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approved).toBe(true);
      expect(result.data.signature).toBe("0xabcdef1234567890");
    }
  });

  it("accepts response without optional signature", () => {
    const result = SignResponseSchema.safeParse({
      approved: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approved).toBe(false);
      expect(result.data.signature).toBeUndefined();
    }
  });

  it("accepts rejected response with reason", () => {
    const result = SignResponseSchema.safeParse({
      approved: false,
      reason: "User cancelled the request",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approved).toBe(false);
      expect(result.data.reason).toBe("User cancelled the request");
    }
  });

  it("accepts full response with all fields", () => {
    const result = SignResponseSchema.safeParse({
      approved: true,
      signature: "0xsignature",
      reason: "some reason",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing approved field", () => {
    const result = SignResponseSchema.safeParse({
      signature: "0xsignature",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean approved", () => {
    const result = SignResponseSchema.safeParse({
      approved: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty object", () => {
    const result = SignResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = SignResponseSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SignStrategy Schema Tests (Discriminated Union)
// =============================================================================

describe("AutoSignStrategySchema", () => {
  it("accepts valid auto-sign strategy", () => {
    const result = AutoSignStrategySchema.safeParse({ type: "auto-sign" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("auto-sign");
    }
  });

  it("rejects wrong type literal", () => {
    const result = AutoSignStrategySchema.safeParse({ type: "auto-reject" });
    expect(result.success).toBe(false);
  });
});

describe("AutoRejectStrategySchema", () => {
  it("accepts valid auto-reject strategy", () => {
    const result = AutoRejectStrategySchema.safeParse({ type: "auto-reject" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("auto-reject");
    }
  });

  it("rejects wrong type literal", () => {
    const result = AutoRejectStrategySchema.safeParse({ type: "auto-sign" });
    expect(result.success).toBe(false);
  });
});

describe("CallbackStrategySchema", () => {
  it("accepts valid callback strategy", () => {
    const handler = async () => ({ approved: true });
    const result = CallbackStrategySchema.safeParse({
      type: "callback",
      handler,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("callback");
      expect(typeof result.data.handler).toBe("function");
    }
  });

  it("rejects callback strategy without handler", () => {
    const result = CallbackStrategySchema.safeParse({ type: "callback" });
    expect(result.success).toBe(false);
  });

  it("rejects callback strategy with non-function handler", () => {
    const result = CallbackStrategySchema.safeParse({
      type: "callback",
      handler: "not-a-function",
    });
    expect(result.success).toBe(false);
  });
});

describe("EventEmitterStrategySchema", () => {
  it("accepts valid event-emitter strategy", () => {
    const emitter = new EventTarget();
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("event-emitter");
    }
  });

  it("accepts event-emitter strategy with timeout", () => {
    const emitter = new EventTarget();
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter,
      timeout: 30000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout).toBe(30000);
    }
  });

  it("rejects event-emitter strategy without emitter", () => {
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
    });
    expect(result.success).toBe(false);
  });

  it("rejects event-emitter strategy with invalid emitter", () => {
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter: "not-an-emitter",
    });
    expect(result.success).toBe(false);
  });

  it("rejects event-emitter strategy with null emitter", () => {
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative timeout", () => {
    const emitter = new EventTarget();
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter,
      timeout: -1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero timeout", () => {
    const emitter = new EventTarget();
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter,
      timeout: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects floating point timeout", () => {
    const emitter = new EventTarget();
    const result = EventEmitterStrategySchema.safeParse({
      type: "event-emitter",
      emitter,
      timeout: 1000.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("SignStrategySchema (discriminated union)", () => {
  it("accepts auto-sign strategy", () => {
    const result = SignStrategySchema.safeParse({ type: "auto-sign" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("auto-sign");
    }
  });

  it("accepts auto-reject strategy", () => {
    const result = SignStrategySchema.safeParse({ type: "auto-reject" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("auto-reject");
    }
  });

  it("accepts callback strategy", () => {
    const handler = async () => ({ approved: true });
    const result = SignStrategySchema.safeParse({
      type: "callback",
      handler,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("callback");
    }
  });

  it("accepts event-emitter strategy", () => {
    const emitter = new EventTarget();
    const result = SignStrategySchema.safeParse({
      type: "event-emitter",
      emitter,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("event-emitter");
    }
  });

  it("rejects unknown strategy type", () => {
    const result = SignStrategySchema.safeParse({ type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("rejects missing type", () => {
    const result = SignStrategySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = SignStrategySchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = SignStrategySchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SpaceCreationContext Schema Tests
// =============================================================================

describe("SpaceCreationContextSchema", () => {
  it("accepts valid space creation context", () => {
    const result = SpaceCreationContextSchema.safeParse(validSpaceCreationContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spaceId).toBe("space-123");
      expect(result.data.address).toBe(validAddress);
      expect(result.data.chainId).toBe(1);
      expect(result.data.host).toBe("https://node.tinycloud.xyz");
    }
  });

  describe("spaceId validation", () => {
    it("rejects missing spaceId", () => {
      const { spaceId, ...context } = validSpaceCreationContext;
      const result = SpaceCreationContextSchema.safeParse(context);
      expect(result.success).toBe(false);
    });
  });

  describe("chainId validation", () => {
    it("rejects negative chainId", () => {
      const result = SpaceCreationContextSchema.safeParse({
        ...validSpaceCreationContext,
        chainId: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero chainId", () => {
      const result = SpaceCreationContextSchema.safeParse({
        ...validSpaceCreationContext,
        chainId: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects floating point chainId", () => {
      const result = SpaceCreationContextSchema.safeParse({
        ...validSpaceCreationContext,
        chainId: 1.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("host validation", () => {
    it("rejects missing host", () => {
      const { host, ...context } = validSpaceCreationContext;
      const result = SpaceCreationContextSchema.safeParse(context);
      expect(result.success).toBe(false);
    });

    it("rejects invalid URL", () => {
      const result = SpaceCreationContextSchema.safeParse({
        ...validSpaceCreationContext,
        host: "not-a-url",
      });
      expect(result.success).toBe(false);
    });

    it("accepts various valid URLs", () => {
      const hosts = [
        "https://node.tinycloud.xyz",
        "http://localhost:8000",
        "https://api.example.com:3000/path",
      ];
      for (const host of hosts) {
        const result = SpaceCreationContextSchema.safeParse({
          ...validSpaceCreationContext,
          host,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  it("rejects empty object", () => {
    const result = SpaceCreationContextSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = SpaceCreationContextSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = SpaceCreationContextSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Validation Helper Tests
// =============================================================================

describe("validateSignRequest", () => {
  it("returns ok result for valid data", () => {
    const result = validateSignRequest(validSignRequest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.address).toBe(validAddress);
      expect(result.data.chainId).toBe(1);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSignRequest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("authorization");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });

  it("returns error with validation issues for invalid chainId", () => {
    const result = validateSignRequest({
      ...validSignRequest,
      chainId: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["chainId"] })
      );
    }
  });
});

describe("validateSignResponse", () => {
  it("returns ok result for valid data", () => {
    const result = validateSignResponse(validSignResponse);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.approved).toBe(true);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSignResponse({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("validateSignStrategy", () => {
  it("returns ok result for valid auto-sign strategy", () => {
    const result = validateSignStrategy({ type: "auto-sign" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("auto-sign");
    }
  });

  it("returns ok result for valid callback strategy", () => {
    const handler = async () => ({ approved: true });
    const result = validateSignStrategy({ type: "callback", handler });
    expect(result.ok).toBe(true);
  });

  it("returns error result for invalid strategy type", () => {
    const result = validateSignStrategy({ type: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("validateSpaceCreationContext", () => {
  it("returns ok result for valid data", () => {
    const result = validateSpaceCreationContext(validSpaceCreationContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.spaceId).toBe("space-123");
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSpaceCreationContext({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns error with validation issues for invalid host", () => {
    const result = validateSpaceCreationContext({
      ...validSpaceCreationContext,
      host: "not-a-url",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["host"] })
      );
    }
  });
});

describe("createAuthorizationValidator", () => {
  it("creates a working validator for SignTypeSchema", () => {
    const validateSignType = createAuthorizationValidator(SignTypeSchema);

    const validResult = validateSignType("siwe");
    expect(validResult.ok).toBe(true);

    const invalidResult = validateSignType("invalid");
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.error.service).toBe("authorization");
    }
  });

  it("creates a working validator for SignRequestSchema", () => {
    const validateRequest = createAuthorizationValidator(SignRequestSchema);

    const validResult = validateRequest(validSignRequest);
    expect(validResult.ok).toBe(true);

    const invalidResult = validateRequest({ address: "test" });
    expect(invalidResult.ok).toBe(false);
  });
});
