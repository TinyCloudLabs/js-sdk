import type { PanelSection } from "../slots";
import { developerSection } from "./developer";
import { storageSection } from "./storage";
import { syncSection } from "./sync";

/** Static, ordered. Each slice replaces the body of its own file only. */
export const PANEL_SECTIONS: readonly PanelSection[] = [syncSection, storageSection, developerSection];
