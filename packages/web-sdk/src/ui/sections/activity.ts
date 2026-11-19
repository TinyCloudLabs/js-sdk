import type { NodeRow } from "../data";
import type { HostContext, PanelSection, RequestLogReader, SectionContext, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { ACTIVITY_STRINGS } from "./activity.strings";
import { mountPlaceholder } from "./placeholder";
import { actionButton, icon, UI_STYLE } from "./ui";

registerPanelStrings(ACTIVITY_STRINGS);

/** Newest rows drawn at once. The log keeps more; the table never draws more than this. */
const RENDER_CAP = 100;
/** Shown for a field the log does not have. The mockup uses an em dash. */
const NONE = "\u2014";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

/**
 * Layout from the mockup, measured on the section's own width (`act-root`), not the viewport.
 * Below 720px each request wraps to two lines: time, operation, path, result, source and copy,
 * then space, host, bytes and took. From 720px it is a ten-column grid with a header row.
 *
 * Deviation from the mockup: its columns are fixed (72 80 96 88 1fr 70 64 150 60 44, 920px with the
 * 104px host column), which does not fit the 880px page body: the grid is clipped and Copy is out of
 * view. Here the nine data columns share the row by weight (the mockup's order of size, with room
 * for `service/action` operation names and a host name on one line), none below the smallest size
 * that fits its text. The smallest sizes add up to 580px, which fits the 700px of row space at the
 * 720px breakpoint; at 880px every column is wide enough for the sample data.
 */
const STYLE = `
.act-root{container:act/inline-size;min-width:0}
.act-head{display:flex;flex-direction:column;gap:8px;margin:0 0 36px}
.act-head-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px}
.act-head .sec-title{margin:0}
.act-chip{display:inline-flex;align-items:center;height:28px;padding:0 11px;border-radius:999px;box-shadow:inset 0 0 0 1px #e4e4e7;font-size:12.5px;font-weight:600;white-space:nowrap}
.act-lede{margin:0;max-width:56ch;font-size:15px;line-height:1.5}
.act-devnote{display:flex;gap:12px;align-items:flex-start;box-sizing:border-box;margin:0 0 36px;padding:14px 16px;border-radius:12px;box-shadow:inset 0 0 0 1px #e4e4e7;font-size:13.5px;line-height:1.5}
.act-devnote .ui-ic{margin-top:2px}
.act-devnote p{margin:0}
.act-tools{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:0 0 36px}
.act-count{margin:0;font-size:14px;line-height:1.45}
.act-count b{font-weight:700}
.act-chk{display:inline-flex;align-items:center;gap:10px;min-height:44px;font-size:14px;font-weight:600}
.act-btns{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.act-cap{margin:0 0 10px;font-size:12.5px;color:#71717a}
.act-table{display:flex;flex-direction:column;border-radius:16px;box-shadow:inset 0 0 0 1px #e4e4e7;overflow:hidden;background:#ffffff}
.act-ar{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:0 8px;padding:10px 4px 10px 12px;border-bottom:1px solid #e4e4e7;font-size:13px;font-variant-numeric:tabular-nums}
.act-ar:last-child{border-bottom:0}
.act-ar>*{min-width:0}
.act-err{background:linear-gradient(90deg,#09090b 0 3px,transparent 3px)}
.act-hd{display:none;background:#fafafa}
.act-c-time{order:1;font-family:${MONO};font-size:12.5px;color:#71717a}
.act-c-op{order:2;font-family:${MONO};font-weight:700;font-size:13px;overflow-wrap:anywhere}
.act-c-path{order:3;font-family:${MONO};font-size:13px;overflow-wrap:anywhere}
.act-c-res{order:4;display:inline-flex;align-items:center;gap:6px;font-weight:500;overflow-wrap:anywhere}
.act-err .act-c-res{font-weight:700}
.act-c-res .ui-ic{width:14px;height:14px}
.act-err .act-c-res .ui-ic{color:#8a3f05}
.act-c-source{order:4;font-size:12.5px;color:#71717a}
.act-c-copy{order:5;display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:-9px -2px -9px auto}
.act-br{order:6;flex-basis:100%;height:0}
.act-c-space,.act-c-host,.act-c-bytes,.act-c-took{order:7;font-size:12.5px;color:#71717a;overflow-wrap:anywhere}
.act-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.act-empty{padding:14px 16px;font-size:13.5px;color:#71717a}
.act-facts{display:grid;gap:0 32px;grid-template-columns:minmax(0,1fr);margin:28px 0 0;padding:0}
.act-facts>div{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:44px;padding:9px 0;border-bottom:1px solid #e4e4e7}
.act-facts dt{display:flex;flex:1 1 auto;align-items:baseline;gap:10px;min-width:0;font-size:14px;white-space:nowrap}
.act-facts dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted #a1a1aa;transform:translateY(-3px)}
.act-facts dd{margin:0;max-width:78%;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.act-facts .act-mono{font:600 .8125rem ${MONO}}
@container act (min-width:720px){
.act-tools{flex-direction:row;align-items:center;gap:20px}
.act-count{margin-right:auto}
.act-table{--act-cols:minmax(62px,70fr) minmax(64px,110fr) minmax(64px,100fr) minmax(64px,80fr) minmax(70px,150fr) minmax(58px,62fr) minmax(58px,64fr) minmax(84px,110fr) minmax(56px,56fr) 44px}
.act-ar{display:grid;grid-template-columns:var(--act-cols);gap:0 8px;padding:0 6px 0 14px;min-height:48px}
.act-ar>*{order:0!important}
.act-c-copy{margin:0}
.act-br{display:none}
.act-c-bytes,.act-c-took{text-align:right}
.act-hd{display:grid;min-height:40px}
.act-hd>*{font:600 11px ${MONO}!important;letter-spacing:.08em;text-transform:uppercase;color:#71717a}
.act-facts{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
}
@media (prefers-reduced-motion:no-preference){
.act-new{animation:act-in .5s cubic-bezier(.22,1,.36,1)}
@keyframes act-in{from{opacity:0;transform:translateY(-8px);background-color:#f4f4f5}}
}
@media (prefers-color-scheme: dark){
.act-chip,.act-devnote{box-shadow:inset 0 0 0 1px #69696b}
.act-cap,.act-empty,.act-c-time,.act-c-source,.act-c-space,.act-c-host,.act-c-bytes,.act-c-took{color:#a1a1aa}
.act-table{background:#151517;box-shadow:inset 0 0 0 1px #69696b}
.act-ar,.act-facts>div{border-bottom-color:#69696b}
.act-err{background:linear-gradient(90deg,#fafafa 0 3px,transparent 3px)}
.act-err .act-c-res .ui-ic{color:#fbbd23}
.act-hd{background:#151517}
.act-hd>*{color:#a1a1aa}
.act-facts dt::after{border-bottom-color:#71717a}
@media (prefers-reduced-motion:no-preference){
@keyframes act-in{from{opacity:0;transform:translateY(-8px);background-color:#27272a}}
}
}
`;

/**
 * One log entry, reduced to the fields the table shows. Everything else on the entry is dropped.
 * A field the log does not give is `undefined`, and the table shows it as a dash or "unknown",
 * never as a zero, a success or a default source.
 */
interface Entry {
  readonly key: string;
  readonly at: number | undefined;
  readonly op: string;
  readonly path: string | undefined;
  readonly space: string | undefined;
  readonly host: string | undefined;
  readonly bytes: number | undefined;
  readonly durationMs: number | undefined;
  readonly ok: boolean | undefined;
  readonly code: string | undefined;
  readonly source: "network" | "replica" | undefined;
}

// Control, format (bidi, zero width) and line separator characters. A value with one could forge a line in Copy all.
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSAFE, " ").trim();
  return text === "" ? undefined : text.slice(0, max);
}

