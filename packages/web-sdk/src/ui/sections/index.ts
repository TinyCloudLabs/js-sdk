import type { PanelSection } from "../slots";
import { accountSection } from "./account";
import { activitySection } from "./activity";
import { delegationsSection } from "./delegations";
import { localTinycloudSection } from "./local-tinycloud";
import { nodesSection } from "./nodes";
import { storageSection } from "./storage";
import { syncSection } from "./sync";

/** Static, ordered as the nav lists them. Each slice replaces the body of its own file only. */
export const PANEL_SECTIONS: readonly PanelSection[] = [
  accountSection,
  localTinycloudSection,
  syncSection,
  delegationsSection,
  nodesSection,
  storageSection,
  activitySection,
];
