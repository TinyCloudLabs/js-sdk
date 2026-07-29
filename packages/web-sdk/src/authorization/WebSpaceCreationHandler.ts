/**
 * Web-specific space creation handler using modal.
 *
 * @packageDocumentation
 */

import {
  AutoApproveSpaceCreationHandler,
  ISpaceCreationHandler,
  SpaceCreationContext,
} from "@tinycloud/sdk-core";
import {
  ModalManager,
  showSpaceCreationModal,
} from "../notifications/ModalManager";
import { dispatchSDKEvent } from "../notifications/ErrorHandler";
import {
  beginAwaitingUserInput,
  formatDuration,
} from "../notifications/awaitingUserInput";

/**
 * How long {@link ModalSpaceCreationHandler} waits for the user to answer the
 * space-creation dialog before failing sign-in.
 *
 * Two minutes is long enough for a first-time user to read the dialog and
 * decide, and short enough that a dialog nobody can see surfaces as an error
 * instead of an apparently frozen app.
 */
export const DEFAULT_SPACE_CREATION_TIMEOUT_MS = 120_000;

/**
 * Thrown when the space-creation dialog is never answered.
 *
 * This is what users experience as "sign-in hangs forever": the SDK is not
 * stuck, it is blocked on a click in a shadow-DOM dialog that may be invisible
 * behind the app's own loading overlay.
 */
export class SpaceCreationTimeoutError extends Error {
  /** Stable, matchable error code. */
  readonly code = "SPACE_CREATION_TIMEOUT";

  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `TinyCloud waited ${formatDuration(timeoutMs)} for you to confirm creating your ` +
        `TinyCloud Space and got no answer. The confirmation dialog is a ` +
        `<tinycloud-space-modal> element appended to <body>; because it renders in a shadow ` +
        `root it can sit behind a full-screen loading overlay and never be seen. ` +
        `Fixes: dismiss or lower the z-index of any overlay shown during sign-in and retry; ` +
        `or set autoCreateSpace: true on TinyCloudWeb to create the space without a dialog; ` +
        `or pass your own spaceCreationHandler to prompt in your own UI.`
    );
    this.name = "SpaceCreationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Options for {@link ModalSpaceCreationHandler}.
 */
export interface ModalSpaceCreationHandlerOptions {
  /**
   * How long to wait for the user to answer the dialog, in milliseconds.
   * Defaults to {@link DEFAULT_SPACE_CREATION_TIMEOUT_MS}. Pass `0` (or a
   * negative value) to wait forever — only sensible when you have verified the
   * dialog is actually reachable in your UI.
   */
  timeoutMs?: number;
}

/**
 * Space creation handler that shows a modal for user confirmation.
 *
 * This is the default handler for web applications, providing a
 * user-friendly confirmation dialog before creating a new space.
 *
 * The wait for the user is bounded: if the dialog is not answered within
 * {@link ModalSpaceCreationHandlerOptions.timeoutMs} the handler rejects with a
 * {@link SpaceCreationTimeoutError} rather than blocking sign-in forever.
 *
 * @example
 * ```typescript
 * const auth = new WebUserAuthorization({
 *   provider: window.ethereum,
 *   spaceCreationHandler: new ModalSpaceCreationHandler({ timeoutMs: 60_000 }),
 * });
 * ```
 */
export class ModalSpaceCreationHandler implements ISpaceCreationHandler {
  private readonly timeoutMs: number;

  constructor(options: ModalSpaceCreationHandlerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SPACE_CREATION_TIMEOUT_MS;
  }

