/*
 * Lazy panel entry. The host loads it on first open or launcher hover/focus.
 * It is a separate bundle because the 12 KiB gzip budget (contracts-ade §1.4)
 * covers only the eager root: a static import would pull the panel shell,
 * sections and PANEL_CSS into it. The host reaches this module only through
 * dynamic import(), which is the one exception to ts-no-dynamic-import.
 */
import type { LayoutOptions, NavItem, PanelHandle, PanelOptions, ShellLayout } from "./panel";
import { createPanel } from "./panel";
import { mountToastRegion, TOAST_REGION_CSS, type ReceiptRequest } from "./panel-toasts";
import { PANEL_CSS } from "./panel-styles";
import { PANEL_SECTIONS } from "./sections";
import { createSectionData } from "./section-data";
import { createSectionDialogs } from "./section-dialogs";
import { panelText } from "./strings-panel";
import type { HostContext, PanelSection, SectionContext, SectionId } from "./slots";
import type { ToastStore } from "./toast-store";

/** What the host passes on each render. The shell keeps the section between renders. */
export interface ShellView extends LayoutOptions {
  readonly open: boolean;
  readonly layout: ShellLayout;
  /** Section to show next. Undefined keeps the current one. */
  readonly section?: SectionId | undefined;
}

export interface ShellPanel extends PanelHandle {
  render(view: ShellView): void;
  /** Disposes the mounted section. The host calls it on unmount. */
  dispose(): void;
}

/**
 * Builds the panel and its stylesheet in the host's open shadow root. Owns section state and mounting.
 * `toasts` is the host's store: the host passes it so this chunk never imports the eager toasts module.
 */
export function mountPanel(root: ShadowRoot, options: Omit<PanelOptions, "onNavigate">, base: HostContext, toasts: ToastStore): ShellPanel {
  const style = document.createElement("style");
  style.textContent = PANEL_CSS + TOAST_REGION_CSS;
  root.append(style);

  let view: ShellView = { open: false, layout: "drawer", phone: false, showLayoutToggle: false };
  let active: SectionId | undefined;
  let disposers: Array<() => void> = [];
  let sectionEl: HTMLElement | undefined;
  let wasOpen = false;

  const handle = createPanel({
    ...options,
    onNavigate(id) {
      active = id;
      draw();
    },
  });
  const layer = root.querySelector<HTMLElement>(".layer");
  const region = layer ? mountToastRegion(layer, toasts, (request) => base.toast(request)) : undefined;
  const data = createSectionData(() => base.client()?.data);
  const dialogs = createSectionDialogs(() => sectionEl);
  const context: SectionContext = {
    ...base,
    text: panelText,
    data,
    layout: () => view.layout,
    sections: () => PANEL_SECTIONS.filter((section) => section.isAvailable(context)),
    requestRender: () => data.notify(),
    confirm: (request) => dialogs.confirm(request),
    openDrawer: (request) => dialogs.openDrawer(request),
    receipt: (request: ReceiptRequest) => base.toastsEnabled() && region !== undefined && region.receipt(request),
    closePanel: options.onClose,
    openSection(id) {
      active = id;
      draw();
    },
  };

  function closeSections(): void {
    dialogs.closeAll();
    sectionEl = undefined;
    for (const dispose of disposers) dispose();
    disposers = [];
  }

  /** Nav items for the sections on offer, each with its status as rail meta. */
  function navItems(available: readonly PanelSection[]): NavItem[] {
    return available.map((section) => {
      const status = section.status(context);
      return {
        id: section.id,
        labelCode: section.labelCode,
        icon: section.icon,
        meta: status === undefined ? undefined : (status.count ?? status.text),
      };
    });
  }

  /** Repaints rail meta in place. Statuses move with the cache, so this never remounts the section. */
  function paintNav(): void {
    handle.setNav(navItems(PANEL_SECTIONS.filter((section) => section.isAvailable(context))), active);
  }
  const offData = data.subscribe(paintNav);

  let offReset: (() => void) | undefined;
  function watchClient(): void {
    offReset?.();
    offReset = base.client()?.onReset(() => data.reset());
  }
  const offClient = base.onClientChange(() => {
    watchClient();
    data.reset();
  });
  watchClient();

  /** Lays out the shell and mounts exactly one available section while open. */
  function draw(): void {
    closeSections();
    const available = PANEL_SECTIONS.filter((section) => section.isAvailable(context));
    const current = available.find((section) => section.id === active) ?? available[0];
    active = current?.id;
    handle.setLayout(view.layout, { showLayoutToggle: view.showLayoutToggle, phone: view.phone });
    handle.setAppLabel(context.appLabel());
    handle.setNav(navItems(available), active);
    if (!view.open || !current) return;
    const el = document.createElement("section");
    el.className = "section";
    el.dataset.section = current.id;
    sectionEl = el;
    handle.main.replaceChildren(el);
    const dispose = current.mount(el, context);
    disposers.push(() => {
      dispose();
      el.remove();
    });
  }

  return Object.assign(handle, {
    render(next: ShellView) {
      view = next;
      if (next.section !== undefined) active = next.section;
      // Statuses are read while the panel is open, so a closed panel makes no requests.
      if (next.open && !wasOpen) data.start();
      else if (!next.open && wasOpen) data.stop();
      wasOpen = next.open;
      draw();
    },
    dispose() {
      closeSections();
      data.stop();
      offData();
      offReset?.();
      offClient();
      region?.dispose();
    },
  });
}
