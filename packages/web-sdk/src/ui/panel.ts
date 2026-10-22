import { PANEL_ID } from "./button";
import type { SectionId, StatusCode } from "./slots";
import { text, type StringKey } from "./strings";

/** `drawer` is the sidebar overlay; `page` fills the host layer. */
export type ShellLayout = "drawer" | "page";

export interface NavItem {
  readonly id: SectionId;
  readonly labelCode: StringKey;
}

export interface PanelHandle {
  readonly el: HTMLElement;
  /** Holds the one mounted section while the shell is open. */
  readonly main: HTMLElement;
  setOpen(open: boolean): void;
  setLayout(layout: ShellLayout, showLayoutToggle: boolean): void;
  setNav(items: readonly NavItem[], active: SectionId | undefined): void;
  setStatus(status: StatusCode | null): void;
  focusFirst(): void;
}

export interface PanelOptions {
  readonly hideAvailable: boolean;
  onHide(): void;
  onClose(): void;
  onEscape(): void;
  onLayout(target: ShellLayout): void;
  onNavigate(id: SectionId): void;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "action";
  el.textContent = label;
  el.addEventListener("click", () => onClick());
  return el;
}

/**
 * Non-modal `role="dialog"` (`aria-modal="false"`). Rendered as a drawer or a
 * full page, chosen by `data-layout`. Escape is handled on the panel element only.
 */
export function createPanel(options: PanelOptions): PanelHandle {
  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.className = "panel";
  el.dataset.layout = "drawer";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "false");
  el.setAttribute("aria-label", text("button.aria"));
  el.hidden = true;
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    options.onEscape();
  });

  let nextLayout: ShellLayout = "page";
  const title = document.createElement("h2");
  title.className = "title";
  title.textContent = text("panel.title");
  const status = document.createElement("span");
  status.className = "status";
  status.hidden = true;

  const layoutToggle = actionButton("", () => options.onLayout(nextLayout));
  layoutToggle.hidden = true;
  const hide = options.hideAvailable ? actionButton(text("panel.hide"), () => options.onHide()) : undefined;
  const close = actionButton(text("panel.close"), () => options.onClose());
  const actions = document.createElement("div");
  actions.className = "head-actions";
  actions.append(layoutToggle);
  if (hide) actions.append(hide);
  actions.append(close);

  const head = document.createElement("header");
  head.className = "head";
  head.append(title, status, actions);

  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.setAttribute("aria-label", text("panel.sections"));
  const navButtons = new Map<SectionId, HTMLButtonElement>();

  const main = document.createElement("div");
  main.className = "main";

  el.append(head, nav, main);

  function navButton(item: NavItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-i";
    btn.dataset.section = item.id;
    const label = document.createElement("span");
    label.className = "nav-l";
    label.textContent = text(item.labelCode);
    btn.append(label);
    btn.addEventListener("click", () => options.onNavigate(item.id));
    return btn;
  }

  return {
    el,
    main,
    setOpen(open) {
      el.hidden = !open;
    },
    setLayout(layout, showLayoutToggle) {
      el.dataset.layout = layout;
      nextLayout = layout === "drawer" ? "page" : "drawer";
      layoutToggle.textContent = text(layout === "drawer" ? "panel.open_page" : "panel.show_sidebar");
      layoutToggle.hidden = !showLayoutToggle;
    },
    setNav(items, active) {
      const wanted = new Set(items.map((item) => item.id));
      for (const [id, btn] of navButtons) {
        if (wanted.has(id)) continue;
        btn.remove();
        navButtons.delete(id);
      }
      items.forEach((item, index) => {
        let btn = navButtons.get(item.id);
        if (!btn) {
          btn = navButton(item);
          navButtons.set(item.id, btn);
        }
        // Reorder only when a new item lands out of place, so focus on a
        // mounted button is not disturbed by unrelated updates.
        if (nav.children[index] !== btn) nav.insertBefore(btn, nav.children[index] ?? null);
        if (item.id === active) btn.setAttribute("aria-current", "page");
        else btn.removeAttribute("aria-current");
      });
    },
    setStatus(next) {
      status.hidden = next === null;
      status.textContent = next === null ? "" : text(`status.${next}`);
    },
    focusFirst() {
      (nav.querySelector<HTMLElement>('[aria-current="page"]') ?? close).focus();
    },
  };
}
