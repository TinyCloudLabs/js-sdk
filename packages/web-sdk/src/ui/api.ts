import { canRenderUi } from "./frame-guard";

/** Public `tc.ui` surface. */
export interface TinyCloudUI {
  /** Clears the hidden flag, shows the button (if `ui.button !== false`), and opens the panel. */
  open(): void;
  /** Closes the panel only. Never changes the hidden flag. */
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** False in iframes, opaque origins, SSR, no document, or when `ui: false`. */
  readonly available: boolean;
}

export interface UiTarget {
  open(): void;
  close(): void;
  isOpen(): boolean;
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
    open() {
      const target = getTarget();
      if (!target || !canRenderUi()) return;
      target.open();
    },
    close() {
      getTarget()?.close();
    },
    toggle() {
      if (api.isOpen) api.close();
      else api.open();
    },
  };
  return api;
}
