import { text as eagerText } from "./strings";

/**
 * Shell copy: the layout switch, toasts, and the three words every status can
 * show. Lazy: only the panel chunk imports this, so the launcher bundle never
 * carries these keys. Launcher and legacy section keys stay in strings.ts.
 * Each section owns its own strings in `sections/<id>.strings.ts` and
 * registers them here with `registerPanelStrings`.
 */
const PANEL_STRINGS = {
  "panel.full_page": "Open full page",
  "panel.sidebar": "Show as sidebar",
  "toast.dismiss": "Dismiss",
  "toast.copy_receipt": "Copy receipt",
  "toast.copied": "Copied",
  "toast.copy_failed": "Couldn't copy. Select the text and copy it by hand.",
  "section.status.checking": "Checking",
  "section.status.needs_permission": "Needs permission",
  "section.status.unavailable": "Unavailable",
} as const satisfies Readonly<Record<string, string>>;

export type PanelStringKey = keyof typeof PANEL_STRINGS;

const SECTION_STRINGS = new Map<string, string>();

/**
 * The one merge point for section copy. A section calls it once, at module
 * load, with its own table. Keys start with the section id and must not reuse
 * a key from strings.ts or another section (tests/ui/section-contract.test.ts checks).
 */
export function registerPanelStrings(table: Readonly<Record<string, string>>): void {
  for (const [code, line] of Object.entries(table)) SECTION_STRINGS.set(code, line);
}

/** Panel lookup: shell table, then section tables, then the launcher table, then the neutral line. */
export function panelText(code: string, params: Readonly<Record<string, string | number>> = {}): string {
  const raw: string = Object.prototype.hasOwnProperty.call(PANEL_STRINGS, code)
    ? PANEL_STRINGS[code as PanelStringKey]
    : (SECTION_STRINGS.get(code) ?? eagerText(code));
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
