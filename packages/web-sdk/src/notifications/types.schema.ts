/**
 * Zod schemas for TinyCloud notification configuration and modal types.
 *
 * Types are derived from schemas using z.infer<>.
 *
 * @packageDocumentation
 */

import { z } from "zod";

// =============================================================================
// Notification Config
// =============================================================================

/**
 * Notification configuration. Toast placement and visibility are set through
 * `ui`. `.strict()` rejects the removed `popups`, `position`, `duration`, and
 * `maxVisible` keys.
 */
export const NotificationConfigSchema = z
  .object({
    throwErrors: z.boolean().optional(),
  })
  .strict();

// =============================================================================
// Modal Types
// =============================================================================

/**
 * Options for the space creation modal.
 */
export const SpaceCreationModalOptionsSchema = z.object({
  /** Async function called when user clicks "Create Space" */
  onCreateSpace: z.function(),
  /** Optional callback when modal is dismissed */
  onDismiss: z.function().optional(),
});
export type SpaceCreationModalOptions = z.infer<typeof SpaceCreationModalOptionsSchema>;

/**
 * Result from the space creation modal.
 */
export const SpaceCreationResultSchema = z.object({
  /** Whether space creation was successful */
  success: z.boolean(),
  /** Whether the modal was dismissed without creating */
  dismissed: z.boolean(),
});
export type SpaceCreationResult = z.infer<typeof SpaceCreationResultSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validation error type.
 */
export interface ValidationError {
  code: string;
  message: string;
  issues?: unknown[];
}

/**
 * Result type for validation operations.
 */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ValidationError };

/**
 * Validates NotificationConfig.
 */
export function validateNotificationConfig(
  data: unknown
): ValidationResult<z.infer<typeof NotificationConfigSchema>> {
  const result = NotificationConfigSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates SpaceCreationModalOptions.
 */
export function validateSpaceCreationModalOptions(
  data: unknown
): ValidationResult<SpaceCreationModalOptions> {
  const result = SpaceCreationModalOptionsSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Validates SpaceCreationResult.
 */
export function validateSpaceCreationResult(data: unknown): ValidationResult<SpaceCreationResult> {
  const result = SpaceCreationResultSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, data: result.data };
}
