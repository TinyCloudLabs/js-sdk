/*
 * Section contract. Seven sections, one module each: src/ui/sections/<id>.ts
 * (the Local copy section's id is "local-copy", its file local-copy.ts), with
 * its strings in <id>.strings.ts. A builder edits only its own pair of files,
 * its tests, and nothing else: not Overview, not the shell, not a shared table.
 *
 * ENTRY SHAPE (PanelSection in ../slots.ts)
 *   id           SectionId. Nav order is the array order below.
 *   labelCode    strings.ts key for the title: nav label, rail text, Overview row label.
 *   icon         IconName from ./ui: the page-rail icon and the At-a-glance icon.
 *   summaryCode  Panel string code for the one-line description on Overview. Omit for no Overview row.
 *   isAvailable(ctx)       Gate (signed in, developer mode...). Unavailable sections have no rail item or row.
 *   status(ctx)  SYNCHRONOUS read of what the section knows from ctx.data. Returns
 *                { text, tone: "ok"|"warn"|"off"|"info", count? } or undefined (show nothing).
 *                The Overview row shows text with a tone dot; the desktop page rail shows count ?? text.
 *                Both read this one function; nothing else derives a status.
 *   mount(el, ctx) Renders the body into el (the "render" hook) and returns dispose. Touch only el.
 *
 * STRINGS. Export a const from <id>.strings.ts and pass it to registerPanelStrings() once, at
 * module load, from the section module. Keys start with the section id (`delegations.revoke.title`)
 * and must not reuse a key from ../strings.ts or another section; tests/ui/section-contract.test.ts
 * fails on a clash. ctx.text(code, params?) looks the code up in the shell table, then the section
 * tables, then strings.ts; unknown codes render the neutral line, never the raw code. Lazy only.
 *
 * ctx (SectionContext in ../slots.ts), all lazy:
 *   ctx.client()               PanelClient: signedIn(), sync, requests, signOut, ...
 *   ctx.data                   Read cache over the client's PanelDataSource (see below)
 *     .source                    the PanelDataSource itself, for reads and writes (undefined: none)
 *     .latest(key)               last ViewResult the shell read, sync; undefined before the first read
 *     .generation()              sync number that changes on every account change (sign-out, account switch, client
 *                                change). CAPTURE ctx.data.generation() BEFORE ANY AWAIT WHOSE RESULT IS KEYED BY ACCOUNT
 *                                (a read, a "Show more" page, a copy, a revoke) AND DISCARD THE RESULT IF IT CHANGED. The cache
 *                                itself already drops its own reads across a change; reads through ctx.data.source are yours.
 *                                On a change the shell also closes ctx.confirm boxes and ctx.openDrawer drawers and clears receipt slips.
 *     .age(key)                  ms since that result settled (freshness)
 *     .refresh(key?)             re-read one view or all
 *     .subscribe(fn)             fires after any cached result changes
 *     Keys: localNode, localCopy, delegations, nodes, storage. The shell reads them all when the panel
 *     opens, on every source change, and each minute while open. A section reads its own body
 *     through ctx.data.source; status(ctx) must use latest() because it cannot wait.
 *   ctx.receipt({ titleCode, bodyCode?, rows: [{ labelCode, value, copyValue? }] }) Receipt slip toast with Copy receipt. `value` is shown; `copyValue` (default: value) is what is copied, e.g. full ID copied, short ID shown. False if toasts are off or it is a duplicate.
 *   ctx.toast({ kind, textCode, href?, hrefLabelCode? }) Plain toast; textCode may be a code the section registered.
 *   ctx.confirm({ question, cancelLabel, confirmLabel, anchor?, onCancel?, onConfirm }) -> { cancel, confirm, close() }
 *                              Inline alertdialog. The safe action takes focus; Escape takes it.
 *   ctx.openDrawer({ title, body, closeLabel, anchor?, onClose? }) -> { el, close() }  Inline details drawer.
 *   ctx.openSection(id)        Navigates to a section.
 *   ctx.requestRender()        Repaints statuses (rail, Overview) after a change the data source did not announce.
 *                              It does not remount the section.
 *   ctx.layout()               "drawer" | "page", read at mount. The shell remounts the section on a change. Phones are always "page".
 *   ctx.sections()             Sections on offer now, nav order.
 *   ctx.closePanel(), ctx.text(), ctx.appLabel(), ctx.developerMode(), ctx.toastsEnabled()
 *
 * UNKNOWN IS NEVER ZERO: a missing size/count/time renders as "unknown" (or is omitted where the mockup omits it); never 0, never "nothing".
 *
 * SHARED COMPONENTS
 *   ./ui:        actionButton, confirmBox, detailsDrawer, glanceRow, statusNode, setGlanceStatus,
 *                icon(name), UI_STYLE (the style for these)
 *   ./status:    viewStatus(ctx, ctx.data.latest(key), ready): the loading / needs-permission / error /
 *                no-source mapping every data-backed status() starts from
 *   ./view-body: textLine, createStateLine, applyResult, settle, startLoading: state line and retry for a data-backed body
 *   ../panel-toasts: receipt slips and toasts (through ctx)
 *   Shell CSS classes (panel-styles.ts): .action .row .label .note .busy .error .switch .knob .icon-btn .sec-title
 */
import type { PanelSection } from "../slots";
import { accountSection } from "./account";
import { activitySection } from "./activity";
import { delegationsSection } from "./delegations";
import { localCopySection } from "./local-copy";
import { localTinycloudSection } from "./local-tinycloud";
import { nodesSection } from "./nodes";
import { storageSection } from "./storage";

/** Static, ordered as the nav lists them. */
export const PANEL_SECTIONS: readonly PanelSection[] = [
  accountSection,
  localTinycloudSection,
  localCopySection,
  delegationsSection,
  nodesSection,
  storageSection,
  activitySection,
];
