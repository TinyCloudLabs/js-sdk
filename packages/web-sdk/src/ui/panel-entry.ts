/*
 * Lazy panel entry. The host loads it on first open or launcher hover/focus.
 * It is a separate bundle because the 12 KiB gzip budget (contracts-ade §1.4)
 * covers only the eager root: a static import would pull the panel shell,
 * sections and PANEL_CSS into it. The host reaches this module only through
 * dynamic import(), which is the one exception to ts-no-dynamic-import.
 */
import type { PanelHandle, PanelOptions } from "./panel";
import { createPanel } from "./panel";
import { PANEL_CSS } from "./panel-styles";
import { PANEL_SECTIONS } from "./sections";
import type { HostContext, PanelSection } from "./slots";

/** Builds the panel and its stylesheet inside the host's open shadow root. */
export function mountPanel(root: ShadowRoot, options: PanelOptions): PanelHandle {
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  root.append(style);
  return createPanel(options);
}

/** Sections offered for this context, in nav order. */
export function availableSections(context: HostContext): readonly PanelSection[] {
  return PANEL_SECTIONS.filter((section) => section.isAvailable(context));
}
