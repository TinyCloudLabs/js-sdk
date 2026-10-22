import type { PanelSection } from "../slots";
import { mountPlaceholder } from "./placeholder";

export const delegationsSection: PanelSection = {
  id: "delegations",
  labelCode: "nav.delegations",
  isAvailable: (ctx) => ctx.client()?.signedIn() === true,
  mount: mountPlaceholder,
};
