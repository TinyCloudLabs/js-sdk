/*
 * Lazy panel entry. The host loads it on first open or launcher hover/focus.
 * It is a separate bundle because the 12 KiB gzip budget (contracts-ade §1.4)
 * covers only the eager root: a static import would pull the panel shell,
 * sections and PANEL_CSS into it. The host reaches this module only through
 * dynamic import(), which is the one exception to ts-no-dynamic-import.
 */
import type { ActionResult, PanelDataSource, PanelView, RevokeOutcome } from "./data";
import { PANEL_VIEWS } from "./data";
import type { LayoutOptions, NavItem, PanelHandle, PanelOptions, ShellLayout } from "./panel";
import { livePanelData, onLivePanelDataChange } from "./panel-data-entry";
import { createPanel } from "./panel";
import { mountDrawerModal } from "./panel-modal";
import { mountToastRegion, TOAST_REGION_CSS, type ReceiptRequest } from "./panel-toasts";
import { PANEL_CSS } from "./panel-styles";
import { PANEL_SECTIONS } from "./sections";
import { createSectionData } from "./section-data";
import { createSectionDialogs } from "./section-dialogs";
import { createSignOutGuard } from "./sign-out-purge";
import { panelText } from "./strings-panel";
import type { HostContext, PanelClient, PanelSection, SectionContext, SectionId } from "./slots";
import type { ToastStore } from "./toast-store";
import { viewLoading } from "./view-result";

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
  /** After a close that returns focus: puts it back on the page element that had it before the drawer opened. False when there is none. */
  restoreFocus(): boolean;
}

const NOT_READY: ActionResult & RevokeOutcome = { ok: false, code: "stale" };

/**
 * The client's data as sections see it. Before the live source is armed, reads
 * return loading and actions fail as stale. Once armed (or dropped on reset),
 * every subscriber gets each view so sections re-read.
 */
function proxyFor(client: PanelClient): PanelDataSource {
  const listeners = new Set<(view: PanelView) => void>();
  const forward = (view: PanelView): void => {
    for (const cb of [...listeners]) cb(view);
  };
  let real: PanelDataSource | undefined;
  let offReal: (() => void) | undefined;
  const follow = (): void => {
    const next = livePanelData(client);
    if (next === real) return;
    offReal?.();
    real = next;
    offReal = next?.subscribe(forward);
    for (const view of PANEL_VIEWS) forward(view);
  };
  onLivePanelDataChange(client, follow);
  follow();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    account: () => real?.account() ?? viewLoading(),
    knownDid: () => real?.knownDid?.(),
    localNode: () => real?.localNode() ?? viewLoading(),
    localCopy: () => real?.localCopy() ?? viewLoading(),
    nodes: () => real?.nodes() ?? viewLoading(),
    storage: (options) => real?.storage(options) ?? viewLoading(),
    delegations: (cursor) => real?.delegations(cursor) ?? viewLoading(),
    revoke: (cid) => real?.revoke(cid) ?? NOT_READY,
    setLocalNodeEnabled: (enabled) => real?.setLocalNodeEnabled(enabled) ?? NOT_READY,
  } as PanelDataSource;
}

const wrappedClients = new WeakMap<PanelClient, PanelClient>();

/**
 * The client a section sees: same methods and state, with `data` routed through the proxy while
 * signed in. Signed out there is no live source to wait for, so a client without its own data
 * has none, and sections show their no-data state instead of a loading line that never ends.
 */
function sectionClient(client: PanelClient): PanelClient {
  let wrapped = wrappedClients.get(client);
  if (wrapped === undefined) {
    // One proxy per client: sections compare `data.source` between paints, and a new object per read looks like a changed account.
    let proxy: PanelDataSource | undefined;
    wrapped = Object.create(client, {
      data: {
        get: () => client.data ?? (client.signedIn() ? (proxy ??= proxyFor(client)) : undefined),
        enumerable: true,
      },
    }) as PanelClient;
    wrappedClients.set(client, wrapped);
  }
  return wrapped;
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
  const modal = layer ? mountDrawerModal(root, layer, handle.el, options.onClose) : undefined;
  /** The client as sections see it: `data` routes through the proxy until the live source is armed. */
  const seen = (): PanelClient | undefined => {
    const client = base.client();
    return client && sectionClient(client);
  };
  const data = createSectionData(() => seen()?.data);
  const dialogs = createSectionDialogs(() => sectionEl);
  const guardSignOut = createSignOutGuard((request) => base.toast(request));
  const context: SectionContext = {
    ...base,
    // Sections see the client with sign-out removing the local copy once the session has ended.
    client: () => guardSignOut(seen()),
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

  /**
   * An account change (sign-out, account switch, client change) invalidates everything keyed by the
   * old account: cached reads and in-flight ones (generation), open confirm boxes and drawers
   * (their callbacks hold the old account's ids), and receipt slips.
   */
  function accountChanged(): void {
    data.reset();
    dialogs.closeAll();
    region?.clearReceipts();
  }

  let offReset: (() => void) | undefined;
  function watchClient(): void {
    offReset?.();
    offReset = base.client()?.onReset(accountChanged);
  }
  const offClient = base.onClientChange(() => {
    watchClient();
    accountChanged();
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
      modal?.sync(next.open, next.open && next.layout === "drawer");
      if (next.open && !wasOpen) data.start();
      else if (!next.open && wasOpen) data.stop();
      wasOpen = next.open;
      draw();
    },
    restoreFocus: () => modal?.restoreFocus() ?? false,
    dispose() {
      closeSections();
      data.stop();
      offData();
      offReset?.();
      offClient();
      region?.dispose();
      modal?.dispose();
    },
  });
}
