import type { PanelSection } from "../slots";

/** Replaced by the sync section implementation. Not rendered until then. */
export const syncSection: PanelSection = {
  id: "sync",
  isAvailable: () => false,
  mount: () => () => undefined,
};
