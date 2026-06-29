/**
 * Web-sdk authorization module.
 *
 * Provides browser-specific space creation handling with modal confirmations.
 *
 * @packageDocumentation
 */

export {
  ModalSpaceCreationHandler,
  defaultWebSpaceCreationHandler,
} from "./WebSpaceCreationHandler";

// Re-export sdk-core authorization types for convenience
export {
  SignStrategy,
  SignRequest,
  SignResponse,
  SignCallback,
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  EventEmitterStrategy,
  OpenKeySigningStrategyOptions,
  OpenKeySigningRequestBody,
  OpenKeySigningResponseBody,
  OpenKeyCallbackStrategy,
  defaultSignStrategy,
  createOpenKeyCallbackSigningStrategy,
  ISpaceCreationHandler,
  SpaceCreationContext,
  AutoApproveSpaceCreationHandler,
  defaultSpaceCreationHandler,
} from "@tinycloud/sdk-core";
