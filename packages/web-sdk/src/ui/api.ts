import { canRenderUi } from "./frame-guard";
import type { SectionId } from "./slots";

/** Public `tc.ui` surface. */
export interface TinyCloudUI {
  /**
   * Clears the hidden flag, shows the button (if `ui.button !== false`), and opens
   * the sidebar. `section` picks the starting section; unknown or unavailable ids
   * fall back to the first available section. `ui.mode: "page"` opens the full page.
   */
  open(section?: SectionId): void;
  /** Like `open()` but opens the full page. Under `ui.mode: "sidebar"` it opens the sidebar. */
  openPage(section?: SectionId): void;
  /** Closes the panel only. Never changes the hidden flag. */
  close(): void;
  toggle(): void;
  /**
   * Shows or hides the floating button now. `true` shows it even under `ui.button: false` for this page
   * session and clears the persisted hidden flag. `false` hides it without writing that flag. The SDK
   * does not persist the choice: the host app calls this on load from its own setting. `open()`,
   * `openPage()` and `toggle()` work whether the button is shown or not.
   */
  setButtonVisible(visible: boolean): void;
  readonly isOpen: boolean;
  /** False in iframes, opaque origins, SSR, no document, or when `ui: false`. */
  readonly available: boolean;
}

export interface UiTarget {
  open(section?: SectionId): void;
  openPage(section?: SectionId): void;
  close(): void;
  isOpen(): boolean;
  setButtonVisible(visible: boolean): void;
}

/**
 * `getTarget` returns undefined when this client is not registered (ui:false,
 * version mismatch, or unregistered). Every method is then a silent no-op.
 */
export function createUiApi(getTarget: () => UiTarget | undefined): TinyCloudUI {
  const api: TinyCloudUI = {
    get available() {
      return getTarget() !== undefined && canRenderUi();
    },
    get isOpen() {
      return getTarget()?.isOpen() ?? false;
    },
    open(section) {
      const target = getTarget();
      if (!target || !canRenderUi()) return;
      target.open(section);
    },
    openPage(section) {
      const target = getTarget();
      if (!target || !canRenderUi()) return;
      target.openPage(section);
    },
    close() {
      getTarget()?.close();
    },
    toggle() {
      if (api.isOpen) api.close();
      else api.open();
    },
    setButtonVisible(visible) {
      const target = getTarget();
      if (!target || !canRenderUi()) return;
      target.setButtonVisible(visible);
    },
  };
  return api;
}