/** A count the log gave: a finite number, not negative. Anything else is unknown. */
function size(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The log's entries are opaque to the panel. Only the fields below are read, so a field the log adds
 * later is never drawn or copied. An entry is kept even when fields are missing; one without a usable
 * id gets a key from its own fields (see `readLog`).
 */
function readEntry(value: unknown): Entry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Readonly<Record<string, unknown>>;
  const id = typeof raw.id === "number" && Number.isFinite(raw.id) ? String(raw.id) : clean(raw.id, 64);
  const code = clean(raw.code, 64);
  const entry = {
    key: "",
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : undefined,
    op: clean(raw.op, 64) ?? NONE,
    path: clean(raw.path, 256),
    space: clean(raw.space, 64),
    host: clean(raw.host, 128),
    bytes: size(raw.bytes),
    durationMs: size(raw.durationMs),
    ok: typeof raw.ok === "boolean" ? raw.ok : undefined,
    code: code !== undefined && CODE.test(code) ? code : undefined,
    source: raw.source === "replica" || raw.source === "network" ? raw.source : undefined,
  } satisfies Entry;
  const own = [entry.at, entry.op, entry.path, entry.space, entry.host, entry.bytes, entry.durationMs, entry.ok, entry.code, entry.source];
  return { ...entry, key: id ?? `~${own.join("|")}` };
}

