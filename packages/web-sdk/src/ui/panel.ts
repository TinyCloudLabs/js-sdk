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
  /** App name shown after "TinyCloud". Undefined hides it and the page back label. */
  setAppLabel(label: string | undefined): void;
  setNav(items: readonly NavItem[], active: SectionId | undefined): void;
  setStatus(status: StatusCode | null): void;
  focusFirst(): void;
}

export interface PanelOptions {
  onClose(): void;
  onEscape(): void;
  onLayout(target: ShellLayout): void;
  onNavigate(id: SectionId): void;
}

interface NavEntry {
  readonly btn: HTMLButtonElement;
  readonly index: HTMLSpanElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";

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

  let layout: ShellLayout = "drawer";
  let appLabel: string | undefined;
  let nextLayout: ShellLayout = "page";

  const title = document.createElement("h2");
  title.className = "title";
  title.textContent = text("panel.title");
  const ctx = document.createElement("span");
  ctx.className = "ctx";
  ctx.hidden = true;
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.append(title, ctx);

  const status = document.createElement("span");
  status.className = "status";
  status.hidden = true;

  const layoutToggle = actionButton("", () => options.onLayout(nextLayout));
  layoutToggle.hidden = true;

  // One close control. Drawer: icon button. Page: text action that returns to the host app.
  const close = document.createElement("button");
  close.type = "button";
  close.addEventListener("click", () => options.onClose());
  const glyph = document.createElementNS(SVG_NS, "svg");
  glyph.setAttribute("viewBox", "0 0 24 24");
  glyph.setAttribute("aria-hidden", "true");
  const glyphPath = document.createElementNS(SVG_NS, "path");
  glyphPath.setAttribute("d", "M6 6l12 12M18 6L6 18");
  glyph.append(glyphPath);

  function paintClose(): void {
    if (layout === "drawer") {
      close.className = "icon-btn ring";
      close.setAttribute("aria-label", text("panel.close"));
      close.replaceChildren(glyph);
      return;
    }
    close.className = "action";
    close.removeAttribute("aria-label");
    close.textContent = appLabel === undefined ? text("panel.close") : `${text("panel.back")} ${appLabel}`;
  }
  paintClose();

  const actions = document.createElement("div");
  actions.className = "head-actions";
  actions.append(layoutToggle, close);

  const head = document.createElement("header");
  head.className = "head";
  head.append(brand, status, actions);

  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.setAttribute("aria-label", text("panel.sections"));
  const navButtons = new Map<SectionId, NavEntry>();

  const main = document.createElement("div");
  main.className = "main";

  el.append(head, nav, main);

  function navButton(item: NavItem): NavEntry {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-i";
    btn.dataset.section = item.id;
    // Index is decorative (page rail only); aria-hidden keeps the accessible name equal to the label.
    const index = document.createElement("span");
    index.className = "nav-n";
    index.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "nav-l";
    label.textContent = text(item.labelCode);
    btn.append(index, label);
    btn.addEventListener("click", () => options.onNavigate(item.id));
    return { btn, index };
  }

  return {
    el,
    main,
    setOpen(open) {
      el.hidden = !open;
    },
    setLayout(next, showLayoutToggle) {
      layout = next;
      el.dataset.layout = next;
      nextLayout = next === "drawer" ? "page" : "drawer";
      layoutToggle.textContent = text(next === "drawer" ? "panel.open_page" : "panel.show_sidebar");
      layoutToggle.hidden = !showLayoutToggle;
      paintClose();
    },
    setAppLabel(label) {
      appLabel = label;
      ctx.hidden = label === undefined;
      ctx.textContent = label === undefined ? "" : `${text("panel.in")} ${label}`;
      paintClose();
    },
    setNav(items, active) {
      const wanted = new Set(items.map((item) => item.id));
      for (const [id, entry] of navButtons) {
        if (wanted.has(id)) continue;
        entry.btn.remove();
        navButtons.delete(id);
      }
      items.forEach((item, position) => {
        let entry = navButtons.get(item.id);
        if (!entry) {
          entry = navButton(item);
          navButtons.set(item.id, entry);
        }
        entry.index.textContent = String(position + 1).padStart(2, "0");
        // Reorder only when a new item lands out of place, so focus on a
        // mounted button is not disturbed by unrelated updates.
        if (nav.children[position] !== entry.btn) nav.insertBefore(entry.btn, nav.children[position] ?? null);
        if (item.id === active) entry.btn.setAttribute("aria-current", "page");
        else entry.btn.removeAttribute("aria-current");
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
