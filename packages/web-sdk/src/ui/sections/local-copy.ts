import type { LocalCopyStatus, LocalFolder, PanelView } from "../data";
import type { ConfirmHandle, PanelSection, SectionContext, SectionStatus, SyncEffective, SyncFacade } from "../slots";
import { normalizeSyncEffective } from "../status";
import { registerPanelStrings } from "../strings-panel";
import { LOCAL_COPY_STRINGS } from "./local-copy.strings";
import { purgeWatch } from "../sign-out-purge";
import { viewStatus } from "./status";
import { statusNode, UI_STYLE } from "./ui";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";

registerPanelStrings(LOCAL_COPY_STRINGS);

const DISPLAY = '"Literata Variable","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

/**
 * Section CSS, scoped by the lc- prefix. Rows and the card follow the mockup's key/value ledger:
 * a dotted leader joins each label to its value. Colours repeat the shell's light and dark tokens.
 */
const STYLE = `
.lc-lede{max-width:56ch;margin:-20px 0 20px;font-size:15px;line-height:1.5}
.lc-sw{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:4px 0}
.lc-sw strong{display:block;font:500 16px/1.3 ${DISPLAY};letter-spacing:-.005em}
.lc-sub{display:block;margin-top:2px;font-size:13.5px;color:#71717a}
.lc-swctl{display:flex;flex:none;align-items:center;gap:10px}
.lc-swlbl{min-width:22px;font-size:13px;font-weight:700;text-align:right}
.lc-card{display:flex;flex-direction:column;gap:10px;margin-top:16px;padding:16px 18px;border-radius:16px;background:#fafafa;box-shadow:inset 0 0 0 1px #e4e4e7}
.lc-card p{margin:0}
.lc-small{font-size:14px;line-height:1.45}
.lc-state{margin:6px 0 0}
.lc-kv{display:flex;flex-direction:column;margin:0;padding:0}
.lc-kv>div{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:44px;padding:9px 0;border-bottom:1px solid #e4e4e7}
.lc-kv>div:last-child{border-bottom:0}
.lc-kv.lc-cozy>div{min-height:36px;padding:5px 0;border-bottom:0}
.lc-kv dt{display:flex;flex:1 1 auto;align-items:baseline;gap:10px;min-width:0;font-size:14px;white-space:nowrap}
.lc-kv dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted #a1a1aa;transform:translateY(-3px)}
.lc-kv dd{display:flex;flex:0 1 auto;align-items:center;justify-content:flex-end;max-width:78%;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.lc-kv dd.lc-plain{font-weight:400}
.lc-kv .lc-prefix{font:600 .875rem ${MONO}}
.lc-sec{margin-top:24px}
.lc-h3{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:13px;font-weight:600;line-height:1.3;letter-spacing:.02em}
.lc-h3::after{content:"";flex:1;height:1px;background:#e4e4e7}
.lc-cnt{font-weight:500;color:#71717a}
.lc-wipe p{max-width:56ch;margin:0 0 12px;font-size:14px;line-height:1.45}
.lc-fail{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}
.lc-fail p{margin:0;font-size:14px}
.lc-sec .confirm,.lc-sw+.confirm{margin-top:12px}
.lc-confirm.confirm .busy{margin:0;font-size:14.5px;line-height:1.5;color:inherit}
.lc-confirm.confirm .actions{margin:16px 0 0}
.lc-confirm .action:last-child{background:#09090b;border-color:#09090b;color:#fff}
.lc-confirm .action:last-child:hover{background:#27272a}
.lc-confirm .action:disabled{opacity:.6;cursor:default}
@media (max-width:600px){
.lc-confirm.confirm .actions{flex-direction:column}
.lc-confirm .action{width:100%;white-space:normal}
}
.panel[data-layout="page"] .lc-card{background:#fff}
@media (prefers-color-scheme: dark){
.lc-sub,.lc-cnt{color:#a1a1aa}
.lc-card{background:#151517;box-shadow:inset 0 0 0 1px #69696b}
.lc-kv>div{border-bottom-color:#69696b}
.lc-kv dt::after{border-bottom-color:#71717a}
.lc-h3::after{background:#69696b}
.lc-confirm .action:last-child{background:#fafafa;border-color:#fafafa;color:#09090b}
.lc-confirm .action:last-child:hover{background:#e4e4e7}
.panel[data-layout="page"] .lc-card{background:#151517}
}
`;

