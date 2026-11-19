/*
 * Toast region of the lazy panel chunk. While the panel is mounted it renders
 * every toast in the shared store (icon, 44px dismiss, 7 s) and the receipt
 * slips that sections raise, in the host layer above the panel. The eager
 * toasts part keeps its own stack and shows the toasts that appear before this
 * chunk loads; mounting this region removes that stack, so a toast is never
 * drawn twice and the page holds one set of toast elements.
 */
import { icon, type IconName } from "./sections/ui";
import { panelText } from "./strings-panel";
import type { ToastKind, ToastRequest, ToastStore, ToastView } from "./toast-store";

type Code = string;

/** One receipt row: a label code and a data value (an ID), never prose. */
export interface ReceiptRow {
  readonly labelCode: Code;
  readonly value: string;
  /** What Copy receipt writes for this row (for example the full ID when `value` is a short form). Default: `value`. */
  readonly copyValue?: string;
}

/** A confirmation with a dashed slip of identifiers and a Copy receipt action. */
export interface ReceiptRequest {
  readonly titleCode: Code;
  readonly bodyCode?: Code;
  readonly rows: readonly ReceiptRow[];
}

export interface ToastRegion {
  /** Shows a receipt. Returns false when it duplicates one on screen. */
  receipt(request: ReceiptRequest): boolean;
  /** Drops every receipt slip. A receipt belongs to the account that made it, so an account change clears them. */
  clearReceipts(): void;
  dispose(): void;
}

const KIND_ICON: Record<ToastKind, IconName> = { info: "info", success: "check", warning: "warn", error: "warn" };
const RECEIPT_MS = 7000;
const MAX_RECEIPTS = 3;

export const TOAST_REGION_CSS = `
.tstack{position:fixed;bottom:calc(var(--b) + 56px);display:flex;flex-direction:column;gap:10px;width:min(400px,calc(100vw - 24px));pointer-events:none}
.layer[data-position="bottom-right"] .tstack{right:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-left"] .tstack{left:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-center"] .tstack{left:50%;transform:translateX(-50%)}
.layer[data-panel-open][data-layout="drawer"] .tstack{bottom:12px;width:min(396px,calc(100vw - 24px))}
.layer[data-panel-open][data-layout="drawer"][data-position="bottom-right"] .tstack{right:12px}
.layer[data-panel-open][data-layout="drawer"][data-position="bottom-left"] .tstack{left:12px}
.layer[data-panel-open][data-layout="page"] .tstack{bottom:24px;right:24px;left:auto;transform:none;width:min(420px,calc(100vw - 32px))}
.layer[data-phone][data-panel-open] .tstack{bottom:calc(var(--b));left:12px;right:12px;transform:none;width:auto}
.tstack>div{display:contents}
.tstack .toast{display:flex;align-items:flex-start;gap:12px;box-sizing:border-box;padding:14px 8px 14px 16px;border:0;border-radius:16px;background:#fff;color:#111827;box-shadow:0 12px 32px -8px rgba(0,0,0,.3),0 0 0 1px #a1a1aa;pointer-events:auto;animation:tc-toast-in .45s cubic-bezier(.22,1,.36,1)}
.tstack .toast__icon{display:inline-flex;flex:none;margin-top:12px}
.tstack .toast__icon .ui-ic{width:20px;height:20px}
.tstack .toast__body{flex:1;min-width:0;padding-top:12px;overflow-wrap:anywhere}
.tstack .toast__title{display:block;font-weight:700}
.tstack .toast a,.tstack .toast__copy{display:inline-flex;align-items:center;min-height:44px;margin-top:2px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:3px;white-space:nowrap;cursor:pointer}
.tstack .toast__close{display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer}
.tstack .toast__close .ui-ic{width:20px;height:20px}
.tstack .slip{margin-top:8px;padding:8px 0;border-top:2px dashed #71717a;border-bottom:2px dashed #71717a;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;overflow-wrap:anywhere}
.tstack .slip>div{display:block}
.toast a:focus-visible,.toast__close:focus-visible,.toast__copy:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
@keyframes tc-toast-in{from{opacity:0;transform:translateY(14px)}}
@media (prefers-reduced-motion:reduce){
.tstack .toast{animation:none}
}
@media (prefers-color-scheme: dark){
.tstack .toast{background:#151517;color:#fafafa;box-shadow:0 12px 32px -8px rgba(0,0,0,.6),0 0 0 1px #69696b}
.toast a:focus-visible,.toast__close:focus-visible,.toast__copy:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
}
`;

function closeButton(onDismiss: () => void): HTMLButtonElement {
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast__close";
  close.setAttribute("aria-label", panelText("toast.dismiss"));
  close.append(icon("close"));
  close.addEventListener("click", onDismiss);
  return close;
}

function toastShell(kind: ToastKind): { el: HTMLElement; body: HTMLElement; message: HTMLElement } {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const mark = document.createElement("span");
  mark.className = "toast__icon";
  mark.append(icon(KIND_ICON[kind]));
  const body = document.createElement("div");
  body.className = "toast__body";
  const message = document.createElement("div");
  message.className = "toast__message";
  body.append(message);
  el.append(mark, body);
  return { el, body, message };
}

