import type { PermissionRequestModalOptions, PermissionRequestResult } from "./PermissionRequestModal";
import type { SpaceCreationModalOptions, SpaceCreationResult } from "./SpaceCreationModal";
import type { PromptScope } from "../ui/parts/prompts";

/**
 * Where the lazily loaded dialog module leaves itself once it has run. Both sides read the key off
 * `globalThis`, so the eager caller and the lazy chunk (and any other bundled copy of the SDK on the page)
 * see the same one instance without importing each other.
 */
export const MODALS_KEY = Symbol.for("tinycloud.web-sdk.modals");

export interface LoadedModals {
  showPermissionRequestModal(options: PermissionRequestModalOptions, scope?: PromptScope): Promise<PermissionRequestResult>;
  showSpaceCreationModal(options: SpaceCreationModalOptions, scope?: PromptScope): Promise<SpaceCreationResult>;
  closeActiveModal(): void;
}
