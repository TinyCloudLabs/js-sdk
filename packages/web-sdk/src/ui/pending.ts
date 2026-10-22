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
  showError(retry: () => void): void;
}

export function createPendingPanel(onEscape: () => void): PendingPanel {
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

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = text("view.retry");
  retry.hidden = true;

  let onRetry: (() => void) | undefined;
  retry.addEventListener("click", () => {
    onRetry?.();
  });

  el.append(status, retry);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onEscape();
  });

  return {
    el,
    setOpen(open) {
      el.hidden = !open;
    },
    showLoading() {
      status.textContent = text("view.loading");
      retry.hidden = true;
    },
    showError(retryLoad) {
      onRetry = retryLoad;
      status.textContent = text("view.error");
      retry.hidden = false;
    },
  };
}
