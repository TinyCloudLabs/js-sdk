/**
 * All panel, button, and toast copy. Rendered only through lookup by code.
 * Reason and error codes from the SDK never render as raw text.
 */
export const STRINGS = {
  "panel.title": "TinyCloud",
  "panel.close": "Close",
  "panel.hide": "Hide button",
  "panel.sections": "Sections",
  "panel.in": "in",
  "panel.back": "Back to",
  "section.placeholder": "Not available yet.",
  "view.loading": "Loading…",
  "view.error": "This didn't load.",
  "view.retry": "Try again",
  "view.permission": "This session can't show this yet.",
  "nodes.kind.hosted": "Hosted",
  "nodes.status.down": "Down",
  "nodes.version": "Version",
  "nodes.latency": "Latency",
  "activity.empty": "No requests yet.",
  "nav.account": "Overview",
  "nav.local-tinycloud": "Local TinyCloud",
  "nav.local-copy": "Local copy",
  "nav.delegations": "Delegations",
  "nav.nodes": "Nodes",
  "nav.storage": "Storage",
  "nav.activity": "Activity",
  "button.aria": "TinyCloud settings",

  "status.storage_full": "Storage is full",
  "status.sync_pending": "Erase not confirmed",
  "status.sync_attention": "Local copy needs attention",

  "storage.state.full": "Storage is full",
  "storage.declined": "You declined. Storage usage stays hidden.",
  "storage.try_again": "Try again",
  "storage.unavailable": "Storage usage isn't available here.",
  "storage.manage": "Manage storage",
  "storage.full": "Storage is full. Free up space or upgrade to keep saving.",

  "sync.wipe.note":
    "Erases TinyCloud's copy on this device. Your data stays on your TinyCloud; the app's own files are not touched.",
  "sync.error.declined": "You declined. The local copy stays off.",
  "sync.error.unsupported": "This browser can't keep a local copy.",
  "sync.error.failed": "That didn't work. Try again.",

  "sync.reason.unsupported-browser": "This browser can't keep a local copy.",
  "sync.reason.no-eligible-scope": "No space on this TinyCloud account can keep a local copy.",
  "sync.reason.consent-declined": "You declined. The local copy stays off.",
  "sync.reason.storage-blocked": "This browser blocks the storage the local copy needs.",
  "sync.reason.erase-pending": "The last erase is not confirmed yet.",
  "sync.reason.budget-reached": "This device's local copy has reached its size limit.",
  "sync.reason.signed-out": "Sign in to use the local copy.",
  "sync.reason.stale-tab": "Another tab changed this. Reload to continue.",
  "sync.reason.wipe-failed": "Erase didn't finish. The local copy may still be on this device.",
  "sync.reason.session-expired": "Your session expired. Sign in again.",
  "sync.reason.unknown": "Something went wrong with the local copy.",

  "toast.done": "Done",
  "toast.signed_in": "Successfully signed in",
  "toast.attention": "Something needs your attention. Details are in the console.",
  "toast.error_generic": "Something went wrong.",
  "toast.unexpected_error": "An unexpected error occurred. Try refreshing the page.",
  "toast.space_created": "TinyCloud Space created successfully",
  "toast.space_creation_timeout": "Setting up your TinyCloud Space timed out",
  "toast.space_creation_failed": "Failed to create your TinyCloud Space",
  "toast.error.auth.wallet_not_connected": "Please connect your wallet to continue",
  "toast.error.auth.signature_rejected": "Signature was rejected. Please try again",
  "toast.error.auth.chain_mismatch": "Please switch to the correct network",
  "toast.error.storage.upload_failed": "Failed to upload file. Please check your connection",
  "toast.error.storage.insufficient_space": "Insufficient storage space available",
  "toast.error.storage.permission_denied": "Permission denied. Please check your access rights",
  "toast.error.network.connection_failed": "Network connection failed. Please try again",
  "toast.error.network.timeout": "Request timed out. Please try again",
  "toast.error.wasm.initialization_failed": "Failed to initialize security module",
} as const;

export type StringKey = keyof typeof STRINGS;

export function hasString(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(STRINGS, key);
}

/** Lookup by code. Unknown codes return the neutral line, never the raw code. */
export function text(code: string): string {
  return hasString(code) ? STRINGS[code] : STRINGS["sync.reason.unknown"];
}
