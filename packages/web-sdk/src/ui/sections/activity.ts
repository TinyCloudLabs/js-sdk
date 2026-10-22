import type { PanelSection } from "../slots";
import { mountPlaceholder } from "./placeholder";

/** Developer-mode only, as in the mockup. Shown only while a registered client sets developerMode. */
export const activitySection: PanelSection = {
  id: "activity",
  labelCode: "nav.activity",
  isAvailable: (ctx) => ctx.developerMode(),
  mount: mountPlaceholder,
};