  /**
   * Show a modal to confirm space creation.
   * Returns true if user confirms, false if dismissed.
   *
   * @throws {@link SpaceCreationTimeoutError} if the dialog is never answered.
   */
  async confirmSpaceCreation(context: SpaceCreationContext): Promise<boolean> {
    const timeoutMs = this.timeoutMs;
    const bounded = timeoutMs > 0;

    const endBeacon = beginAwaitingUserInput({
      kind: "space-creation",
      message: `confirm creating your TinyCloud Space (${context.spaceId}) on ${context.host}.`,
      timeoutMs: bounded ? timeoutMs : null,
      element: "tinycloud-space-modal",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;

    const decision = new Promise<boolean>((resolve) => {
      showSpaceCreationModal({
        onCreateSpace: async () => {
          // Just resolve true - actual creation happens in WebUserAuthorization
          resolve(true);
        },
        onDismiss: () => {
          resolve(false);
        },
      });
    });

    try {
      if (!bounded) {
        const confirmed = await decision;
        endBeacon(confirmed ? "confirmed" : "dismissed");
        return confirmed;
      }

      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SpaceCreationTimeoutError(timeoutMs)),
          timeoutMs
        );
      });

      const confirmed = await Promise.race([decision, expiry]);
      endBeacon(confirmed ? "confirmed" : "dismissed");
      return confirmed;
    } catch (error) {
      if (error instanceof SpaceCreationTimeoutError) {
        // Nothing is going to answer this dialog. Take it down so the page is
        // not left with an invisible modal trapping scroll and focus.
        ModalManager.getInstance().closeActiveModal();
        endBeacon("timeout");
        dispatchSDKEvent.error(
          "storage.space_creation_timeout",
          "Setting up your TinyCloud Space timed out",
          error.message
        );
      } else {
        endBeacon("error");
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Show success notification after space creation.
   */
  onSpaceCreated(context: SpaceCreationContext): void {
    dispatchSDKEvent.success("TinyCloud Space created successfully");
  }

  /**
   * Show error notification if space creation fails.
   */
  onSpaceCreationFailed(context: SpaceCreationContext, error: Error): void {
    dispatchSDKEvent.error(
      "storage.space_creation_failed",
      "Failed to create your TinyCloud Space",
      error.message
    );
  }
}

/**
 * Default web space creation handler using modal confirmation.
 */
export const defaultWebSpaceCreationHandler: ISpaceCreationHandler =
  new ModalSpaceCreationHandler();

/**
 * Configuration subset that decides how the browser confirms space creation.
 */
export interface SpaceCreationHandlerConfig {
  /** See `TinyCloudWeb.Config.autoCreateSpace`. */
  autoCreateSpace?: boolean;
  /** See `TinyCloudWeb.Config.spaceCreationHandler`. */
  spaceCreationHandler?: ISpaceCreationHandler;
  /** See `TinyCloudWeb.Config.spaceCreationTimeoutMs`. */
  spaceCreationTimeoutMs?: number;
}

/**
 * Pick the space-creation handler a browser app should run with.
 *
 * The precedence is deliberate, and is the reason `autoCreateSpace: true` is
 * honoured in the browser rather than being silently overridden:
 *
 * - An explicit `spaceCreationHandler` always wins — the caller asked for a
 *   specific UX.
 * - `autoCreateSpace: true` means "create it, don't ask me". Returning the
 *   modal handler here would contradict the documented option and leave callers
 *   blocked on a dialog they explicitly opted out of.
 * - `autoCreateSpace: false` means "don't create it". No handler at all, so
 *   `ensureSpaceExists` skips creation silently.
 * - Unset is the default browser experience: confirm in a modal first, because
 *   creating a space costs the user a wallet signature.
 */
export function resolveSpaceCreationHandler(
  config: SpaceCreationHandlerConfig
): ISpaceCreationHandler | undefined {
  if (config.spaceCreationHandler) return config.spaceCreationHandler;
  if (config.autoCreateSpace === true) {
    return new AutoApproveSpaceCreationHandler();
  }
  if (config.autoCreateSpace === false) return undefined;
  return new ModalSpaceCreationHandler({
    timeoutMs: config.spaceCreationTimeoutMs,
  });
}
