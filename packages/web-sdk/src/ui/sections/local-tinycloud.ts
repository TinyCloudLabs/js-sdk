import type { PanelSection } from "../slots";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";

export const localTinycloudSection: PanelSection = {
  id: "local-tinycloud",
  labelCode: "nav.local-tinycloud",
  isAvailable: alwaysAvailable,
  mount: mountPlaceholder,
};
