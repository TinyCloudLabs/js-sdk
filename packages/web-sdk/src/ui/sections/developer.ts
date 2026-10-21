import type { PanelSection } from "../slots";

/** Developer section arrives with A4/E3. Not rendered until then. */
export const developerSection: PanelSection = {
  id: "developer",
  isAvailable: () => false,
  mount: () => () => undefined,
};