/**
 * The log's entries, oldest first, or undefined when the snapshot cannot be read: an unreadable log is
 * not an empty one. Entries that share a key (no id, same fields) are told apart by their order.
 */
function readLog(reader: RequestLogReader | undefined): Entry[] | undefined {
  if (reader === undefined) return undefined;
  let snapshot: readonly unknown[];
  try {
    snapshot = reader.snapshot();
  } catch {
    return undefined;
  }
  if (!Array.isArray(snapshot)) return undefined;
  const entries: Entry[] = [];
  const seen = new Map<string, number>();
  for (const value of snapshot) {
    const entry = readEntry(value);
    if (entry === undefined) continue;
    const n = seen.get(entry.key) ?? 0;
    seen.set(entry.key, n + 1);
    entries.push(n === 0 || !entry.key.startsWith("~") ? entry : { ...entry, key: `${entry.key}#${n}` });
  }
  return entries;
}

/** B, KiB or MiB, as in the mockup. */
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** Local wall-clock HH:MM:SS for the request start. */
function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type Text = HostContext["text"];

/** The nine text cells in column order. The table draws them and Copy joins them, so the two cannot differ. */
function cellsOf(text: Text, entry: Entry): readonly string[] {
  let result = text("activity.res_unknown");
  if (entry.ok === true) result = text("activity.res_ok");
  else if (entry.ok === false) result = entry.code ?? text("activity.res_unknown");
  let source = NONE;
  if (entry.source === "replica" || entry.source === "network") source = entry.source;
  return [
    entry.at === undefined ? NONE : formatTime(entry.at),
    entry.op,
    entry.path ?? NONE,
    entry.space ?? NONE,
    entry.host ?? (entry.source === "replica" ? text("activity.host_local") : NONE),
    entry.bytes === undefined ? NONE : formatBytes(entry.bytes),
    entry.durationMs === undefined ? NONE : `${entry.durationMs} ms`,
    result,
    source,
  ];
}

/**
 * Writes text to the clipboard. Where the async API is missing or denied, a readonly textarea
 * inside the panel root and a copy command stand in for it.
 */
async function copyText(root: HTMLElement, value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Fall through to the textarea copy below.
  }
  const area = document.createElement("textarea");
  area.value = value;
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

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

let switchId = 0;

/**
 * Request log for developer mode. Shown only while developer mode is on, as in the mockup.
 * Without a request log on the client the body keeps the neutral placeholder.
 */
export const activitySection: PanelSection = {
  id: "activity",
  labelCode: "nav.activity",
  icon: "term",
  summaryCode: "activity.summary",
  isAvailable: (ctx) => ctx.developerMode(),
  // The log is synchronous, so it is read directly instead of through the data cache.
  status(ctx): SectionStatus | undefined {
    const reader = ctx.client()?.requests;
    if (reader === undefined) return undefined;
    const log = readLog(reader);
    // An unreadable log has no status: "Clear" would say there are no errors when nobody knows.
    if (log === undefined) return undefined;
    const errors = log.filter((entry) => entry.ok === false).length;
    if (errors > 0) return { text: ctx.text("activity.glance.errors", { count: errors }), tone: "warn" };
    // Entries with no recorded outcome could be failures, so with no failure seen the status stays unknown too.
    if (log.some((entry) => entry.ok === undefined)) return undefined;
    return { text: ctx.text("activity.glance.no_errors"), tone: "ok", count: ctx.text("activity.glance.clear") };
  },
  mount(el, ctx) {
    const reader = ctx.client()?.requests;
    if (!reader) return mountPlaceholder(el);
    return mountActivity(el, ctx, reader);
  },
};

