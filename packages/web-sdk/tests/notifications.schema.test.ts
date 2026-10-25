/**
 * Tests for notification type Zod schemas.
 */

import { describe, it, expect } from "bun:test";
import {
  NotificationConfigSchema,
  SpaceCreationModalOptionsSchema,
  SpaceCreationResultSchema,
  validateNotificationConfig,
  validateSpaceCreationModalOptions,
  validateSpaceCreationResult,
} from "../src/notifications/types.schema.js";

// =============================================================================
// NotificationConfig Tests
// =============================================================================

describe("NotificationConfigSchema", () => {
  it("should validate empty config", () => {
    const result = NotificationConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should validate throwErrors", () => {
    const result = NotificationConfigSchema.safeParse({ throwErrors: true });
    expect(result.success).toBe(true);
  });

  it("should reject non-boolean throwErrors", () => {
    const result = NotificationConfigSchema.safeParse({ throwErrors: "true" });
    expect(result.success).toBe(false);
  });

  it("should reject removed toast keys", () => {
    const removed: Record<string, unknown> = {
      popups: true,
      position: "top-right",
      duration: 5000,
      maxVisible: 3,
    };
    for (const [key, value] of Object.entries(removed)) {
      const result = NotificationConfigSchema.safeParse({ [key]: value });
      expect(result.success).toBe(false);
    }
  });
});

// =============================================================================
// SpaceCreationModalOptions Tests
// =============================================================================

describe("SpaceCreationModalOptionsSchema", () => {
  it("should validate options with onCreateSpace", () => {
    const result = SpaceCreationModalOptionsSchema.safeParse({
      onCreateSpace: async () => {},
    });
    expect(result.success).toBe(true);
  });

  it("should validate options with onDismiss", () => {
    const result = SpaceCreationModalOptionsSchema.safeParse({
      onCreateSpace: async () => {},
      onDismiss: () => {},
    });
    expect(result.success).toBe(true);
  });

  it("should reject options without onCreateSpace", () => {
    const result = SpaceCreationModalOptionsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("should reject non-function onCreateSpace", () => {
    const result = SpaceCreationModalOptionsSchema.safeParse({
      onCreateSpace: "not-a-function",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SpaceCreationResult Tests
// =============================================================================

describe("SpaceCreationResultSchema", () => {
  it("should validate success result", () => {
    const result = SpaceCreationResultSchema.safeParse({
      success: true,
      dismissed: false,
    });
    expect(result.success).toBe(true);
  });

  it("should validate dismissed result", () => {
    const result = SpaceCreationResultSchema.safeParse({
      success: false,
      dismissed: true,
    });
    expect(result.success).toBe(true);
  });

  it("should reject result without success", () => {
    const result = SpaceCreationResultSchema.safeParse({
      dismissed: false,
    });
    expect(result.success).toBe(false);
  });

  it("should reject result without dismissed", () => {
    const result = SpaceCreationResultSchema.safeParse({
      success: true,
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Validation Helper Tests
// =============================================================================

describe("validateNotificationConfig", () => {
  it("should return success for valid config", () => {
    const result = validateNotificationConfig({ throwErrors: true });
    expect(result.ok).toBe(true);
  });

  it("should return error for invalid config", () => {
    const result = validateNotificationConfig({ throwErrors: "not-boolean" });
    expect(result.ok).toBe(false);
  });

  it("should return error for removed popups key", () => {
    const result = validateNotificationConfig({ popups: true });
    expect(result.ok).toBe(false);
  });
});

describe("validateSpaceCreationModalOptions", () => {
  it("should return success for valid options", () => {
    const result = validateSpaceCreationModalOptions({
      onCreateSpace: async () => {},
    });
    expect(result.ok).toBe(true);
  });

  it("should return error for invalid options", () => {
    const result = validateSpaceCreationModalOptions({});
    expect(result.ok).toBe(false);
  });
});

describe("validateSpaceCreationResult", () => {
  it("should return success for valid result", () => {
    const result = validateSpaceCreationResult({
      success: true,
      dismissed: false,
    });
    expect(result.ok).toBe(true);
  });

  it("should return error for invalid result", () => {
    const result = validateSpaceCreationResult({ success: true });
    expect(result.ok).toBe(false);
  });
});
