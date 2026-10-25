import type { INotificationHandler } from "@tinycloud/sdk-core";
import type { StringKey } from "../ui/strings";
import type { ToastKind, ToastSink } from "../ui/toast-store";

/** Node-sdk error categories to toast copy. Unknown categories get the generic line. */
const ERROR_CODES: Partial<Record<string, StringKey>> = {
  "auth.wallet_not_connected": "toast.error.auth.wallet_not_connected",
  "auth.signature_rejected": "toast.error.auth.signature_rejected",
  "auth.chain_mismatch": "toast.error.auth.chain_mismatch",
  "storage.upload_failed": "toast.error.storage.upload_failed",
  "storage.insufficient_space": "toast.error.storage.insufficient_space",
  "storage.permission_denied": "toast.error.storage.permission_denied",
  "network.connection_failed": "toast.error.network.connection_failed",
  "network.timeout": "toast.error.network.timeout",
  "wasm.initialization_failed": "toast.error.wasm.initialization_failed",
};

/** Node-sdk success messages to toast copy. Unknown messages get "Done". */
const SUCCESS_CODES: Partial<Record<string, StringKey>> = {
  "Successfully signed in": "toast.signed_in",
};

/** Repeats of the same error within this window collapse into one rethrow. */
const THROW_WINDOW_MS = 200;

/**
 * Routes node-sdk notifications to the host toast. Toasts show fixed copy only;
 * the raw message and description go to the console.
 */
export class BrowserNotificationHandler implements INotificationHandler {
  private readonly toast: ToastSink | undefined;
  private readonly rethrowErrors: boolean;
  private readonly pendingThrows = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param toast Shows a toast in the host. Without it, nothing is shown, but
   * warnings and errors still reach the console.
   * @param rethrowErrors Throw each error's raw message asynchronously, as the
   * old `throwErrors` did. Identical errors within 200 ms collapse into one throw.
   */
  constructor(toast?: ToastSink, rethrowErrors = false) {
    this.toast = toast;
    this.rethrowErrors = rethrowErrors;
  }

  success(message: string): void {
    this.show("success", SUCCESS_CODES[message] ?? "toast.done");
  }

  warning(message: string, description?: string): void {
    console.warn(detail(message, description));
    this.show("warning", "toast.attention");
  }

  error(category: string, message: string, description?: string): void {
    console.error(detail(message, description));
    this.show("error", ERROR_CODES[category] ?? "toast.error_generic");
    if (this.rethrowErrors) this.throwLater(JSON.stringify([category, message, description]), message);
  }

  private show(kind: ToastKind, textCode: StringKey): void {
    this.toast?.({ kind, textCode });
  }

  /** A repeat of the same key restarts the window, so only the last of a burst throws. */
  private throwLater(key: string, message: string): void {
    clearTimeout(this.pendingThrows.get(key));
    this.pendingThrows.set(
      key,
      setTimeout(() => {
        this.pendingThrows.delete(key);
        throw new Error(message);
      }, THROW_WINDOW_MS),
    );
  }

  /** Drops throws still waiting in their window, so none fires after cleanup. */
  cancelPendingThrows(): void {
    for (const timer of this.pendingThrows.values()) clearTimeout(timer);
    this.pendingThrows.clear();
  }
}

/** Console line for a notification: the message, plus its description when present. */
function detail(message: string, description?: string): string {
  return description ? `${message}: ${description}` : message;
}
