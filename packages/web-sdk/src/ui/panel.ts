import { PANEL_ID } from "./button";
import type { StatusCode } from "./slots";
import { text } from "./strings";

export interface PanelView {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  setOpen(open: boolean): void;
  setStatus(status: StatusCode | null): void;
  focusFirst(): void;
}

export interface PanelOptions {
  readonly hideAvailable: boolean;
  onHide(): void;
  onClose(): void;
  onEscape(): void;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "action";
  el.textContent = label;
  el.addEventListener("click", () => onClick());
  return el;
}

/** Non-modal dialog. Escape is handled on the panel element only, never on window. */
export function createPanel(options: PanelOptions): PanelView {
  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.className = "panel";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "false");
  el.setAttribute("aria-label", text("button.aria"));
  el.hidden = true;
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    options.onEscape();
  });

  const header = document.createElement("div");
  header.className = "header";
  const title = document.createElement("h2");
  title.className = "title";
  title.textContent = text("panel.title");
  const status = document.createElement("span");
  status.className = "status";
  status.hidden = true;
  header.append(title, status);

  const body = document.createElement("div");
  body.className = "body";

  const footer = document.createElement("div");
  footer.className = "footer";
  const hide = options.hideAvailable ? actionButton(text("panel.hide"), () => options.onHide()) : undefined;
  const close = actionButton(text("panel.close"), () => options.onClose());
  if (hide) footer.append(hide);
  footer.append(close);

  el.append(header, body, footer);

  return {
    el,
    body,
    setOpen(open) {
      el.hidden = !open;
    },
    setStatus(next) {
      status.hidden = next === null;
      status.textContent = next === null ? "" : text(`status.${next}`);
    },
    focusFirst() {
      (hide ?? close).focus();
    },
  };
}
