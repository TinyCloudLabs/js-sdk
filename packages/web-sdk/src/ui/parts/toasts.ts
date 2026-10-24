import type { HostPart } from "../slots";
import { createToastStore, type ToastKind, type ToastSlipRow, type ToastStore, type ToastView } from "../toast-store";

/** Shared store: host.ts pushes here; the registered part renders it. */
export const toastStore: ToastStore = createToastStore();

const TOAST_CSS = `
.toasts{position:fixed;bottom:calc(var(--b) + 56px);display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 24px));pointer-events:none}
.layer[data-position="bottom-right"] .toasts{right:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-left"] .toasts{left:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-center"] .toasts{left:50%;transform:translateX(-50%)}
.toast{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid #d1d5db;border-left-width:4px;border-radius:8px;background:#fff;color:#111827;box-shadow:0 4px 12px rgba(0,0,0,.12);pointer-events:auto}
.toast--info{border-left-color:#2563eb}
.toast--success{border-left-color:#16a34a}
.toast--warning{border-left-color:#d97706}
.toast--error{border-left-color:#dc2626}
.toast__message{flex:1;min-width:0;overflow-wrap:anywhere}
.slip{margin-top:8px;padding:8px 0;border-top:2px dashed #71717a;border-bottom:2px dashed #71717a;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.slip>div{display:flex;justify-content:space-between;gap:12px}
.toast a{color:inherit;text-decoration:underline;white-space:nowrap}
.toast__close{border:0;background:transparent;color:inherit;cursor:pointer;padding:0;font:inherit;line-height:1;min-width:44px;min-height:44px;margin:-12px -10px -12px 0;display:inline-flex;align-items:center;justify-content:center}
.toast__icon{flex:none;padding-top:1px}
.toast__copy{display:inline-flex;align-items:center;min-height:44px;margin-top:2px;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;font:inherit;text-decoration:underline}
.toast a:focus-visible,.toast__close:focus-visible,.toast__copy:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
/* Dark candidate, app family (docs/brand/guide.md §4.1): surface #151517, ink #fafafa,
   hairline #69696b, warning #fbbd23. The guide has no dark value for info, success or
   error; the light stripes are kept, and each measures at least 3:1 on #151517. */
@media (prefers-color-scheme: dark){
.toast{border-top-color:#69696b;border-right-color:#69696b;border-bottom-color:#69696b;background:#151517;color:#fafafa}
.toast a:focus-visible,.toast__close:focus-visible,.toast__copy:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
.toast--warning{border-left-color:#fbbd23}
}
`;

/** Inline icon paths, one per toast kind, so the eager bundle carries no icon module. */
const TOAST_ICON: Record<ToastKind, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  success: '<path d="M5 12l5 5 9-10"/>',
  warning: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
  error: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
};

/** Renders `store` into the host layer. Exposed for tests with a short-duration store. */
export function createToastsPart(store: ToastStore): HostPart {
  return {
    id: "toasts",
    start(ctx, layer) {
      const style = document.createElement("style");
      style.textContent = TOAST_CSS;
      const stack = document.createElement("div");
      stack.className = "toasts";
      layer.append(style, stack);

      const items = new Map<string, HTMLElement>();
      const hovered = new Set<string>();

      function copyReceipt(rows: readonly ToastSlipRow[]): void {
        const plain = rows.map((row) => `${ctx.text(row.labelCode)} ${row.value}`).join("\n");
        void (async () => {
          try {
            await navigator.clipboard.writeText(plain);
            store.push({ kind: "success", textCode: "account.copied" });
          } catch {
            store.push({ kind: "error", textCode: "account.copy_failed" });
          }
        })();
      }

      function buildToast(view: ToastView): HTMLElement {
        const el = document.createElement("div");
        el.className = `toast toast--${view.kind}`;
        el.setAttribute("role", view.kind === "error" ? "alert" : "status");

        const icon = document.createElement("span");
        icon.className = "toast__icon";
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOAST_ICON[view.kind]}</svg>`;
        el.append(icon);

        const message = document.createElement("div");
        message.className = "toast__message";
        message.textContent = ctx.text(view.textCode);
        if (view.slip !== undefined) {
          const slip = document.createElement("div");
          slip.className = "slip";
          for (const row of view.slip) {
            const line = document.createElement("div");
            const label = document.createElement("span");
            label.textContent = ctx.text(row.labelCode);
            const value = document.createElement("span");
            value.textContent = row.value;
            line.append(label, value);
            slip.append(line);
          }
          message.append(slip);
          const rows = view.slip;
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "toast__copy";
          copy.textContent = ctx.text("toast.copy_receipt");
          copy.addEventListener("click", () => copyReceipt(rows));
          message.append(copy);
        }
        el.append(message);

        if (view.href !== undefined && view.hrefLabelCode !== undefined) {
          const link = document.createElement("a");
          link.href = view.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = ctx.text(view.hrefLabelCode);
          el.append(link);
        }

        const close = document.createElement("button");
        close.type = "button";
        close.className = "toast__close";
        close.setAttribute("aria-label", ctx.text("toast.dismiss"));
        close.textContent = "×";
        close.addEventListener("click", () => store.dismiss(view.id));
        el.append(close);

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

      function render(list: readonly ToastView[]): void {
        const live = new Set(list.map((view) => view.id));
        for (const [id, el] of items) {
          if (live.has(id)) continue;
          if (hovered.delete(id)) store.resume();
          el.remove();
          items.delete(id);
        }
        for (const view of list) {
          if (items.has(view.id)) continue;
          const el = buildToast(view);
          items.set(view.id, el);
          stack.append(el);
        }
      }

      const unsubscribe = store.subscribe(render);

      return () => {
        unsubscribe();
        for (let i = 0; i < hovered.size; i++) store.resume();
        hovered.clear();
        items.clear();
        stack.remove();
        style.remove();
      };
    },
  };
}

export const toasts: HostPart = createToastsPart(toastStore);
