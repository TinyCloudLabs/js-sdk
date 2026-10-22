import type { PanelSection } from "../slots";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";

export const accountSection: PanelSection = {
  id: "account",
  labelCode: "nav.account",
  isAvailable: alwaysAvailable,
  mount: mountPlaceholder,
};
