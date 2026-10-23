import { PANEL_ID } from "./ids";
import type { SectionId, StatusCode } from "./slots";
import { text, type StringKey } from "./strings";

/** `drawer` is the sidebar overlay; `page` fills the host layer. */
export type ShellLayout = "drawer" | "page";

export interface NavItem {
  readonly id: SectionId;
  readonly labelCode: StringKey;
}

export interface LayoutOptions {
  /** Shows the switch control. Callers hide it on phones and when `ui.mode` fixes the layout. */
  readonly showLayoutToggle: boolean;
  /** Phone: the close control is a 44px icon, never the text back action. */
  readonly phone: boolean;
}

export interface PanelHandle {
  readonly el: HTMLElement;
  /** Holds the one mounted section while the shell is open. */
  readonly main: HTMLElement;
  setOpen(open: boolean): void;
  setLayout(layout: ShellLayout, options: LayoutOptions): void;
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
  readonly pick: HTMLButtonElement;
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

  let layout: ShellLayout = "drawer";
  let phone = false;
  let appLabel: string | undefined;
  let nextLayout: ShellLayout = "page";
  let menuOpen = false;

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

  // One close control. Icon on drawers and phones; on desktop pages, a text action back to the host app.
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
    if (layout === "drawer" || phone) {
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

  // Phone section menu: a 44px button that opens a list of the sections.
  // Hidden on desktop by CSS; shown only under `.layer[data-phone]`.
  const menuId = `${PANEL_ID}-menu`;
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "icon-btn ring menu-btn";
  menuBtn.setAttribute("aria-label", text("panel.sections"));
  menuBtn.setAttribute("aria-controls", menuId);
  menuBtn.setAttribute("aria-expanded", "false");
  const burger = document.createElementNS(SVG_NS, "svg");
  burger.setAttribute("viewBox", "0 0 24 24");
  burger.setAttribute("aria-hidden", "true");
  const burgerPath = document.createElementNS(SVG_NS, "path");
  burgerPath.setAttribute("d", "M4 7h16M4 12h16M4 17h16");
  burger.append(burgerPath);
  menuBtn.append(burger);

  const menu = document.createElement("div");
  menu.id = menuId;
  menu.className = "menu";
  menu.hidden = true;

  const menuWrap = document.createElement("div");
  menuWrap.className = "menu-wrap";
  menuWrap.append(menuBtn, menu);

  const actions = document.createElement("div");
  actions.className = "head-actions";
  actions.append(menuWrap, layoutToggle, close);

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

  function setMenuOpen(open: boolean): void {
    menuOpen = open;
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
  }

  function focusSection(): void {
    // Some sections render no heading; the section container is always mounted.
    const target = main.querySelector<HTMLElement>(".sec-title") ?? main.firstElementChild;
    if (!(target instanceof HTMLElement)) return;
    target.tabIndex = -1;
    target.focus();
  }

  function choose(id: SectionId): void {
    setMenuOpen(false);
    options.onNavigate(id);
    focusSection();
  }

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

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "menu-i";
    pick.dataset.section = item.id;
    pick.textContent = text(item.labelCode);
    pick.addEventListener("click", () => choose(item.id));
    return { btn, index, pick };
  }

  menuBtn.addEventListener("click", () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    setMenuOpen(true);
    const target = menu.querySelector<HTMLElement>('[aria-current="page"]') ?? menu.querySelector<HTMLElement>("button");
    target?.focus();
  });
  // Tabbing out of the menu closes it; focus moving inside the wrapper keeps it open.
  menuWrap.addEventListener("focusout", (event) => {
    if (!menuOpen) return;
    if (event.relatedTarget instanceof Node && menuWrap.contains(event.relatedTarget)) return;
    setMenuOpen(false);
  });

  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    // Escape closes the section menu first; a second Escape closes the page.
    if (menuOpen) {
      menuBtn.focus();
      setMenuOpen(false);
      return;
    }
    options.onEscape();
  });

  return {
    el,
    main,
    setOpen(open) {
      el.hidden = !open;
      if (!open) setMenuOpen(false);
    },
    setLayout(next, options) {
      layout = next;
      phone = options.phone;
      el.dataset.layout = next;
      nextLayout = next === "drawer" ? "page" : "drawer";
      layoutToggle.textContent = text(next === "drawer" ? "panel.open_page" : "panel.show_sidebar");
      layoutToggle.hidden = !options.showLayoutToggle;
      if (!phone) setMenuOpen(false);
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
        entry.pick.remove();
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
        if (menu.children[position] !== entry.pick) menu.insertBefore(entry.pick, menu.children[position] ?? null);
        const current = item.id === active;
        for (const node of [entry.btn, entry.pick]) {
          if (current) node.setAttribute("aria-current", "page");
          else node.removeAttribute("aria-current");
        }
      });
    },
    setStatus(next) {
      status.hidden = next === null;
      status.textContent = next === null ? "" : text(`status.${next}`);
    },
    focusFirst() {
      if (phone) {
        menuBtn.focus();
      } else {
        (nav.querySelector<HTMLElement>('[aria-current="page"]') ?? close).focus();
      }
    },
  };
}
