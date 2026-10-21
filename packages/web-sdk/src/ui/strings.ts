/**
 * All panel, button, and toast copy. Rendered only through lookup by code.
 * Reason and error codes from the SDK never render as raw text.
 */
export const STRINGS = {
  "panel.title": "TinyCloud",
  "panel.close": "Close",
  "panel.hide": "Hide button",
  "button.aria": "TinyCloud settings",

  "status.storage_full": "Storage is full",
  "status.sync_pending": "Erase not confirmed",
  "status.sync_attention": "Local copy needs attention",

  "sync.label": "Local copy on this device",
  "sync.switch": "Keep a local copy on this device",
  "sync.busy.enabling": "Turning on",
  "sync.busy.wiping": "Erasing",
  "sync.pending": "Erase not confirmed",
  "sync.unavailable": "Not available here",
  "sync.wipe.button": "Erase local copy",
  "sync.wipe.question": "Erase this device's TinyCloud copy?",
  "sync.wipe.confirm": "Erase",
  "sync.wipe.cancel": "Cancel",
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
} as const;

export type StringKey = keyof typeof STRINGS;

export function hasString(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(STRINGS, key);
}

/** Lookup by code. Unknown codes return the neutral line, never the raw code. */
export function text(code: string): string {
  return hasString(code) ? STRINGS[code] : STRINGS["sync.reason.unknown"];
}
