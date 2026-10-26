import type { StorageUsageState } from "@tinycloud/sdk-core";
import type { StorageView } from "../data";
import { STORAGE_MANAGE_URL } from "../manage-url";
import type { PanelSection, SectionContext, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { STORAGE_PANEL_STRINGS } from "./storage.strings";
import { viewStatus } from "./status";
import { icon } from "./ui";
import { applyResult, createStateLine } from "./view-body";
import { isStorageStatus, isUnavailableCode, manageHrefFor } from "../storage-state";
import { viewLoading } from "../view-result";

registerPanelStrings(STORAGE_PANEL_STRINGS);

const SERIF = '"Literata Variable","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';

/**
 * Sizes, rules and colours follow the settings mockup. Track edge is the brand control edge, 4.83:1 on white.
 * State-only rules (banner, nearly-full note, per-space rows, permission card) are appended when
 * that state first renders, so the panel stylesheet only carries rules for what is on screen.
 */
const BASE_CSS = `
.ui-ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.storage-lede{margin:-14px 0 28px;max-width:56ch;font-size:15px;line-height:1.5}
.storage-cols{display:grid;gap:28px 36px;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));align-items:start}
.storage-h{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:13px;font-weight:600;line-height:1.3;letter-spacing:.02em}
.storage-h::after{content:"";flex:1;height:1px;background:#e4e4e7}
.storage-hd{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:12px}
.storage-fig{font-size:2.75rem;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.storage-fig small{margin-left:2px;white-space:pre-wrap;font-size:1rem;font-weight:500;letter-spacing:0;color:#71717a}
.storage-st{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;white-space:nowrap;color:#18181b}
.storage-dot{position:relative;flex:none;width:9px;height:9px;border-radius:50%;background:currentColor}
.storage-st[data-tone="warn"]{color:#92400e}
.storage-st[data-tone="warn"] .storage-dot{background:#b45309;box-shadow:0 0 0 1.5px #fff,0 0 0 2.5px #b45309}
.storage-meter{height:6px;border-radius:999px;background:#f4f4f5;box-shadow:inset 0 0 0 1px #71717a;overflow:hidden}
.storage-fill{display:block;height:100%;border-radius:999px;background:#09090b;transition:width .6s ease}
.storage-kv{display:flex;flex-direction:column;margin:14px 0 0;padding:0}
.storage-kv>div{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:44px;padding:9px 0;border-bottom:1px solid #e4e4e7}
.storage-kv>div:last-child{border-bottom:0}
.storage-kv dt{display:flex;flex:1 1 auto;align-items:baseline;gap:10px;min-width:0;margin:0;font-size:14px;white-space:nowrap}
.storage-kv dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted #a1a1aa;transform:translateY(-3px)}
.storage-kv dd{flex:0 1 auto;max-width:78%;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.storage-link{margin-top:6px}
a.storage-manage{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-height:44px;padding:0 4px;color:inherit;font-size:13px;font-weight:600;text-decoration:underline;text-underline-offset:3px}
a.storage-manage:focus-visible{outline:2px solid #111827;outline-offset:2px}
a.storage-manage .ui-ic{width:14px;height:14px}
.storage-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.storage-updated{margin:18px 0 0;font-size:12.5px;line-height:1.4;color:#71717a}
@media (prefers-reduced-motion:reduce){.storage-fill{transition:none}}
@media (prefers-color-scheme: dark){
.storage-kv>div{border-bottom-color:#3f3f46}
.storage-h::after{background:#3f3f46}
.storage-fig small,.storage-updated{color:#a1a1aa}
.storage-st{color:#fafafa}
.storage-st[data-tone="warn"]{color:#fcd34d}
.storage-st[data-tone="warn"] .storage-dot{background:#f59e0b;box-shadow:0 0 0 1.5px #151517,0 0 0 2.5px #f59e0b}
.storage-meter{background:#27272a}
.storage-fill{background:#fafafa}
.storage-kv dt::after{border-bottom-color:#71717a}
a.storage-manage:focus-visible{outline-color:#fafafa}
}
`;

const BANNER_CSS = `
.storage-banner{display:flex;gap:12px;align-items:flex-start;box-sizing:border-box;margin:0 0 28px;padding:14px 16px;border-radius:12px;box-shadow:inset 0 0 0 1px #e4e4e7;font-size:14px;line-height:1.45}
.storage-banner .ui-ic{width:22px;height:22px;margin-top:1px;color:#b35309}
.storage-banner strong{display:block}
.storage-banner a.storage-manage{padding-left:0}
@media (prefers-color-scheme: dark){
.storage-banner{box-shadow:inset 0 0 0 1px #69696b}
.storage-banner .ui-ic{color:#f59e0b}
}
`;

const NEAR_CSS = `
.storage-near{display:flex;gap:6px;align-items:flex-start;margin:6px 0 0;font-size:12.5px;line-height:1.4}
.storage-near .ui-ic{width:16px;height:16px;margin-top:1px;color:#b35309}
@media (prefers-color-scheme: dark){.storage-near .ui-ic{color:#f59e0b}}
`;

const SPACES_CSS = `
.storage-h .cnt{font-weight:500;color:#71717a}
.storage-spaces{margin:0;padding:0;list-style:none}
.storage-space{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid #e4e4e7}
.storage-space:last-child{border-bottom:0}
.storage-space .l{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14px}
.storage-space .l b{font-weight:600;overflow-wrap:anywhere}
.storage-space .l span{font-variant-numeric:tabular-nums}
@media (prefers-color-scheme: dark){
.storage-h .cnt{color:#a1a1aa}
.storage-space{border-bottom-color:#3f3f46}
}
`;

const ASK_CSS = `
.storage-ask{display:flex;flex-direction:column;align-items:flex-start;gap:14px;box-sizing:border-box;padding:20px;border-radius:20px;box-shadow:inset 0 0 0 1px #e4e4e7}
.storage-ask .ic{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;box-shadow:inset 0 0 0 1px #71717a}
.storage-ask h4{margin:0 0 6px;font:400 1.375rem/1.2 ${SERIF};overflow-wrap:anywhere}
.storage-ask p{max-width:52ch;margin:0;font-size:14px;line-height:1.45}
.storage-ask .note{margin-top:8px;font-size:13px}
.action.storage-primary{border-color:#09090b;background:#09090b;color:#fff}
.action.storage-primary:hover{background:#27272a}
@media (prefers-color-scheme: dark){
.storage-ask{box-shadow:inset 0 0 0 1px #69696b}
.action.storage-primary{border-color:#fafafa;background:#fafafa;color:#09090b}
.action.storage-primary:hover{background:#e4e4e7}
}
`;

export type StorageLevel = "normal" | "nearly" | "full";

const LEVELS: Readonly<Record<StorageUsageState, StorageLevel>> = {
  ok: "normal",
  nearly_full: "nearly",
  full: "full",
};

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function roundTo(value: number, unit: number): number {
  return Number(value.toFixed(unit >= 3 ? 2 : 1));
}

/** Binary units as the mockup writes them: `312.4 MiB`, `1 GiB`, `1.25 GiB`. */
export function splitBinary(bytes: number): { readonly amount: string; readonly unit: string } {
  let unit = 0;
  let value = bytes;
  while (unit < BINARY_UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return { amount: String(value), unit: "B" };
  let rounded = roundTo(value, unit);
  if (rounded >= 1024 && unit < BINARY_UNITS.length - 1) {
    unit += 1;
    rounded = roundTo(value / 1024, unit);
  }
  return { amount: String(rounded), unit: BINARY_UNITS[unit] ?? "B" };
}

export function formatBinary(bytes: number): string {
  const { amount, unit } = splitBinary(bytes);
  return `${amount} ${unit}`;
}

export interface SpaceDisplay {
  readonly space: string;
  readonly usedBytes: number;
  readonly limitBytes: number | null;
  readonly source: string;
}

/** What the page shows for one usable status. Built by `storageDisplay`; no strings, no DOM. */
export interface StorageDisplay {
  readonly level: StorageLevel;
  readonly usedBytes: number;
  /** Null: no limit. Zero: no room at all. */
  readonly limitBytes: number | null;
  /** Meter fill, 0 to 100. Only for a positive limit; otherwise there is no meter to draw. */
  readonly percent: number | undefined;
  readonly plan: string | undefined;
  readonly leftBytes: number | undefined;
  /** Empty when the data carries no per-space rows. Never zero-filled. */
  readonly spaces: readonly SpaceDisplay[];
  readonly manageHref: string;
}

function isBytes(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function spacesOf(view: object): readonly SpaceDisplay[] {
  const rows: unknown = "perSpace" in view ? view.perSpace : undefined;
  if (!Array.isArray(rows)) return [];
  const spaces: SpaceDisplay[] = [];
  for (const row of rows as readonly unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { space, usage, source } = row as Record<string, unknown>;
    if (typeof space !== "string" || typeof usage !== "object" || usage === null) continue;
    const { usedBytes, limitBytes } = usage as Record<string, unknown>;
    if (!isBytes(usedBytes)) continue;
    if (limitBytes !== null && !isBytes(limitBytes)) continue;
    spaces.push({
      space,
      usedBytes,
      limitBytes: limitBytes === null ? null : (limitBytes as number),
      source: typeof source === "string" ? source : "real",
    });
  }
  return spaces;
}

/**
 * The page model for one status read, or undefined when the value is not a usable status.
 * The word follows the status `state`; the panel adds no threshold of its own.
 * Account totals win over the space, as in the status reducer.
 */
export function storageDisplay(view: unknown): StorageDisplay | undefined {
  if (!isStorageStatus(view)) return undefined;
  const usage = view.account ?? view;
  const limit = usage.limitBytes;
  const plan = view.account?.plan ?? view.plan;
  return {
    // No limit is never full, whatever the body says.
    level: limit === null ? "normal" : LEVELS[view.state],
    usedBytes: usage.usedBytes,
    limitBytes: limit,
    percent: limit !== null && limit > 0 ? Math.min(100, Math.round((usage.usedBytes / limit) * 1000) / 10) : undefined,
    plan: typeof plan === "string" && plan !== "" ? plan : undefined,
    leftBytes: limit === null ? undefined : Math.max(0, limit - usage.usedBytes),
    spaces: spacesOf(view),
    manageHref: manageHrefFor(view),
  };
}

const LEVEL_WORD: Readonly<Record<StorageLevel, { readonly key: string; readonly tone: "ok" | "warn" }>> = {
  normal: { key: "storage.glance.normal", tone: "ok" },
  nearly: { key: "storage.glance.nearly_full", tone: "warn" },
  full: { key: "storage.glance.full", tone: "warn" },
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== "") node.textContent = content;
  return node;
}

function meter(label: string, max: number, now: number, valueText: string): HTMLElement {
  const track = element("div", "storage-meter");
  track.setAttribute("role", "meter");
  track.setAttribute("aria-label", label);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(max));
  // A value past the maximum is not a valid meter value; the text alternative keeps the real amount.
  track.setAttribute("aria-valuenow", String(Math.min(now, max)));
  track.setAttribute("aria-valuetext", valueText);
  const fill = element("i", "storage-fill");
  fill.style.width = `${Math.min(100, (now / max) * 100)}%`;
  track.append(fill);
  return track;
}

function manageLink(ctx: SectionContext, href: string): HTMLElement {
  const wrap = element("div", "storage-link");
  const link = element("a", "storage-manage");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(
    ctx.text("storage.manage"),
    element("span", "storage-sr", ` ${ctx.text("storage.page.manage_hint")}`),
    icon("ext"),
  );
  wrap.append(link);
  return wrap;
}

function ageText(ctx: SectionContext, ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return ctx.text("storage.page.age_now");
  if (minutes < 60) return ctx.text("storage.page.age_minutes", { count: minutes });
  return ctx.text("storage.page.age_hours", { count: Math.floor(minutes / 60) });
}

/** The state word with its dot. Tone is an attribute; the dot is a ring when it warns, so it never depends on colour alone. */
function statusWord(word: string, tone: "ok" | "warn"): HTMLElement {
  const node = element("span", "storage-st");
  node.dataset.tone = tone;
  const dot = element("span", "storage-dot");
  dot.setAttribute("aria-hidden", "true");
  node.append(dot, element("span", "", word));
  return node;
}

function usedColumn(ctx: SectionContext, d: StorageDisplay): HTMLElement {
  const word = LEVEL_WORD[d.level];
  const column = element("section", "storage-used");
  column.setAttribute("aria-labelledby", "storage-used-h");
  const heading = element("h4", "storage-h", ctx.text("storage.page.used"));
  heading.id = "storage-used-h";

  const used = splitBinary(d.usedBytes);
  const fig = element("div", "storage-fig");
  fig.append(used.amount, element("small", "", ` ${used.unit}`));
  const usedText = formatBinary(d.usedBytes);
  const state = ctx.text(word.key);
  let valueText: string;
  if (d.limitBytes === null) {
    fig.append(element("small", "", ` ${ctx.text("storage.page.no_limit")}`));
    valueText = ctx.text("storage.page.meter_text_open", { used: usedText, state });
  } else {
    const limitText = formatBinary(d.limitBytes);
    fig.append(element("small", "", ` ${ctx.text("storage.page.of_limit", { limit: limitText })}`));
    valueText = ctx.text("storage.page.meter_text", { used: usedText, limit: limitText, state });
  }
  const head = element("div", "storage-hd");
  head.append(fig, statusWord(state, word.tone));
  column.append(heading, head);

  if (d.limitBytes !== null && d.limitBytes > 0) {
    column.append(meter(ctx.text("storage.page.meter"), d.limitBytes, d.usedBytes, valueText));
  }

  const facts = element("dl", "storage-kv");
  const addFact = (label: string, value: string): void => {
    const row = document.createElement("div");
    row.append(element("dt", "", label), element("dd", "", value));
    facts.append(row);
  };
  if (d.plan !== undefined) {
    const plan = d.plan.charAt(0).toUpperCase() + d.plan.slice(1);
    addFact(ctx.text("storage.page.plan"), d.limitBytes === null ? plan : `${plan} — ${formatBinary(d.limitBytes)}`);
  }
  if (d.limitBytes === null) addFact(ctx.text("storage.page.left"), ctx.text("storage.page.no_limit"));
  else addFact(ctx.text("storage.page.left"), d.leftBytes === 0 ? ctx.text("storage.page.none") : formatBinary(d.leftBytes ?? 0));
  column.append(facts, manageLink(ctx, d.manageHref));

  if (d.level === "nearly") {
    const near = element("p", "storage-near");
    near.append(icon("warn"), ctx.text("storage.page.nearly_note"));
    column.append(near);
  }
  return column;
}

function spacesColumn(ctx: SectionContext, d: StorageDisplay): HTMLElement {
  const column = element("section", "storage-by-space");
  column.setAttribute("aria-labelledby", "storage-space-h");
  const heading = element("h4", "storage-h", ctx.text("storage.page.by_space"));
  heading.id = "storage-space-h";
  heading.append(" ", element("span", "cnt", String(d.spaces.length)));
  const list = element("ul", "storage-spaces");
  for (const space of d.spaces) {
    const item = element("li", "storage-space");
    // Rows carry their own source tag so stub numbers stay identifiable in the DOM.
    item.dataset.source = space.source;
    const limit = space.limitBytes ?? d.limitBytes;
    const spaceUsed = formatBinary(space.usedBytes);
    const line = element("div", "l");
    line.append(element("b", "", space.space), element("span", "", spaceUsed));
    item.append(line);
    if (limit !== null && limit > 0) {
      const valueText = ctx.text("storage.page.space_meter_text", { used: spaceUsed, limit: formatBinary(limit) });
      item.append(meter(ctx.text("storage.page.space_meter", { space: space.space }), limit, space.usedBytes, valueText));
    }
    list.append(item);
  }
  column.append(heading, list);
  return column;
}

function banner(ctx: SectionContext, manageHref: string): HTMLElement {
  const box = element("div", "storage-banner");
  box.setAttribute("role", "status");
  const body = document.createElement("div");
  const title = element("strong", "", ctx.text("storage.page.full_title"));
  body.append(title, ctx.text("storage.page.full_body"), manageLink(ctx, manageHref));
  box.append(icon("warn"), body);
  return box;
}

/**
 * The page the panel shows when it has a data source: the status read through `ctx.data`.
 * Numbers render only for a usable status; per-space rows render only when the data carries them.
 */
function mountPage(el: HTMLElement, ctx: SectionContext): () => void {
  const style = document.createElement("style");
  style.textContent = BASE_CSS;
  const added = new Set<string>();
  const addCss = (css: string): void => {
    if (added.has(css)) return;
    added.add(css);
    style.append(css);
  };
  const heading = element("h3", "sec-title", ctx.text("nav.storage"));
  heading.tabIndex = -1;
  const lede = element("p", "storage-lede");

  let disposed = false;
  let reading = false;
  let generation = 0;
  let asking = false;
  let outcome: "declined" | "blocked" | undefined;
  const episodeOn = (): boolean => ctx.client()?.storageEpisode?.current() !== undefined;
  let wasEpisode = episodeOn();

  const line = createStateLine(ctx, () => void reload());
  const content = document.createElement("div");
  const updated = element("p", "storage-updated");

  const askCard = element("div", "storage-ask");
  const askIcon = element("span", "ic");
  askIcon.setAttribute("aria-hidden", "true");
  askIcon.append(icon("drive"));
  const askTitle = element("h4", "");
  const askBody = document.createElement("p");
  const askNote = element("p", "note");
  const askButton = element("button", "action storage-primary");
  askButton.type = "button";
  const askText = document.createElement("div");
  askText.append(askTitle, askBody, askNote);
  askCard.append(askIcon, askText, askButton);

  async function reload(): Promise<void> {
    if (reading) return;
    const mine = generation;
    reading = true;
    render();
    try {
      await ctx.data.refresh("storage");
    } catch {
      // The cache keeps the failed read as an error result, which render shows.
    }
    if (mine !== generation) return;
    reading = false;
    render();
  }

  /** An account or session change: whatever was awaiting belongs to the old account and is dropped. */
  function drop(): void {
    generation += 1;
    reading = false;
    asking = false;
    outcome = undefined;
    render();
  }

  function render(): void {
    if (disposed) return;
    if (ctx.data.source === undefined) {
      // Signed out, or no data source: there is nothing to wait for, so say so instead of loading forever.
      line.status.hidden = false;
      line.status.textContent = ctx.text("storage.unavailable");
      line.retry.hidden = true;
      askCard.hidden = true;
      content.replaceChildren();
      updated.hidden = true;
      return;
    }
    const result = reading ? viewLoading<StorageView>() : (ctx.data.latest("storage") ?? viewLoading<StorageView>());
    // An own-storage-full episode is what the launcher, header and toast already say, so the body says it too.
    // Its numbers are the last read's and may still say "ok", so they are not shown while it lasts.
    const episode = episodeOn();
    const permission = result.state === "needs-permission" && !episode;
    lede.textContent = ctx.text(permission ? "storage.page.lede_short" : "storage.page.lede");

    let display: StorageDisplay | undefined;
    if (permission) {
      line.status.hidden = true;
      line.retry.hidden = true;
    } else if (!reading && result.state === "error" && isUnavailableCode(result.code)) {
      // This node cannot report usage at all: say so, and offer no retry that cannot help.
      line.status.hidden = false;
      line.status.textContent = ctx.text("storage.page.unavailable_node");
      line.retry.hidden = true;
    } else {
      const data = applyResult(line, ctx, result);
      display = data === undefined ? undefined : storageDisplay(data);
      if (data !== undefined && display === undefined) {
        line.status.hidden = false;
        line.status.textContent = ctx.text("storage.unavailable");
      }
    }

    if (episode) {
      line.status.hidden = true;
      line.retry.hidden = true;
      display = undefined;
    }

    if (permission) addCss(ASK_CSS);
    askCard.hidden = !permission;
    if (result.state === "needs-permission") {
      const client = ctx.client();
      const canAsk =
        client?.requestAuthority !== undefined && client.canRequest?.("space/info") !== false && result.ability === "space/info";
      askTitle.textContent = ctx.text("storage.page.permission_title", {
        app: ctx.appLabel() ?? ctx.text("storage.page.permission_app"),
      });
      askBody.textContent = canAsk
        ? `${ctx.text("storage.page.permission_body")} ${ctx.text("storage.page.permission_approve")}`
        : ctx.text("storage.page.permission_body");
      askButton.hidden = !canAsk;
      askButton.disabled = asking;
      askButton.textContent = ctx.text(
        asking ? "storage.page.waiting" : outcome === "declined" ? "storage.try_again" : "storage.page.allow",
      );
      const note = !canAsk || outcome === "blocked" ? "storage.page.permission_blocked" : outcome === "declined" ? "storage.declined" : "";
      askNote.hidden = note === "";
      askNote.textContent = note === "" ? "" : ctx.text(note);
    }

    if (episode) {
      addCss(BANNER_CSS);
      const head = element("div", "storage-hd");
      head.append(statusWord(ctx.text(LEVEL_WORD.full.key), LEVEL_WORD.full.tone));
      const href = result.state === "ready" ? manageHrefFor(result.data) : STORAGE_MANAGE_URL;
      content.replaceChildren(banner(ctx, href), head);
    } else if (display === undefined) {
      content.replaceChildren();
    } else {
      if (display.level === "full") addCss(BANNER_CSS);
      if (display.level === "nearly") addCss(NEAR_CSS);
      if (display.spaces.length > 0) addCss(SPACES_CSS);
      const columns = element("div", "storage-cols");
      columns.append(usedColumn(ctx, display));
      if (display.spaces.length > 0) columns.append(spacesColumn(ctx, display));
      content.replaceChildren(...(display.level === "full" ? [banner(ctx, display.manageHref)] : []), columns);
    }

    const age = ctx.data.age("storage");
    updated.hidden = display === undefined || age === undefined || episode;
    updated.textContent = age === undefined ? "" : ageText(ctx, age);
  }

  askButton.addEventListener("click", (event) => {
    const request = ctx.client()?.requestAuthority;
    if (!event.isTrusted || asking || request === undefined) return;
    asking = true;
    outcome = undefined;
    const mine = generation;
    render();
    void (async () => {
      let result: { approved: boolean; code?: string };
      try {
        result = await request("space/info");
      } catch {
        result = { approved: false, code: "failed" };
      }
      if (disposed || mine !== generation) return;
      asking = false;
      if (result.approved) {
        await reload();
        return;
      }
      outcome = result.code === "unsupported" ? "blocked" : "declined";
      render();
    })();
  });

  const unsubscribe = ctx.data.subscribe(() => render());
  const offEpisode = ctx.client()?.storageEpisode?.subscribe(() => {
    const was = wasEpisode;
    wasEpisode = episodeOn();
    render();
    ctx.requestRender();
    // When the episode ends the numbers are stale: read them again.
    if (was && !wasEpisode) void reload();
  });
  const offReset = ctx.client()?.onReset(drop);
  const offClient = ctx.onClientChange(drop);
  el.append(style, heading, lede, line.status, line.retry, askCard, content, updated);
  render();

  return () => {
    disposed = true;
    unsubscribe();
    offEpisode?.();
    offReset?.();
    offClient();
    el.replaceChildren();
  };
}

/** Storage usage, read through `ctx.data`. */
export const storageSection: PanelSection = {
  id: "storage",
  labelCode: "nav.storage",
  icon: "drive",
  summaryCode: "storage.summary",
  status(ctx) {
    // The same word the launcher, the header and the page body say while an own-storage-full episode lasts.
    if (ctx.client()?.storageEpisode?.current() !== undefined) return { text: ctx.text("storage.glance.full"), tone: "warn" };
    return viewStatus(ctx, ctx.data.latest("storage"), (view): SectionStatus => {
      // No limit is never full, whatever the body says.
      const open = storageDisplay(view)?.limitBytes === null;
      if (!open && view.state === "full") return { text: ctx.text("storage.glance.full"), tone: "warn" };
      if (!open && view.state === "nearly_full") return { text: ctx.text("storage.glance.nearly_full"), tone: "warn" };
      return { text: ctx.text("storage.glance.normal"), tone: "ok" };
    });
  },
  isAvailable: (ctx) => ctx.client()?.signedIn() === true,
  mount: mountPage,
};
