import { text as eagerText } from "./strings";

/**
 * Overview, sign-out prompt, and glance copy. Lazy: only the panel chunk
 * imports this, so the launcher bundle never carries these keys.
 * Toast and launcher keys stay in strings.ts.
 */
const PANEL_STRINGS = {
  "panel.full_page": "Open full page",
  "panel.sidebar": "Show as sidebar",
  "toast.dismiss": "Dismiss",
  "toast.copy_receipt": "Copy receipt",
  "toast.copied": "Copied",
  "toast.copy_failed": "Couldn't copy. Select the text and copy it by hand.",
  "account.copied": "DID copied",
  "account.copy_failed": "Could not copy the DID",
  "account.signed_out": "TinyCloud is signed out in this app. Sign in to see your account.",
  "account.signed_in_as": "Signed in as",
  "account.copy_did": "Copy your DID",
  "account.hint": "Need more room? Choose Open full page, at the top, for these same sections on a full screen.",
  "account.button.title": "This button",
  "account.button.body": "Hide the TinyCloud button. Your app can still open this panel with tc.ui.open().",
  "account.loading": "Loading account…",
  "account.unavailable": "Account details are unavailable.",
  "account.session.label": "Session",
  "account.session.expires": "Expires in {hours}h {minutes}m",
  "account.app.label": "You're in",
  "account.glance.title": "At a glance",
  "account.signout.button": "Sign out",
  "account.signout.question": "Sign out of TinyCloud on this device?",
  "account.signout.cancel": "Stay signed in",
  "account.signout.confirm": "Sign out",
  "account.signout.busy": "Signing out…",
  "account.signout.failed": "Sign-out failed. Try again.",
  "glance.local-tinycloud": "Use a TinyCloud node on this computer",
  "glance.local-copy": "Keep a copy of your data on this device",
  "glance.delegations": "Who can act on your data",
  "glance.nodes": "Nodes your data syncs with",
  "glance.storage": "How much space is used",
  "glance.activity": "Recent requests this session",
  "glance.word.found": "Found",
  "glance.word.looking": "Looking",
  "glance.word.not_found": "Not found",
  "glance.word.on": "On",
  "glance.word.off": "Off",
  "glance.word.none": "None",
  "glance.word.visible": "Visible",
  "glance.word.needs_permission": "Needs permission",
  "glance.word.normal": "Normal",
  "glance.word.nearly_full": "Nearly full",
  "glance.word.full": "Full",
  "glance.word.healthy": "Healthy",
  "glance.word.slow": "{count} slow",
  "glance.word.down": "{count} down",
  "glance.word.errors": "{count} errors",
  "glance.word.no_errors": "No errors",
  "glance.word.checking": "Checking",
  "glance.word.unavailable": "Unavailable",
} as const satisfies Readonly<Record<string, string>>;

export type PanelStringKey = keyof typeof PANEL_STRINGS;

/** Panel-only lookup. Falls back to the launcher table, then to the neutral line. */
export function panelText(code: string, params: Readonly<Record<string, string | number>> = {}): string {
  const raw: string = Object.prototype.hasOwnProperty.call(PANEL_STRINGS, code)
    ? PANEL_STRINGS[code as PanelStringKey]
    : eagerText(code);
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
