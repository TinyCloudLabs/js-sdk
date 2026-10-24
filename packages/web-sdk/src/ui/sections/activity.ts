import type { RequestRow, RequestsView } from "../data";
import type { HostContext, PanelSection, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { ACTIVITY_STRINGS } from "./activity.strings";
import { mountPlaceholder } from "./placeholder";
import { actionButton, icon, UI_STYLE } from "./ui";
import { textLine } from "./view-body";

registerPanelStrings(ACTIVITY_STRINGS);

/** Newest rows drawn at once. The log keeps up to 500; the view never draws more than this. */
const RENDER_CAP = 100;
const NONE = "-";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

/**
 * Table layout from the mockup. The table is a flex column of rows. Below 720px
 * the rows wrap: time, operation, path, result, source and copy on the first
 * line, then space, host, bytes and took. At 720px and up the rows are a
 * ten-column grid with a header row. The breakpoint is measured on the
 * `act-log` container, so the section's own width decides it.
 */
const STYLE = `
.act-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin:12px 0 8px}
.act-count{flex:1 1 100%;margin:0}
.act-btns{display:flex;flex-wrap:wrap;gap:8px}
.act-chk{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:13.5px}
.act-wrap{container:act-log/inline-size;min-width:0}
.act-table{display:flex;flex-direction:column;border-radius:12px;box-shadow:inset 0 0 0 1px #e4e4e7;overflow:hidden;background:#ffffff}
.act-ar{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:0 10px;padding:10px 6px 10px 16px;border-bottom:1px solid #e4e4e7;font-size:13px;font-variant-numeric:tabular-nums}
.act-ar:last-child{border-bottom:0}
.act-ar.act-err{background:linear-gradient(90deg,#111827 0 3px,transparent 3px)}
.act-hd{display:none;background:#f4f4f5}
.act-c-time{order:1;font-family:${MONO};font-size:12.5px;color:#71717a}
.act-c-op{order:2;font-family:${MONO};font-weight:700;font-size:13px;overflow-wrap:anywhere}
.act-c-path{order:3;font-family:${MONO};font-size:13px;min-width:0;overflow-wrap:anywhere}
.act-c-res{order:4;display:inline-flex;align-items:center;gap:6px;font-weight:500}
.act-c-res .ui-ic{width:14px;height:14px}
.act-err .act-c-res{font-weight:700}
.act-err .act-c-res .ui-ic{color:#92400e}
.act-c-source{order:4;font-size:12.5px;color:#71717a}
.act-c-copy{order:5;display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:-9px -2px -9px auto}
.act-br{order:6;flex-basis:100%;height:0}
.act-c-space,.act-c-host,.act-c-bytes,.act-c-took{order:7;font-size:12.5px;color:#71717a}
.act-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.act-empty-row{padding:12px 16px}
@container act-log (min-width:720px){
.act-table{--act-cols:72px 80px 96px 88px minmax(104px,1fr) 70px 64px 150px 60px 44px;overflow-x:auto}
.act-ar{display:grid;grid-template-columns:var(--act-cols);gap:0 8px;padding:0 6px 0 14px;min-height:48px;min-width:920px}
.act-ar>*{order:0!important}
.act-c-copy{margin:0}
.act-br{display:none}
.act-c-bytes,.act-c-took{text-align:right}
.act-hd{display:grid;min-height:40px}
.act-hd>*{font:600 11px ${MONO}!important;letter-spacing:.08em;text-transform:uppercase;color:#71717a}
}
@media (prefers-color-scheme: dark){
.act-table{background:#151517;box-shadow:inset 0 0 0 1px #3f3f46}
.act-ar{border-bottom-color:#3f3f46}
.act-ar.act-err{background:linear-gradient(90deg,#fafafa 0 3px,transparent 3px)}
.act-err .act-c-res .ui-ic{color:#fcd34d}
.act-hd{background:#18181b}
.act-hd>*,.act-c-time,.act-c-source,.act-c-space,.act-c-host,.act-c-bytes,.act-c-took{color:#a1a1aa}
}
`;

/** One JSON object per entry, in RequestRow field order. Copy-one and copy-all both use it. */
export function formatRequestLine(row: RequestRow): string {
  return JSON.stringify(row);
}

/** B, KiB or MiB, as in the mockup. Null is unknown and shows as a dash. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return NONE;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** Local wall-clock HH:MM:SS for the request start. */
export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Writes text to the clipboard. The fallback is a readonly textarea inside the
 * panel root, which works where the async API is denied.
 */
async function copyText(root: HTMLElement, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the textarea copy below.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  root.append(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

let switchId = 0;

/**
 * Request log for developer mode. Shown only while developer mode is on, as in
 * the mockup. Without a request log the body keeps the neutral placeholder.
 */
export const activitySection: PanelSection = {
  id: "activity",
  labelCode: "nav.activity",
  icon: "term",
  summaryCode: "activity.summary",
  isAvailable: (ctx) => ctx.developerMode(),
  // The request log is synchronous, so it is read directly instead of through the cache.
  status(ctx): SectionStatus | undefined {
    const requests = ctx.client()?.data?.requests?.();
    if (requests === undefined) return undefined;
    const errors = requests.rows().filter((row) => !row.ok).length;
    if (errors === 0) {
      return { text: ctx.text("activity.glance.no_errors"), tone: "ok", count: ctx.text("activity.glance.clear") };
    }
    return { text: ctx.text("activity.glance.errors", { count: errors }), tone: "warn" };
  },
  mount(el, ctx: HostContext) {
    const requests = ctx.client()?.data?.requests?.();
    if (!requests) return mountPlaceholder(el);
    return mountActivity(el, ctx, requests);
  },
};

/** One cell of the table. Cells keep the table's column order in the DOM. */
function cell(role: "cell" | "columnheader", className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.setAttribute("role", role);
  span.textContent = text;
  return span;
}

/**
 * Header row, shown only in the grid layout. The Copy column has no visible
 * label: the copy buttons carry their own aria-labels, so the header keeps a
 * visually hidden "Copy" for the 10th column's name.
 */
function headerRow(ctx: HostContext): HTMLElement {
  const row = document.createElement("div");
  row.className = "act-ar act-hd";
  row.setAttribute("role", "row");
  const columns = [
    ["act-c-time", "activity.col.time"],
    ["act-c-op", "activity.col.op"],
    ["act-c-path", "activity.col.path"],
    ["act-c-space", "activity.col.space"],
    ["act-c-host", "activity.col.host"],
    ["act-c-bytes", "activity.col.bytes"],
    ["act-c-took", "activity.col.took"],
    ["act-c-res", "activity.col.result"],
    ["act-c-source", "activity.col.source"],
  ] as const;
  for (const [className, key] of columns) {
    row.append(cell("columnheader", className, ctx.text(key)));
  }
  row.append(cell("columnheader", "act-sr", ctx.text("activity.col.copy")));
  return row;
}

function mountActivity(el: HTMLElement, ctx: HostContext, requests: RequestsView): () => void {
  const style = document.createElement("style");
  style.textContent = STYLE + UI_STYLE;

  const heading = document.createElement("h3");
  heading.className = "sec-title";
  heading.tabIndex = -1;
  heading.textContent = ctx.text("nav.activity");

  const app = ctx.appLabel() ?? ctx.text("activity.app_fallback");
  const devnote = document.createElement("div");
  devnote.className = "note";
  const devnoteTitle = document.createElement("b");
  devnoteTitle.textContent = ctx.text("activity.devnote_title", { app });
  devnote.append(devnoteTitle, ` ${ctx.text("activity.devnote", { app })}`);

  const count = textLine("busy act-count", "");
  const cap = textLine("busy", "");
  cap.hidden = true;

  // Errors-only is a view filter over the log. It does not touch the log itself.
  let errorsOnly = false;
  const switchLabel = document.createElement("span");
  switchLabel.id = `act-eo-${++switchId}`;
  switchLabel.textContent = ctx.text("activity.errors_only");
  const errorsSwitch = document.createElement("button");
  errorsSwitch.type = "button";
  errorsSwitch.className = "switch";
  errorsSwitch.setAttribute("role", "switch");
  errorsSwitch.setAttribute("aria-labelledby", switchLabel.id);
  const knob = document.createElement("span");
  knob.className = "knob";
  errorsSwitch.append(knob);
  const chk = document.createElement("label");
  chk.className = "act-chk";
  chk.append(switchLabel, errorsSwitch);

  // Pause freezes the table on the snapshot taken at the click. Resume returns to the live log.
  let frozen: readonly RequestRow[] | undefined;
  const pauseButton = actionButton(ctx.text("activity.pause"));
  pauseButton.setAttribute("aria-pressed", "false");
  const copyAllButton = actionButton(ctx.text("activity.copy_all"));
  copyAllButton.prepend(icon("copy"));
  const btns = document.createElement("div");
  btns.className = "act-btns";
  btns.append(pauseButton, copyAllButton);
  const tools = document.createElement("div");
  tools.className = "act-tools";
  tools.append(count, chk, btns, cap);

  const table = document.createElement("div");
  table.className = "act-table";
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", ctx.text("activity.table_label"));
  const header = headerRow(ctx);
  const wrap = document.createElement("div");
  wrap.className = "act-wrap";
  wrap.append(table);

  const emptyCell = cell("cell", "busy", "");
  const emptyRow = document.createElement("div");
  emptyRow.className = "act-empty-row";
  emptyRow.setAttribute("role", "row");
  emptyRow.append(emptyCell);

  let disposed = false;
  let frame: number | undefined;

  function errorText(n: number): string {
    return n === 1 ? ctx.text("activity.errors_one") : ctx.text("activity.errors_many", { count: n });
  }

  function rowEl(row: RequestRow): HTMLElement {
    const item = document.createElement("div");
    item.className = row.ok ? "act-ar" : "act-ar act-err";
    item.setAttribute("role", "row");

    const result = document.createElement("span");
    result.className = "act-c-res";
    result.setAttribute("role", "cell");
    if (!row.ok) result.append(icon("warn"));
    result.append(row.ok ? ctx.text("activity.ok") : `${ctx.text("activity.failed")} · ${row.code}`);

    // The wrapper carries the cell role and the table layout. The button stays the control.
    const copyCell = document.createElement("span");
    copyCell.className = "act-c-copy";
    copyCell.setAttribute("role", "cell");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-btn";
    const target = row.path === null ? row.op : `${row.op} ${row.path}`;
    copy.setAttribute("aria-label", ctx.text("activity.copy_one", { target, time: formatTime(row.at) }));
    copy.append(icon("copy"));
    copyCell.append(copy);
    copy.addEventListener("click", () => void copyRows([row]));

    const br = document.createElement("span");
    br.className = "act-br";
    br.setAttribute("aria-hidden", "true");

    // DOM order is the table's column order. The phone wrap is done with CSS `order`.
    item.append(
      cell("cell", "act-c-time", formatTime(row.at)),
      cell("cell", "act-c-op", row.op),
      cell("cell", "act-c-path", row.path ?? NONE),
      cell("cell", "act-c-space", row.space ?? NONE),
      cell("cell", "act-c-host", row.host ?? NONE),
      cell("cell", "act-c-bytes", formatBytes(row.bytes)),
      cell("cell", "act-c-took", row.durationMs === null ? NONE : `${row.durationMs} ms`),
      result,
      cell("cell", "act-c-source", row.source),
      copyCell,
      br,
    );
    return item;
  }

  function currentRows(): readonly RequestRow[] {
    return frozen ?? requests.rows();
  }

  function render(): void {
    const log = currentRows();
    const newestFirst = [...log].reverse();
    const errors = newestFirst.filter((row) => !row.ok);
    const visible = errorsOnly ? errors : newestFirst;
    const shown = visible.slice(0, RENDER_CAP);

    count.textContent = ctx.text("activity.count", {
      shown: visible.length,
      total: log.length,
      errors: errorText(errors.length),
    });
    cap.hidden = shown.length === visible.length;
    cap.textContent = ctx.text("activity.cap", { shown: shown.length });

    emptyCell.textContent =
      errorsOnly && log.length > 0 ? ctx.text("activity.no_errors_table") : ctx.text("activity.empty");
    table.replaceChildren(header, ...(shown.length > 0 ? shown.map((row) => rowEl(row)) : [emptyRow]));

    errorsSwitch.setAttribute("aria-checked", String(errorsOnly));
    const paused = frozen !== undefined;
    pauseButton.textContent = paused ? ctx.text("activity.resume") : ctx.text("activity.pause");
    pauseButton.setAttribute("aria-pressed", String(paused));
    copyAllButton.disabled = requests.rows().length === 0;
  }

  // Live updates batch per animation frame, so a burst of requests paints once.
  function schedule(): void {
    if (disposed || frame !== undefined || frozen !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!disposed) render();
    });
  }

  async function copyRows(rows: readonly RequestRow[]): Promise<void> {
    const ok = await copyText(el, rows.map(formatRequestLine).join("\n"));
    ctx.toast(ok ? { kind: "success", textCode: "toast.copied" } : { kind: "error", textCode: "toast.copy_failed" });
  }

  errorsSwitch.addEventListener("click", () => {
    errorsOnly = !errorsOnly;
    render();
  });
  pauseButton.addEventListener("click", () => {
    frozen = frozen === undefined ? requests.rows() : undefined;
    render();
  });
  copyAllButton.addEventListener("click", () => void copyRows(requests.rows()));

  // subscribe fires on each new row and on clear, so one callback covers both.
  const unsubscribe = requests.subscribe(() => schedule());

  el.append(style, heading, devnote, textLine("note", ctx.text("activity.note")), tools, wrap);
  render();

  return () => {
    disposed = true;
    unsubscribe();
    if (frame !== undefined) cancelAnimationFrame(frame);
    el.replaceChildren();
  };
}
