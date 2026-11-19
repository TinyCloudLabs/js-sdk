import { PANEL_ID } from "./ids";
import { text } from "./strings";

/**
 * Stands in for the panel until the lazy chunk loads. It carries the panel id so
 * the launcher's aria-controls resolves while loading, and it handles Escape the
 * way the panel does. It is eager: the root renders it before any panel code exists.
 */
export interface PendingPanel {
  readonly el: HTMLElement;
  setOpen(open: boolean): void;
  showLoading(): void;
  showError(reloadPage: () => void): void;
}

export function createPendingPanel(onClose: () => void): PendingPanel {
  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.className = "pending";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "false");
  el.setAttribute("aria-label", text("button.aria"));
  el.tabIndex = -1;
  el.hidden = true;

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = text("view.loading");

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = text("view.reloadPage");
  reload.hidden = true;

  let onReload: (() => void) | undefined;
  reload.addEventListener("click", () => {
    onReload?.();
  });

  // The close control comes first so it is reachable while the panel loads or fails to load.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pclose";
  close.setAttribute("aria-label", text("panel.close"));
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.addEventListener("click", onClose);

  el.append(close, status, reload);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  });

  return {
    el,
    setOpen(open) {
      el.hidden = !open;
    },
    showLoading() {
      status.textContent = text("view.loading");
      reload.hidden = true;
    },
    showError(reloadPage) {
      onReload = reloadPage;
      status.textContent = text("panel.loadError");
      reload.hidden = false;
    },
  };
}
