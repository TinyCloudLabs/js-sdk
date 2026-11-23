/**
 * Tests for space.schema.ts Zod schemas.
 */

import { describe, expect, it } from "bun:test";
import {
  SpaceHostResultSchema,
  validateSpaceHostResult,
} from "./space.schema";

// =============================================================================
// Test Fixtures
// =============================================================================

const validSuccessResult = {
  success: true,
  status: 200,
};

const validFailureResult = {
  success: false,
  status: 404,
  error: "Space not found",
};

// =============================================================================
// SpaceHostResultSchema Tests
// =============================================================================

describe("SpaceHostResultSchema", () => {
  describe("valid inputs", () => {
    it("accepts result with empty error string", () => {
      const data = {
        success: false,
        status: 500,
        error: "",
      };
      const result = SpaceHostResultSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts various HTTP status codes", () => {
      const statusCodes = [200, 201, 204, 400, 401, 403, 404, 409, 500, 502, 503];
      for (const status of statusCodes) {
        const data = { success: status < 400, status };
        const result = SpaceHostResultSchema.safeParse(data);
        expect(result.success).toBe(true);
      }
    });
  });

  describe("invalid inputs", () => {
    it("rejects missing status field", () => {
      const data = { success: true };
      const result = SpaceHostResultSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-boolean success", () => {
      const data = { success: "true", status: 200 };
      const result = SpaceHostResultSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects floating point status", () => {
      const data = { success: true, status: 200.5 };
      const result = SpaceHostResultSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-string error", () => {
      const data = { success: false, status: 500, error: 123 };
      const result = SpaceHostResultSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects null", () => {
      const result = SpaceHostResultSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it("rejects undefined", () => {
      const result = SpaceHostResultSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Validation Function Tests
// =============================================================================

describe("validateSpaceHostResult", () => {
  it("returns ok result for valid success data", () => {
    const result = validateSpaceHostResult(validSuccessResult);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(true);
      expect(result.data.status).toBe(200);
    }
  });

  it("returns ok result for valid failure data", () => {
    const result = validateSpaceHostResult(validFailureResult);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(false);
      expect(result.data.error).toBe("Space not found");
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSpaceHostResult({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("space");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });

  it("returns error with validation issues for missing success", () => {
    const result = validateSpaceHostResult({ status: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["success"] })
      );
    }
  });

  it("returns error with validation issues for invalid status type", () => {
    const result = validateSpaceHostResult({ success: true, status: "200" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["status"] })
      );
    }
  });
});
