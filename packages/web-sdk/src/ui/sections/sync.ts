import type { HostContext, PanelSection, SyncEffective, SyncState } from "../slots";
import { normalizeSyncEffective } from "../status";

/** Busy or status word per effective value. Undefined when no word is shown. */
const WORD: Record<SyncEffective, string | undefined> = {
  off: undefined,
  enabling: "sync.busy.enabling",
  on: undefined,
  wiping: "sync.busy.wiping",
  pending: "sync.pending",
  unavailable: "sync.unavailable",
};

/** Error code from a rejected facade call. Non-string codes become "unknown" and render neutral. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
}

/**
 * Minimal Sync row against `tc.sync`. Mounted only while the panel is open.
 * Reason and error codes render only through `ctx.text`; unknown codes show the neutral line.
 */
export const syncSection: PanelSection = {
  id: "sync",
  isAvailable: (ctx) => ctx.client()?.sync !== undefined,
  mount(el, ctx: HostContext) {
    const facade = ctx.client()?.sync;
    if (!facade) return () => undefined;

    let disposed = false;
    let busy = false;
    let confirming = false;
    let errorCode: string | undefined;

    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = ctx.text("sync.label");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", ctx.text("sync.switch"));
    const knob = document.createElement("span");
    knob.className = "knob";
    toggle.append(knob);
    row.append(label, toggle);

    const word = document.createElement("p");
    word.className = "busy";
    const reasonLine = document.createElement("p");
    reasonLine.className = "note";

    const wipe = document.createElement("button");
    wipe.type = "button";
    wipe.className = "action";
    wipe.textContent = ctx.text("sync.wipe.button");

    const confirmBox = document.createElement("div");
    confirmBox.className = "confirm";
    const question = document.createElement("p");
    question.className = "busy";
    question.textContent = ctx.text("sync.wipe.question");
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "action";
    confirmBtn.textContent = ctx.text("sync.wipe.confirm");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "action";
    cancelBtn.textContent = ctx.text("sync.wipe.cancel");
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(confirmBtn, cancelBtn);
    const wipeNote = document.createElement("p");
    wipeNote.className = "note";
    wipeNote.textContent = ctx.text("sync.wipe.note");
    confirmBox.append(question, actions);

    const errorLine = document.createElement("p");
    errorLine.className = "error";
    errorLine.setAttribute("role", "alert");

    function render(): void {
      if (disposed) return;
      const state: SyncState = facade.state;
      const effective: SyncEffective = normalizeSyncEffective(state.effective);
      const known = effective === state.effective;

      // The switch position is state.requested only. The app and SDK defaults can both set it.
      const checked = state.requested;
      const locked = effective === "enabling" || effective === "wiping" || effective === "pending" || effective === "unavailable";
      toggle.setAttribute("aria-checked", String(checked));
      toggle.disabled = locked || busy;

      const wordKey = WORD[effective];
      // The header already shows the same sync_pending word; the reason line still explains it.
      const headerShowsWord = effective === "pending" && ctx.topStatus() === "sync_pending";
      word.hidden = wordKey === undefined || headerShowsWord;
      word.textContent = wordKey === undefined ? "" : ctx.text(wordKey);

      const showReason = effective === "pending" || effective === "unavailable";
      const reasonCode = !known
        ? "unknown"
        : (state.reason ?? (effective === "pending" ? "erase-pending" : "unknown"));
      reasonLine.hidden = !showReason;
      reasonLine.textContent = showReason ? ctx.text(`sync.reason.${reasonCode}`) : "";

      const wipeBlocked = effective === "wiping" || effective === "enabling";
      wipe.disabled = busy || wipeBlocked;
      if (wipeBlocked) confirming = false;
      confirmBox.hidden = !confirming;

      errorLine.hidden = errorCode === undefined;
      errorLine.textContent = errorCode === undefined ? "" : ctx.text(`sync.error.${errorCode}`);
    }

    async function run(action: () => Promise<void>): Promise<boolean> {
      busy = true;
      errorCode = undefined;
      render();
      try {
        await action();
        return true;
      } catch (err) {
        if (!disposed) errorCode = codeOf(err);
        return false;
      } finally {
        busy = false;
        render();
      }
    }

    toggle.addEventListener("click", (event) => {
      if (!event.isTrusted || busy || toggle.disabled) return;
      void run(() => facade.setEnabled(!facade.state.requested));
    });

    wipe.addEventListener("click", (event) => {
      if (!event.isTrusted || busy || wipe.disabled) return;
      confirming = true;
      errorCode = undefined;
      render();
    });

    cancelBtn.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      confirming = false;
      render();
    });

    confirmBtn.addEventListener("click", (event) => {
      if (!event.isTrusted || busy || confirmBtn.disabled) return;
      void run(() => facade.wipeLocalData()).then((ok) => {
        if (ok && !disposed) {
          confirming = false;
          render();
        }
      });
    });

    const unsubscribe = facade.subscribe(() => render());
    const unsubscribeStatus = ctx.onStatusChange(() => render());
    el.append(row, word, reasonLine, wipe, wipeNote, confirmBox, errorLine);
    render();

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeStatus();
      el.replaceChildren();
    };
  },
};