function span(className: string, role: "cell" | "columnheader", content: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.setAttribute("role", role);
  node.textContent = content;
  return node;
}

const COLUMNS = [
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

/** Header row, drawn only in the grid layout. The Copy column has no visible label. */
function headerRow(text: Text): HTMLElement {
  const row = document.createElement("div");
  row.className = "act-ar act-hd";
  row.setAttribute("role", "row");
  for (const [className, code] of COLUMNS) row.append(span(className, "columnheader", text(code)));
  row.append(span("act-sr", "columnheader", text("activity.col.copy")));
  return row;
}

function mountActivity(el: HTMLElement, ctx: SectionContext, initial: RequestLogReader): () => void {
  const text = ctx.text;
  const root = document.createElement("div");
  root.className = "act-root";
  const style = document.createElement("style");
  style.textContent = STYLE + UI_STYLE;

  // Heading, chip and lede.
  const head = document.createElement("div");
  head.className = "act-head";
  const headRow = document.createElement("div");
  headRow.className = "act-head-row";
  const heading = document.createElement("h3");
  heading.className = "sec-title";
  heading.tabIndex = -1;
  heading.textContent = text("nav.activity");
  const chip = document.createElement("span");
  chip.className = "act-chip";
  chip.textContent = text("activity.chip");
  headRow.append(heading, chip);
  const lede = document.createElement("p");
  lede.className = "act-lede";
  lede.textContent = text("activity.lede");
  head.append(headRow, lede);

  // Developer-mode note.
  const app = ctx.appLabel() ?? text("activity.app_fallback");
  const devnote = document.createElement("div");
  devnote.className = "act-devnote";
  const devnoteText = document.createElement("p");
  const devnoteTitle = document.createElement("b");
  devnoteTitle.textContent = text("activity.devnote_title", { app });
  devnoteText.append(devnoteTitle, ` ${text("activity.devnote", { app })}`);
  devnote.append(icon("info"), devnoteText);

  // Toolbar: count, errors-only switch, pause and copy all.
  const count = document.createElement("p");
  count.className = "act-count";
  const shownNode = document.createElement("b");
  const totalNode = document.createTextNode("");
  const errorsNode = document.createElement("b");
  const errorsWord = document.createTextNode("");
  count.append(shownNode, totalNode, errorsNode, errorsWord);

  const switchLabel = document.createElement("span");
  switchLabel.id = `act-eo-${++switchId}`;
  switchLabel.textContent = text("activity.errors_only");
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

  const pauseButton = actionButton(text("activity.pause"));
  const copyAllButton = actionButton(text("activity.copy_all"));
  copyAllButton.prepend(icon("copy"));
  const btns = document.createElement("div");
  btns.className = "act-btns";
  btns.append(pauseButton, copyAllButton);

  const tools = document.createElement("div");
  tools.className = "act-tools";
  tools.append(count, chk, btns);

  const cap = document.createElement("p");
  cap.className = "act-cap";
  cap.hidden = true;

  // Table.
  const table = document.createElement("div");
  table.className = "act-table";
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", text("activity.table_label"));
  const header = headerRow(text);
  const emptyRow = document.createElement("div");
  emptyRow.className = "act-empty";
  emptyRow.setAttribute("role", "row");
  const emptyCell = document.createElement("span");
  emptyCell.setAttribute("role", "cell");
  emptyRow.append(emptyCell);

  // Facts under the table: the node in use and whether the local copy is on.
  const facts = document.createElement("dl");
  facts.className = "act-facts";
  const nodeRow = document.createElement("div");
  const nodeLabel = document.createElement("dt");
  nodeLabel.textContent = text("activity.node");
  const nodeValue = document.createElement("dd");
  nodeValue.className = "act-mono";
  nodeRow.append(nodeLabel, nodeValue);
  const copyRow = document.createElement("div");
  const copyLabel = document.createElement("dt");
  copyLabel.textContent = text("activity.local_copy");
  const copyValue = document.createElement("dd");
  copyRow.append(copyLabel, copyValue);
  facts.append(nodeRow, copyRow);

  root.append(style, head, devnote, tools, cap, table, facts);
  el.append(root);

  // View state. Errors-only filters the view; Pause holds the rows taken at the click.
  let errorsOnly = false;
  let frozen: readonly Entry[] | undefined;
  let reader: RequestLogReader | undefined = initial;
  let disposed = false;
  let frame: number | undefined;
  let primed = false;
  let known = new Set<string>();
  // Row elements by log id. A row keeps its element across renders, so a focused Copy button stays focused while rows arrive.
  const elements = new Map<string, HTMLElement>();
  let shown: Entry[] = [];

  function rowEl(entry: Entry): HTMLElement {
    const cells = cellsOf(text, entry);
    const item = document.createElement("div");
    item.className = entry.ok === false ? "act-ar act-err" : "act-ar";
    item.setAttribute("role", "row");
    COLUMNS.forEach(([className], index) => {
      const content = cells[index] ?? NONE;
      if (className !== "act-c-res") {
        item.append(span(className, "cell", content));
        return;
      }
      const result = span(className, "cell", "");
      if (entry.ok === false) result.append(icon("warn"));
      result.append(content);
      item.append(result);
    });

    // The wrapper carries the cell role and the grid column. The button stays the control.
    const copyCell = document.createElement("span");
    copyCell.className = "act-c-copy";
    copyCell.setAttribute("role", "cell");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-btn";
    const target = entry.path === undefined ? entry.op : `${entry.op} ${entry.path}`;
    const time = entry.at === undefined ? NONE : formatTime(entry.at);
    copy.setAttribute("aria-label", text("activity.copy_one", { target, time }));
    copy.append(icon("copy"));
    copy.addEventListener("click", () => void copyEntries([entry], "activity.copied_one"));
    copyCell.append(copy);

    const br = document.createElement("span");
    br.className = "act-br";
    br.setAttribute("aria-hidden", "true");
    // DOM order is the grid's column order. The phone wrap is done with CSS `order`.
    item.append(copyCell, br);
    return item;
  }

  function nodeFact(): string | undefined {
    const view = ctx.data.latest("nodes");
    if (view?.state !== "ready") return undefined;
    const rows: readonly NodeRow[] = view.data;
    const node = rows.find((row) => row.active) ?? rows[0];
    if (node === undefined) return undefined;
    const host = hostOf(node.origin);
    if (node.version === undefined) return host;
    return `${host} \u00b7 ${/^v/i.test(node.version) ? node.version : `v${node.version}`}`;
  }

  function renderFacts(): void {
    const node = nodeFact();
    nodeRow.hidden = node === undefined;
    if (node !== undefined) nodeValue.textContent = node;
    const sync = ctx.client()?.sync;
    copyRow.hidden = sync === undefined;
    if (sync !== undefined) {
      const on = sync.state.effective === "on" || sync.state.effective === "pending";
      copyValue.textContent = text(on ? "activity.on" : "activity.off");
    }
    facts.hidden = nodeRow.hidden && copyRow.hidden;
  }

  function render(): void {
    const read = frozen ?? readLog(reader);
    // An unreadable log is not an empty one: the table says so and the counts are not drawn.
    const log = read ?? [];
    const newest = [...log].reverse();
    const errorCount = log.filter((entry) => entry.ok === false).length;
    const visible = errorsOnly ? newest.filter((entry) => entry.ok === false) : newest;
    const seenKeys = new Set<string>();
    shown = [];
    for (const entry of visible) {
      if (shown.length === RENDER_CAP) break;
      if (seenKeys.has(entry.key)) continue;
      seenKeys.add(entry.key);
      shown.push(entry);
    }

    count.hidden = read === undefined;
    shownNode.textContent = String(shown.length);
    totalNode.data = text("activity.count_of", { total: log.length });
    // With an outcome unknown and no failure seen, "0 errors" would claim more than the log says.
    const unsure = errorCount === 0 && log.some((entry) => entry.ok === undefined);
    errorsNode.textContent = unsure ? NONE : String(errorCount);
    errorsWord.data = text(errorCount === 1 ? "activity.count_error_one" : "activity.count_error_many");
    cap.hidden = visible.length <= shown.length;
    cap.textContent = text("activity.cap", { shown: shown.length });

    // Rows are keyed by id. Existing elements stay where they are; only arrivals and removals touch the DOM.
    const wanted: HTMLElement[] = [header];
    for (const entry of shown) {
      let item = elements.get(entry.key);
      if (item === undefined) {
        item = rowEl(entry);
        if (primed && !known.has(entry.key)) item.classList.add("act-new");
        elements.set(entry.key, item);
      }
      wanted.push(item);
    }
    if (shown.length === 0) {
      if (read === undefined) emptyCell.textContent = text("activity.unavailable");
      else if (log.length === 0) emptyCell.textContent = text("activity.empty");
      else emptyCell.textContent = text(unsure ? "activity.no_errors_unsure" : "activity.no_errors_table");
      wanted.push(emptyRow);
    }
    const keep = new Set(wanted);
    for (const [key, item] of elements) if (!keep.has(item)) elements.delete(key);
    wanted.forEach((item, index) => {
      const current = table.children[index];
      if (current !== item) table.insertBefore(item, current ?? null);
    });
    while (table.children.length > wanted.length) table.lastElementChild?.remove();

    if (read !== undefined) known = new Set(log.map((entry) => entry.key));
    primed = true;

    errorsSwitch.setAttribute("aria-checked", String(errorsOnly));
    pauseButton.textContent = text(frozen === undefined ? "activity.pause" : "activity.resume");
    copyAllButton.disabled = shown.length === 0;
    renderFacts();
  }

  // Live updates batch per animation frame, so a burst of requests paints once.
  function schedule(): void {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (disposed) return;
      // Pause holds the table; the rail and Overview statuses still follow the log.
      if (frozen === undefined) render();
      ctx.requestRender();
    });
  }

  async function copyEntries(entries: readonly Entry[], doneCode: string): Promise<void> {
    if (entries.length === 0) return;
    // The mockup's plain text: one line per request, its nine cells two spaces apart.
    const ok = await copyText(el, entries.map((entry) => cellsOf(text, entry).join("  ")).join("\n"));
    if (disposed) return;
    ctx.toast(ok ? { kind: "success", textCode: doneCode } : { kind: "error", textCode: "activity.copy_failed" });
  }

  errorsSwitch.addEventListener("click", () => {
    errorsOnly = !errorsOnly;
    render();
  });
  pauseButton.addEventListener("click", () => {
    frozen = frozen === undefined ? readLog(reader) : undefined;
    render();
  });
  // Copy all copies the rows on screen: the filter, the pause and the cap all apply.
  copyAllButton.addEventListener("click", () => void copyEntries(shown, "activity.copied_many"));

  // Everything below is keyed by the client: its log, the rows held by Pause, the rows drawn, and the
  // listeners on both. A reset (sign-out, account switch) or a replaced client starts a new epoch; a callback
  // from an earlier epoch does nothing, even from a log whose unsubscribe did not take effect.
  let epoch = 0;
  let offClient: Array<() => void> = [];
  function bind(): void {
    for (const off of offClient) off();
    epoch += 1;
    const mine = epoch;
    const client = ctx.client();
    reader = client?.requests;
    frozen = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    elements.clear();
    known = new Set();
    primed = false;
    offClient = [];
    if (reader !== undefined) {
      offClient.push(
        reader.subscribe(() => {
          if (mine === epoch) schedule();
        }),
        // A clear empties the table at once and drops any rows held by Pause.
        reader.onClear(() => {
          if (mine !== epoch || disposed) return;
          frozen = undefined;
          if (frame !== undefined) cancelAnimationFrame(frame);
          frame = undefined;
          render();
          ctx.requestRender();
        }),
      );
    }
    const offReset = client?.onReset(rebind);
    if (offReset !== undefined) offClient.push(offReset);
    const offSync = client?.sync?.subscribe(() => {
      if (mine === epoch && !disposed) renderFacts();
    });
    if (offSync !== undefined) offClient.push(offSync);
  }
  function rebind(): void {
    if (disposed) return;
    bind();
    render();
    ctx.requestRender();
  }
  bind();
  const offChange = ctx.onClientChange(rebind);
  const offData = ctx.data.subscribe(() => {
    if (!disposed) renderFacts();
  });

  render();

  return () => {
    disposed = true;
    epoch += 1;
    for (const off of offClient) off();
    offChange();
    offData();
    if (frame !== undefined) cancelAnimationFrame(frame);
    elements.clear();
    el.replaceChildren();
  };
}
