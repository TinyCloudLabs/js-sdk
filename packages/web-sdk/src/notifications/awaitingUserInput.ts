/**
 * Light-DOM beacon for "the SDK is blocked waiting on the user".
 *
 * TinyCloud's blocking prompts are shadow-DOM custom elements
 * (`<tinycloud-space-modal>`, `<tinycloud-permission-modal>`, …). Nothing
 * about them is visible to the host page, to an automated test, or to a
 * support engineer poking at a stuck tab — so a prompt the user cannot see
 * (hidden behind an app loading overlay, rendered off-screen, suppressed by
 * a `z-index` war) is indistinguishable from a hung SDK.
 *
 * This module makes that state observable without changing the prompt UX:
 *
 * - `document.documentElement` gets `data-tinycloud-awaiting-user-input="<kind>"`
 *   for as long as the SDK is blocked. Visible to CSS, to `document.querySelector`,
 *   and to any DOM-driving harness.
 * - A `tinycloud:awaiting-user-input` event fires on `window` when the wait
 *   starts, and `tinycloud:awaiting-user-input-resolved` when it ends. Apps can
 *   subscribe to swap their own "Connecting…" spinner for a "check the dialog"
 *   message.
 * - A `console.warn` explains what is being waited on and what to do about it.
 *
 * @packageDocumentation
 */

/** Attribute set on `<html>` while the SDK is blocked on user input. */
export const AWAITING_USER_INPUT_ATTRIBUTE =
  "data-tinycloud-awaiting-user-input";

/** Window event fired when the SDK starts waiting on the user. */
export const AWAITING_USER_INPUT_EVENT = "tinycloud:awaiting-user-input";

/** Window event fired when the SDK stops waiting on the user. */
export const AWAITING_USER_INPUT_RESOLVED_EVENT =
  "tinycloud:awaiting-user-input-resolved";

/** How a wait for user input ended. */
export type AwaitingUserInputOutcome =
  | "confirmed"
  | "dismissed"
  | "timeout"
  | "error";

/** Payload of the awaiting-user-input events. */
export interface AwaitingUserInputDetail {
  /** Stable identifier for what is being waited on, e.g. `"space-creation"`. */
  kind: string;
  /** Human-readable description of what the SDK needs. */
  message: string;
  /** Milliseconds before the wait gives up, or `null` when it never does. */
  timeoutMs: number | null;
  /** Tag name of the prompt element, when there is one. */
  element?: string;
}

/** Payload of the awaiting-user-input-resolved event. */
export interface AwaitingUserInputResolvedDetail extends AwaitingUserInputDetail {
  outcome: AwaitingUserInputOutcome;
  /** Milliseconds the SDK spent blocked. */
  waitedMs: number;
}

/** Render a millisecond duration without collapsing short waits to "0s". */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`;
}

function dispatch(type: string, detail: unknown): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // A page that has torn down `window` mid-flight must not turn an
    // observability beacon into the actual failure.
  }
}

function documentRoot(): { setAttribute: Function; removeAttribute: Function } | undefined {
  if (typeof document === "undefined") return undefined;
  const root = document.documentElement as unknown as
    | { setAttribute?: Function; removeAttribute?: Function }
    | undefined;
  if (
    !root ||
    typeof root.setAttribute !== "function" ||
    typeof root.removeAttribute !== "function"
  ) {
    return undefined;
  }
  return root as { setAttribute: Function; removeAttribute: Function };
}

/**
 * Mark the SDK as blocked on user input.
 *
 * @returns A function that clears the marker. Safe to call more than once.
 */
export function beginAwaitingUserInput(
  detail: AwaitingUserInputDetail
): (outcome: AwaitingUserInputOutcome) => void {
  const startedAt = Date.now();

  documentRoot()?.setAttribute(AWAITING_USER_INPUT_ATTRIBUTE, detail.kind);
  dispatch(AWAITING_USER_INPUT_EVENT, detail);

  const timeoutNote =
    detail.timeoutMs === null
      ? ""
      : ` It fails after ${formatDuration(detail.timeoutMs)} if it is not answered.`;
  console.warn(
    `[TinyCloud] Waiting for you: ${detail.message}` +
      (detail.element
        ? ` The prompt is a <${detail.element}> element appended to <body>; it uses a shadow root, so it will not appear in the page's own DOM tree and may be hidden behind a full-screen loading overlay.`
        : "") +
      timeoutNote
  );

  let ended = false;
  return (outcome: AwaitingUserInputOutcome) => {
    if (ended) return;
    ended = true;
    documentRoot()?.removeAttribute(AWAITING_USER_INPUT_ATTRIBUTE);
    dispatch(AWAITING_USER_INPUT_RESOLVED_EVENT, {
      ...detail,
      outcome,
      waitedMs: Date.now() - startedAt,
    } satisfies AwaitingUserInputResolvedDetail);
  };
}

/**
 * Whether the SDK is currently blocked on user input.
 *
 * @returns The `kind` of the pending prompt, or `undefined` when nothing is pending.
 */
export function pendingUserInputKind(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const root = document.documentElement as unknown as
    | { getAttribute?: (name: string) => string | null }
    | undefined;
  if (!root || typeof root.getAttribute !== "function") return undefined;
  return root.getAttribute(AWAITING_USER_INPUT_ATTRIBUTE) ?? undefined;
}
