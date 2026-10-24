/*
 * Lazy panel entry. The host loads it on first open or launcher hover/focus.
 * It is a separate bundle because the 12 KiB gzip budget (contracts-ade §1.4)
 * covers only the eager root: a static import would pull the panel shell,
 * sections and PANEL_CSS into it. The host reaches this module only through
 * dynamic import(), which is the one exception to ts-no-dynamic-import.
 */
import type { ActionResult, PanelDataSource, PanelView, RevokeOutcome, ViewResult } from "./data";
import { PANEL_VIEWS } from "./data";
import { livePanelData, onLivePanelDataChange } from "./panel-data-entry";
import type { PanelHandle, PanelOptions } from "./panel";
import { createPanel } from "./panel";
import { PANEL_CSS } from "./panel-styles";
import { PANEL_SECTIONS } from "./sections";
import type { HostContext, PanelClient, PanelSection } from "./slots";
import { viewLoading } from "./view-result";

/** Builds the panel and its stylesheet inside the host's open shadow root. */
export function mountPanel(root: ShadowRoot, options: PanelOptions): PanelHandle {
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  root.append(style);
  return createPanel(options);
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
    localNode: () => real?.localNode() ?? viewLoading(),
    localCopy: () => real?.localCopy() ?? viewLoading(),
    nodes: () => real?.nodes() ?? viewLoading(),
    storage: (options) => real?.storage(options) ?? viewLoading(),
    delegations: (cursor) => real?.delegations(cursor) ?? viewLoading(),
    revoke: (cid) => real?.revoke(cid) ?? NOT_READY,
    setLocalNodeEnabled: (enabled) => real?.setLocalNodeEnabled(enabled) ?? NOT_READY,
    get requests() {
      const source = real;
      return source?.requests ? () => source.requests?.() ?? viewLoading() : undefined;
    },
  } as PanelDataSource;
}

const wrappedClients = new WeakMap<PanelClient, PanelClient>();

/** The client a section sees: same methods and state, with `data` routed through the proxy. */
function sectionClient(client: PanelClient): PanelClient {
  let wrapped = wrappedClients.get(client);
  if (wrapped === undefined) {
    wrapped = Object.create(client, {
      data: { value: client.data ?? proxyFor(client), enumerable: true },
    }) as PanelClient;
    wrappedClients.set(client, wrapped);
  }
  return wrapped;
}

function withSectionClient(context: HostContext): HostContext {
  return {
    ...context,
    client: () => {
      const client = context.client();
      return client && sectionClient(client);
    },
  };
}

/** Sections offered for this context, in nav order. */
export function availableSections(context: HostContext): readonly PanelSection[] {
  const ctx = withSectionClient(context);
  return PANEL_SECTIONS.filter((section) => section.isAvailable(ctx)).map((section) => ({
    ...section,
    mount: (el, mountCtx) => section.mount(el, withSectionClient(mountCtx)),
  }));
}
