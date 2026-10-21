import type { PanelSection } from "../slots";

/** Storage section arrives with D3. Not rendered until then. */
export const storageSection: PanelSection = {
  id: "storage",
  isAvailable: () => false,
  mount: () => () => undefined,
};