/** Codes of rejected facade calls. Non-string codes become "unknown", which renders the neutral line. */
function codeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return "unknown";
}

/** Effective states in which a wipe can run. Unavailable, enabling, wiping and unknown values cannot. */
const WIPEABLE: Record<SyncEffective, boolean> = {
  off: true,
  on: true,
  pending: true,
  enabling: false,
  wiping: false,
  unavailable: false,
};

/** Word for the transitional and blocked states. Settled on and off need none. */
const STATE_WORD: Partial<Record<SyncEffective, string>> = {
  enabling: "local-copy.state.enabling",
  wiping: "local-copy.state.wiping",
  pending: "local-copy.state.pending",
  unavailable: "local-copy.state.unavailable",
};

function formatBytes(ctx: SectionContext, bytes: number): string {
  const units = [
    ["local-copy.bytes.b", 1],
    ["local-copy.bytes.kib", 1024],
    ["local-copy.bytes.mib", 1024 ** 2],
    ["local-copy.bytes.gib", 1024 ** 3],
  ] as const;
  let pick: (typeof units)[number] = units[0];
  for (const unit of units) if (bytes >= unit[1]) pick = unit;
  const scaled = bytes / pick[1];
  const value = pick[1] === 1 || Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1);
  return ctx.text(pick[0], { value });
}

function ago(ctx: SectionContext, at: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at.getTime()) / 60_000));
  if (minutes < 1) return ctx.text("local-copy.ago.now");
  if (minutes < 60) return ctx.text("local-copy.ago.minutes", { count: minutes });
  if (minutes < 1440) return ctx.text("local-copy.ago.hours", { count: Math.floor(minutes / 60) });
  return ctx.text("local-copy.ago.days", { count: Math.floor(minutes / 1440) });
}