/**
 * Appends the region to `layer`, after the panel's slot, so it paints over the panel. `store` is the shared toast store; `toast`
 * pushes a plain toast (used to confirm a copy) and honors `ui.toasts`.
 */
export function mountToastRegion(
  layer: HTMLElement,
  store: ToastStore,
  toast: (request: ToastRequest) => unknown,
): ToastRegion {
  const stack = document.createElement("div");
  stack.className = "tstack";
  const receipts = document.createElement("div");
  const storeItems = document.createElement("div");
  stack.append(receipts, storeItems);
  layer.querySelector(":scope > .toasts")?.remove();
  layer.append(stack);

  const shown = new Map<string, HTMLElement>();
  const hovered = new Set<string>();

  function buildStoreToast(view: ToastView): HTMLElement {
    const { el, body, message } = toastShell(view.kind);
    message.textContent = panelText(view.textCode);
    if (view.href !== undefined && view.hrefLabelCode !== undefined) {
      const link = document.createElement("a");
      link.href = view.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = panelText(view.hrefLabelCode);
      body.append(link);
    }
    el.append(closeButton(() => store.dismiss(view.id)));
    // Hover holds every timer; the hold is released on leave or removal.
    el.addEventListener("mouseenter", () => {
      if (hovered.has(view.id)) return;
      hovered.add(view.id);
      store.pause();
    });
    el.addEventListener("mouseleave", () => {
      if (!hovered.delete(view.id)) return;
      store.resume();
    });
    return el;
  }

  function renderStore(list: readonly ToastView[]): void {
    const live = new Set(list.map((view) => view.id));
    for (const [id, el] of shown) {
      if (live.has(id)) continue;
      if (hovered.delete(id)) store.resume();
      el.remove();
      shown.delete(id);
    }
    for (const view of list) {
      if (shown.has(view.id)) continue;
      const el = buildStoreToast(view);
      shown.set(view.id, el);
      storeItems.append(el);
    }
  }
  const unsubscribe = store.subscribe(renderStore);

  interface Slip {
    readonly key: string;
    readonly el: HTMLElement;
    timer: ReturnType<typeof setTimeout> | undefined;
    remaining: number;
    startedAt: number;
  }
  const slips: Slip[] = [];
  let holds = 0;

  function arm(slip: Slip): void {
    if (slip.timer !== undefined || holds > 0) return;
    slip.startedAt = Date.now();
    slip.timer = setTimeout(() => drop(slip), slip.remaining);
  }
  function disarm(slip: Slip): void {
    if (slip.timer === undefined) return;
    clearTimeout(slip.timer);
    slip.timer = undefined;
    slip.remaining = Math.max(0, slip.remaining - (Date.now() - slip.startedAt));
  }
  function drop(slip: Slip): void {
    const at = slips.indexOf(slip);
    if (at === -1) return;
    disarm(slip);
    slips.splice(at, 1);
    slip.el.remove();
  }

  async function copyReceipt(rows: readonly ReceiptRow[]): Promise<void> {
    const plain = rows.map((row) => `${panelText(row.labelCode)} ${row.copyValue ?? row.value}`).join("\n");
    try {
      await navigator.clipboard.writeText(plain);
      toast({ kind: "success", textCode: "toast.copied" });
    } catch {
      toast({ kind: "error", textCode: "toast.copy_failed" });
    }
  }

  return {
    receipt(request) {
      const key = request.rows.map((row) => `${row.labelCode}=${row.value}|${row.copyValue ?? ""}`).join("\n");
      if (slips.some((slip) => slip.key === key)) return false;
      const { el, body, message } = toastShell("success");
      const title = document.createElement("b");
      title.className = "toast__title";
      title.textContent = panelText(request.titleCode);
      message.append(title);
      if (request.bodyCode !== undefined) message.append(panelText(request.bodyCode));
      const slip = document.createElement("div");
      slip.className = "slip";
      for (const row of request.rows) {
        const line = document.createElement("div");
        line.textContent = `${panelText(row.labelCode)} ${row.value}`;
        slip.append(line);
      }
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "toast__copy";
      copy.textContent = panelText("toast.copy_receipt");
      copy.addEventListener("click", () => void copyReceipt(request.rows));
      body.append(slip, copy);

      const entry: Slip = { key, el, timer: undefined, remaining: RECEIPT_MS, startedAt: 0 };
      el.append(closeButton(() => drop(entry)));
      const hold = (): void => {
        holds++;
        for (const other of slips) disarm(other);
      };
      const release = (): void => {
        holds = Math.max(0, holds - 1);
        for (const other of slips) arm(other);
      };
      let held = false;
      el.addEventListener("mouseenter", () => {
        if (!held) {
          held = true;
          hold();
        }
      });
      el.addEventListener("mouseleave", () => {
        if (held) {
          held = false;
          release();
        }
      });

      slips.push(entry);
      receipts.append(el);
      while (slips.length > MAX_RECEIPTS) drop(slips[0] as Slip);
      arm(entry);
      return true;
    },
    clearReceipts() {
      for (const slip of [...slips]) drop(slip);
    },
    dispose() {
      unsubscribe();
      for (let i = 0; i < hovered.size; i++) store.resume();
      hovered.clear();
      for (const slip of [...slips]) drop(slip);
      shown.clear();
      stack.remove();
    },
  };
}
