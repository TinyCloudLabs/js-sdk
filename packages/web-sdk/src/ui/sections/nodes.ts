import type { PanelSection } from "../slots";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";

export const nodesSection: PanelSection = {
  id: "nodes",
  labelCode: "nav.nodes",
  isAvailable: alwaysAvailable,
  mount: mountPlaceholder,
};