/** A count or size that is known: a finite, non-negative number. Anything else is unknown, never zero. */
function isKnown(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function folderDetail(ctx: SectionContext, folder: LocalFolder): string {
  const parts: string[] = [];
  if (folder.state === "syncing" || folder.state === "paused") parts.push(ctx.text(`local-copy.folder.${folder.state}`));
  if (!isKnown(folder.items) && !isKnown(folder.bytes) && !isKnown(folder.waiting)) {
    parts.push(ctx.text("local-copy.folder.unknown"));
  } else {
    parts.push(isKnown(folder.items) ? ctx.text("local-copy.folder.items", { count: folder.items }) : ctx.text("local-copy.folder.items.unknown"));
    parts.push(isKnown(folder.bytes) ? formatBytes(ctx, folder.bytes) : ctx.text("local-copy.folder.size.unknown"));
    if (!isKnown(folder.waiting)) parts.push(ctx.text("local-copy.folder.waiting.unknown"));
    else if (folder.waiting > 0) parts.push(ctx.text("local-copy.folder.waiting", { count: folder.waiting }));
  }
  return parts.join(" · ");
}

function kvRow(label: string, value: string | Node, plain = false, mono = false): HTMLDivElement {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  if (mono) {
    const name = document.createElement("span");
    name.className = "lc-prefix";
    name.textContent = label;
    dt.append(name);
  } else {
    dt.textContent = label;
  }
  const dd = document.createElement("dd");
  if (plain) dd.className = "lc-plain";
  dd.append(value);
  row.append(dt, dd);
  return row;
}

/** Settled on or off; a pending erase warns; transitional states stay neutral. */
function copyStatus(ctx: SectionContext, copy: Pick<LocalCopyStatus, "effective">): SectionStatus {
  switch (normalizeSyncEffective(copy.effective)) {
    case "on":
      return { text: ctx.text("local-copy.glance.on"), tone: "ok" };
    case "off":
      return { text: ctx.text("local-copy.glance.off"), tone: "off" };
    case "pending":
      return { text: ctx.text("local-copy.glance.pending"), tone: "warn" };
    case "unavailable":
      return { text: ctx.text("section.status.unavailable"), tone: "info" };
    default:
      return { text: ctx.text("section.status.checking"), tone: "info" };
  }
}

/**
 * The rail's and the Overview row's status. It reads the same source as the section body: the client's sync
 * facade, which is live and synchronous and also drives the switch. The data source's own `effective` is only a
 * cached copy that can lag or differ (a seed, a stale read), so with a facade it is not consulted. Without a
 * facade the data source's state is all there is.
 */
function railStatus(ctx: SectionContext): SectionStatus | undefined {
  const state = ctx.client()?.sync?.state;
  if (state !== undefined) return copyStatus(ctx, state);
  return viewStatus(ctx, ctx.data.latest("localCopy"), (copy) => copyStatus(ctx, copy));
}

/** Counts mounts, so each one's description id is unique even if two sections are ever in one tree. */
let mountCount = 0;

/**
 * Local copy on this device: the switch, what is kept, and Wipe local data.
 * The switch and the effective state come from the client's sync facade; the rows come from
 * `ctx.data.source.localCopy()`. Mounted only while the panel is open.
 *
 * Erase path. The wipe runs only from the confirm box's destructive action, never from a
 * click on the switch or on the Wipe button alone. A latch set before the first await makes a
 * second activation a no-op. The button is hidden while sync is unavailable and disabled
 * while enabling or wiping.
 */
function mountLocalCopy(el: HTMLElement, ctx: SectionContext): () => void {
  const facade: SyncFacade | undefined = ctx.client()?.sync;
  if (!facade) return () => undefined;
  const sync: SyncFacade = facade;

  let disposed = false;
  let seq = 0;
  /** Facade call in flight (enable). */
  let busy = false;
  /** Wipe in flight. Set before the first await so a second activation cannot start another. */
  let wiping = false;
  let confirming: ConfirmHandle | undefined;
  let copy: LocalCopyStatus | undefined;
  let toggleFailed: string | undefined;
  let wipeFailed = false;
  let lastTurnOff = false;
  /** Retry of a purge that did not finish after sign-out, in flight. */
  let purgeBusy = false;
  /** The switch held focus when it was locked; Chromium drops focus from a disabled button. */
  let refocusSwitch = false;
  const watch = purgeWatch(ctx.client());
  /**
   * Bumped when the account or session changes (the client's reset). Every awaited result captures it first and is
   * dropped if it moved, so a late answer of the previous session never writes to the new one. The shell exposes
   * no generation to sections yet; this is the section's own, driven by the same reset the shell reacts to.
   */
  let generation = 0;

  const style = document.createElement("style");
  style.textContent = STYLE + UI_STYLE;

  const heading = document.createElement("h3");
  heading.className = "sec-title";
  heading.tabIndex = -1;
  heading.textContent = ctx.text("nav.local-copy");
  const lede = textLine("lc-lede", ctx.text("local-copy.lede"));

  const purgeBox = document.createElement("div");
  purgeBox.className = "lc-fail lc-purge";
  const purgeNote = textLine("", "");
  purgeNote.setAttribute("role", "alert");
  const purgeRetry = document.createElement("button");
  purgeRetry.type = "button";
  purgeRetry.className = "action";
  purgeRetry.textContent = ctx.text("local-copy.wipe.retry");
  purgeBox.append(purgeNote, purgeRetry);

  const switchRow = document.createElement("div");
  switchRow.className = "row lc-sw";
  const switchText = document.createElement("div");
  const switchLabel = document.createElement("strong");
  switchLabel.id = "lc-switch-label";
  switchLabel.className = "label";
  switchLabel.textContent = ctx.text("local-copy.switch");
  const switchSub = document.createElement("span");
  switchSub.className = "lc-sub";
  switchText.append(switchLabel, switchSub);
  const switchCtl = document.createElement("div");
  switchCtl.className = "lc-swctl";
  const switchWord = document.createElement("span");
  switchWord.className = "lc-swlbl";
  switchWord.setAttribute("aria-hidden", "true");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-labelledby", switchLabel.id);
  const knob = document.createElement("span");
  knob.className = "knob";
  toggle.append(knob);
  switchCtl.append(switchWord, toggle);
  switchRow.append(switchText, switchCtl);

  const stateNote = textLine("note lc-state", "");
  stateNote.setAttribute("role", "status");
  const reasonNote = textLine("note", "");
  const viewLine = createStateLine(ctx, () => void load());
  const toggleError = textLine("error", "");
  toggleError.setAttribute("role", "alert");

  const card = document.createElement("div");
  card.className = "lc-card";
  const cardStatus = document.createElement("div");
  const rows = document.createElement("dl");
  rows.className = "lc-kv lc-cozy";
  const offBody = textLine("lc-small", "");
  card.append(cardStatus, rows, offBody);

  const folderSec = document.createElement("section");
  folderSec.className = "lc-sec";
  const folderHead = document.createElement("h3");
  folderHead.className = "lc-h3";
  folderHead.id = "lc-folders";
  folderSec.setAttribute("aria-labelledby", folderHead.id);
  const folderCount = document.createElement("span");
  folderCount.className = "lc-cnt";
  const folderTitle = document.createTextNode(ctx.text("local-copy.folders.title"));
  folderHead.append(folderTitle, folderCount);
  const folderList = document.createElement("dl");
  folderList.className = "lc-kv";
  folderSec.append(folderHead, folderList);

  const wipeSec = document.createElement("section");
  wipeSec.className = "lc-sec lc-wipe";
  const wipeHead = document.createElement("h3");
  wipeHead.className = "lc-h3";
  wipeHead.id = "lc-wipe";
  wipeHead.textContent = ctx.text("local-copy.wipe.title");
  wipeSec.setAttribute("aria-labelledby", wipeHead.id);
  const wipeBody = textLine("", ctx.text("local-copy.wipe.body"));
  wipeBody.id = `lc-wipe-text-${++mountCount}`;
  const wipeBtn = document.createElement("button");
  wipeBtn.type = "button";
  wipeBtn.className = "action";
  wipeBtn.textContent = ctx.text("local-copy.wipe.button");
  // The explanation is always on screen above the button; assistive tech reads it with the button.
  wipeBtn.setAttribute("aria-describedby", wipeBody.id);
  const wipeFail = document.createElement("div");
  wipeFail.className = "lc-fail";
  const wipeFailText = textLine("", ctx.text("local-copy.wipe.failed"));
  wipeFailText.setAttribute("role", "alert");
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "action";
  retryBtn.textContent = ctx.text("local-copy.wipe.retry");
  wipeFail.append(wipeFailText, retryBtn);
  wipeSec.append(wipeHead, wipeBody, wipeBtn, wipeFail);

  el.append(
    style,
    heading,
    lede,
    purgeBox,
    switchRow,
    stateNote,
    reasonNote,
    viewLine.status,
    viewLine.retry,
    toggleError,
    card,
    folderSec,
    wipeSec,
  );

  function effectiveNow(): SyncEffective {
    return normalizeSyncEffective(sync.state.effective);
  }

  /** Whether a wipe is offered at all: never while unavailable, and for an off copy only when bytes remain. */
  function wipeOffered(): boolean {
    const effective = effectiveNow();
    if (effective === "unavailable" || effective === "enabling") return false;
    // Unknown is never zero: only a size known to be zero hides the wipe for an off copy.
    if (effective === "off") return copy?.bytesOnDevice !== 0;
    return true;
  }

  function canWipe(): boolean {
    return !disposed && !wiping && !busy && WIPEABLE[effectiveNow()] && wipeOffered();
  }

  function closeConfirm(): void {
    const open = confirming;
    confirming = undefined;
    open?.close();
  }

  function render(): void {
    if (disposed) return;
    const state = sync.state;
    const effective = effectiveNow();
    const known = effective === state.effective;
    const requested = state.requested;
    const locked = effective === "enabling" || effective === "wiping" || effective === "pending" || effective === "unavailable";

    toggle.setAttribute("aria-checked", String(requested));
    const lockSwitch = locked || busy || wiping;
    const root = toggle.getRootNode() as Document | ShadowRoot;
    if (lockSwitch && !toggle.disabled && root.activeElement === toggle) refocusSwitch = true;
    toggle.disabled = lockSwitch;
    if (!lockSwitch && refocusSwitch) {
      refocusSwitch = false;
      if (root.activeElement === null || root.activeElement === document.body) toggle.focus();
    }
    switchWord.textContent = ctx.text(requested ? "local-copy.switch.state.on" : "local-copy.switch.state.off");
    switchSub.textContent = ctx.text(requested ? "local-copy.switch.on" : "local-copy.switch.off");

    // The header already shows the same sync_pending word; the reason line still explains it.
    const headerShowsWord = effective === "pending" && ctx.topStatus() === "sync_pending" && !wiping;
    const wordKey = wiping ? "local-copy.state.wiping" : STATE_WORD[effective];
    stateNote.hidden = wordKey === undefined || headerShowsWord;
    stateNote.textContent = wordKey === undefined ? "" : ctx.text(wordKey);

    const reasonCode = !known ? "unknown" : (state.reason ?? (effective === "pending" ? "erase-pending" : "unknown"));
    if (effective === "unavailable") {
      reasonNote.hidden = false;
      reasonNote.textContent = `${ctx.text(`sync.reason.${reasonCode}`)} ${ctx.text("local-copy.unavailable.note")}`;
    } else if (effective === "pending") {
      reasonNote.hidden = false;
      reasonNote.textContent = `${ctx.text(`sync.reason.${reasonCode}`)} ${ctx.text("local-copy.pending.note")}`;
    } else {
      reasonNote.hidden = true;
      reasonNote.textContent = "";
    }

    toggleError.hidden = toggleFailed === undefined;
    toggleError.textContent = toggleFailed === undefined ? "" : ctx.text(`sync.error.${toggleFailed}`);

    const purgeFailure = watch?.failure();
    purgeBox.hidden = purgeFailure === undefined;
    purgeNote.textContent = purgeFailure === undefined ? "" : ctx.text(`local-copy.purge.${purgeFailure}`);
    purgeRetry.disabled = purgeBusy;

    // The card, folders and rows describe a copy that exists. They need a ready read.
    const showsCopy = effective === "on" || effective === "pending" || effective === "enabling" || effective === "wiping";
    const cardShown = copy !== undefined && (showsCopy || effective === "off");
    card.hidden = !cardShown;
    folderSec.hidden = !(copy !== undefined && showsCopy && copy.folders.length > 0);
    if (copy !== undefined && cardShown) {
      rows.hidden = !showsCopy;
      cardStatus.hidden = !showsCopy;
      offBody.hidden = showsCopy;
      if (showsCopy) {
        const status: SectionStatus =
          effective === "enabling"
            ? { text: ctx.text("local-copy.state.enabling"), tone: "info" }
            : isDate(copy.lastSyncedAt)
              ? { text: ctx.text("local-copy.synced", { ago: ago(ctx, copy.lastSyncedAt, Date.now()) }), tone: "ok" }
              : { text: ctx.text("local-copy.synced.unknown"), tone: "info" };
        cardStatus.replaceChildren(statusNode(status));
        const waiting = !isKnown(copy.pending)
          ? ctx.text("local-copy.unknown")
          : copy.pending === 0
            ? ctx.text("local-copy.row.waiting.none")
            : copy.pending === 1
              ? ctx.text("local-copy.row.waiting.one")
              : ctx.text("local-copy.row.waiting.many", { count: copy.pending });
        const size = isKnown(copy.bytesOnDevice) ? formatBytes(ctx, copy.bytesOnDevice) : ctx.text("local-copy.unknown");
        const nodes = [kvRow(ctx.text("local-copy.row.waiting"), waiting), kvRow(ctx.text("local-copy.row.size"), size)];
        rows.replaceChildren(...nodes);
        folderCount.textContent = String(copy.folders.length);
        folderList.replaceChildren(
          ...copy.folders.map((folder) => kvRow(folder.prefix, folderDetail(ctx, folder), true, true)),
        );
      } else {
        const title = document.createElement("strong");
        title.textContent = ctx.text("local-copy.off.title");
        const empty =
          copy.bytesOnDevice === 0
            ? ` ${ctx.text("local-copy.off.empty")}`
            : isKnown(copy.bytesOnDevice)
              ? ""
              : ` ${ctx.text("local-copy.off.unknown")}`;
        offBody.replaceChildren(
          title,
          `${empty} ${ctx.text("local-copy.off.body", { app: ctx.appLabel() ?? ctx.text("local-copy.off.app") })}`,
        );
      }
    }

    const offered = wipeOffered();
    wipeSec.hidden = !offered;
    wipeBtn.disabled = busy || wiping || effective === "wiping" || effective === "enabling";
    wipeFail.hidden = !wipeFailed;
    retryBtn.disabled = wipeBtn.disabled;
    // A confirm cannot outlive the state that allowed it, unless it is the one running.
    if (confirming !== undefined && !wiping && !canWipe()) closeConfirm();
  }

  async function load(): Promise<void> {
    const source = ctx.data.source;
    if (!source) {
      // Signed out, or no data source: the facade drives the switch and nothing is on its way, so no "Loading…".
      copy = undefined;
      viewLine.status.hidden = true;
      viewLine.retry.hidden = true;
      render();
      return;
    }
    const token = ++seq;
    const mine = generation;
    const result = await settle(() => source.localCopy());
    if (disposed || token !== seq || mine !== generation) return;
    const data = applyResult(viewLine, ctx, result);
    if (data !== undefined) copy = data;
    render();
  }

  async function enable(on: boolean): Promise<void> {
    const mine = generation;
    busy = true;
    toggleFailed = undefined;
    render();
    try {
      await sync.setEnabled(on);
    } catch (err) {
      if (!disposed && mine === generation) toggleFailed = codeOf(err);
    } finally {
      // After a reset the busy flag belongs to the new session's call, not to this one.
      if (mine === generation) {
        busy = false;
        render();
      }
    }
  }

  async function runWipe(handle: ConfirmHandle, turnOff: boolean): Promise<void> {
    // Fail closed: only the open box this call belongs to can start a wipe, once, in a state that allows it.
    if (wiping || confirming !== handle || !canWipe()) return;
    wiping = true;
    const mine = generation;
    wipeFailed = false;
    toggleFailed = undefined;
    handle.confirm.disabled = true;
    handle.cancel.disabled = true;
    handle.confirm.textContent = ctx.text("local-copy.wipe.busy");
    render();

    let wiped = true;
    try {
      await sync.wipeLocalData();
    } catch {
      wiped = false;
    }
    // The account changed while the wipe ran: its outcome belongs to the previous session and shows nothing.
    if (mine !== generation) return;
    if (wiped && turnOff && sync.state.requested) {
      try {
        await sync.setEnabled(false);
      } catch (err) {
        if (!disposed && mine === generation) toggleFailed = codeOf(err);
      }
      if (mine !== generation) return;
    }
    wiping = false;
    if (wiped) ctx.toast({ kind: "success", textCode: "local-copy.wipe.done" });
    if (disposed) return;
    closeConfirm();
    wipeFailed = !wiped;
    render();
    if (wiped) {
      toggle.focus();
      void load();
    } else {
      // The wipe section can be hidden by a state change while the wipe ran: then there is no Try again to focus.
      if (!wipeSec.hidden && !wipeFail.hidden && !retryBtn.disabled) retryBtn.focus();
      else heading.focus();
    }
  }

  /** Step one: the confirm box. Nothing is erased until its destructive action. */
  function askWipe(turnOff: boolean, anchor: HTMLElement, returnFocus: HTMLElement): void {
    if (confirming !== undefined || !canWipe()) return;
    lastTurnOff = turnOff;
    const pending = copy?.pending;
    const lines = [ctx.text(turnOff ? "local-copy.wipe.question.off" : "local-copy.wipe.question")];
    if (!isKnown(pending)) lines.push(ctx.text("local-copy.wipe.unsynced.unknown"));
    else if (pending > 0) {
      lines.push(ctx.text(pending === 1 ? "local-copy.wipe.unsynced.one" : "local-copy.wipe.unsynced.many", { count: pending }));
    }
    if (!turnOff) lines.push(ctx.text("local-copy.wipe.refill"));
    const handle: ConfirmHandle = ctx.confirm({
      question: lines.join(" "),
      cancelLabel: ctx.text("local-copy.wipe.keep"),
      confirmLabel: ctx.text("local-copy.wipe.confirm"),
      anchor,
      onCancel: () => {
        if (confirming === handle) confirming = undefined;
        if (!disposed) returnFocus.focus();
      },
      onConfirm: () => void runWipe(handle, turnOff),
    });
    confirming = handle;
    // Scoped hook for the confirm's own look: body text, a filled destructive action, stacked buttons on a phone.
    handle.confirm.closest(".confirm")?.classList.add("lc-confirm");
  }

  toggle.addEventListener("click", () => {
    if (toggle.disabled || busy || wiping) return;
    if (!sync.state.requested) {
      void enable(true);
    } else if (wipeOffered()) {
      askWipe(true, switchRow, toggle);
    } else {
      void enable(false);
    }
  });
  wipeBtn.addEventListener("click", () => {
    if (wipeBtn.disabled) return;
    wipeFailed = false;
    render();
    askWipe(false, wipeBtn, wipeBtn);
  });
  retryBtn.addEventListener("click", () => {
    if (retryBtn.disabled) return;
    wipeFailed = false;
    render();
    askWipe(lastTurnOff, lastTurnOff ? switchRow : wipeBtn, lastTurnOff ? toggle : wipeBtn);
  });
  purgeRetry.addEventListener("click", () => {
    if (watch === undefined || purgeRetry.disabled || purgeBusy) return;
    const mine = generation;
    purgeBusy = true;
    render();
    void watch.retry().then((gone) => {
      // An answer for an earlier session changes nothing here: the reset already released this retry.
      if (mine !== generation) return;
      purgeBusy = false;
      if (gone) ctx.toast({ kind: "success", textCode: "local-copy.purge.done" });
      if (disposed) return;
      render();
      if (gone) heading.focus();
      else purgeRetry.focus();
    });
  });

  const offFacade = sync.subscribe(() => {
    render();
    // The rail and the Overview row read the facade too: repaint them with the body.
    ctx.requestRender();
    void load();
  });
  let offSource: (() => void) | undefined;
  const watchSource = (): void => {
    offSource?.();
    offSource = ctx.data.source?.subscribe((view: PanelView) => {
      if (view === "copy") void load();
    });
  };
  watchSource();
  // A reset (sign-out, account switch): whatever the previous session left on screen or in flight is dropped,
  // and the section reads again for the new one. In-flight calls find the generation moved and discard themselves.
  const offReset = ctx.client()?.onReset(() => {
    generation += 1;
    busy = false;
    wiping = false;
    purgeBusy = false;
    toggleFailed = undefined;
    wipeFailed = false;
    copy = undefined;
    closeConfirm();
    startLoading(viewLine, ctx);
    render();
    watchSource();
    void load();
  });
  const offStatus = ctx.onStatusChange(render);
  const offPurge = watch?.subscribe(render);
  // "Synced 3 min ago" moves with the clock; one tick a minute is enough.
  const timer = setInterval(() => {
    render();
    void load();
  }, 60_000);

  // First paint from the shell cache, then one fresh read.
  const cached = ctx.data.latest("localCopy");
  if (cached?.state === "ready") copy = cached.data;
  else startLoading(viewLine, ctx);
  render();
  void load();

  return () => {
    disposed = true;
    clearInterval(timer);
    offFacade();
    offSource?.();
    offReset?.();
    offStatus();
    offPurge?.();
    el.replaceChildren();
  };
}

export const localCopySection: PanelSection = {
  id: "local-copy",
  labelCode: "nav.local-copy",
  icon: "sync",
  summaryCode: "local-copy.summary",
  isAvailable: (ctx) => ctx.client()?.sync !== undefined,
  status: railStatus,
  mount: mountLocalCopy,
};
