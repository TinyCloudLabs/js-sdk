/*
 * Modal behaviour of the drawer, in the lazy panel chunk. While the panel is open as the desktop drawer
 * it dims the host page (the scrim), keeps Tab and focus inside the panel, and gives focus back to the
 * page element that had it when the panel opened. The host page's DOM is never touched: no `inert`, no
 * attributes on its elements. The page layout and phones get none of this.
 *
 * The scrim is shown by CSS from the host layer's `data-panel-open` and `data-layout` attributes, so the
 * eager host needs no code for it. Everything here only has to agree with those attributes.
 */
import { nextTabIndex } from "../notifications/dialogFocus";
import { hasMountedPrompt, PROMPT_SETTLED_EVENT } from "./parts/prompts";

const CONTROLS =
  'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

export interface DrawerModal {
  /** The shell's view: `open` is the panel's state, `active` is open as the drawer. Call before the section draws. */
  sync(open: boolean, active: boolean): void;
  /** After a close, returns focus to the page element that had it before the drawer opened. False when there is none. */
  restoreFocus(): boolean;
  dispose(): void;
}

/** Rendered controls only: CSS-hidden ones (the phone menu on desktop) cannot take focus. */
function shown(el: HTMLElement): boolean {
  return typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : el.closest("[hidden]") === null;
}

/**
 * `layer` is the host layer, `panel` the shell element. `dismiss` closes the panel the way its own close
 * control does. Prompts the SDK raises (they mount in the layer after the panel) keep their own focus.
 */
export function mountDrawerModal(root: ShadowRoot, layer: HTMLElement, panel: HTMLElement, dismiss: () => void): DrawerModal {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.setAttribute("aria-hidden", "true");
  scrim.addEventListener("click", dismiss);
  // Behind the panel, above the launcher: the scrim goes where the panel will be put.
  const standIn = layer.querySelector(":scope > .pending");
  if (standIn) standIn.before(scrim);
  else layer.append(scrim);

  let open = false;
  let active = false;
  let opener: HTMLElement | undefined;
  let returnTo: HTMLElement | undefined;
  let lastInside: HTMLElement | undefined;
  let pulling = false;

  const toasts = () => layer.querySelector<HTMLElement>(":scope > .tstack");
  /** What Tab cycles through: the panel, then the toasts' controls, in document order. */
  function controls(): HTMLElement[] {
    const found = [...Array.from(panel.querySelectorAll<HTMLElement>(CONTROLS)), ...Array.from(toasts()?.querySelectorAll<HTMLElement>(CONTROLS) ?? [])];
    return found.filter(shown);
  }
  const inScope = (el: Element | null): boolean => el !== null && (panel.contains(el) || (toasts()?.contains(el) ?? false));

  function onKeydown(event: KeyboardEvent): void {
    if (!active || hasMountedPrompt()) return;
    const current = root.activeElement;
    if (!inScope(current)) return;
    if (event.key === "Escape") {
      // The panel handles its own Escape; this is the toasts' share of it.
      if (!panel.contains(current)) dismiss();
      return;
    }
    if (event.key !== "Tab" || current === null) return;
    const list = controls();
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    // Only the ends need help; everywhere else the browser's own order is already inside the scope.
    const pastLast = current === last || Boolean(last.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING);
    const beforeFirst = current === first || Boolean(first.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_PRECEDING);
    if (!event.shiftKey && pastLast) {
      event.preventDefault();
      list[nextTabIndex(list.length, list.length - 1, false)]?.focus();
    } else if (event.shiftKey && beforeFirst) {
      event.preventDefault();
      list[nextTabIndex(list.length, 0, true)]?.focus();
    }
  }

  /** Puts focus back on the control that had it inside the panel, else the first control. */
  function pullBack(): void {
    if (pulling) return;
    pulling = true;
    try {
      const back = lastInside?.isConnected && inScope(lastInside) && shown(lastInside) ? lastInside : controls()[0];
      back?.focus();
    } finally {
      pulling = false;
    }
  }

  /** Focus that lands on a page element goes back into the panel. Focus inside the host's own layer is judged by `onLayerFocus`. */
  function onPageFocus(event: FocusEvent): void {
    if (!hasMountedPrompt() && event.target !== root.host) pullBack();
  }

  /** Inside the layer: the panel and its toasts are remembered; the launcher under the scrim is sent back; a prompt above the panel keeps focus. */
  function onLayerFocus(event: FocusEvent): void {
    if (pulling || hasMountedPrompt()) return;
    const target = event.target as HTMLElement;
    if (inScope(target)) lastInside = target;
    else if (target.matches(".button")) pullBack();
  }

  /** Removing the focused node need not fire focusin/blur (notably in Chromium). */
  function focusWasLost(): boolean {
    const focused = document.activeElement;
    return focused === null || focused === document.body || (focused === root.host && root.activeElement === null);
  }

  // A connected control may be temporarily disabled and restore its own focus when enabled again.
  function recoverLostFocus(): void {
    if (!active || hasMountedPrompt() || !lastInside || lastInside.isConnected || !focusWasLost()) return;
    const dialog = panel.querySelector<HTMLElement>('[role="alertdialog"],.drawer');
    const dialogButton = dialog && shown(dialog) ? Array.from(dialog.querySelectorAll<HTMLElement>(CONTROLS)).find(shown) : undefined;
    const toastButton = Array.from(toasts()?.querySelectorAll<HTMLElement>(CONTROLS) ?? []).find(shown);
    const main = panel.querySelector<HTMLElement>(".main");
    const section = main?.querySelector<HTMLElement>(".sec-title") ?? main?.firstElementChild;
    const target = dialogButton ?? toastButton ?? (section instanceof HTMLElement ? section : controls()[0]);
    if (target && target === section) target.tabIndex = -1;
    target?.focus();
  }

  const observer = new (root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver)(() => recoverLostFocus());
  function onLayerFocusOut(event: FocusEvent): void {
    if (event.relatedTarget === null) queueMicrotask(recoverLostFocus);
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (!active || hasMountedPrompt() || event.key !== "Escape" || event.composedPath().includes(layer)) return;
    if (event.target !== document.body && event.target !== document.documentElement) return;
    queueMicrotask(() => {
      if (!active || hasMountedPrompt() || event.defaultPrevented) return;
      const dialog = panel.querySelector<HTMLElement>('[role="alertdialog"],.drawer');
      if (dialog && shown(dialog)) {
        Array.from(dialog.querySelectorAll<HTMLElement>(CONTROLS)).find(shown)?.focus();
      } else {
        dismiss();
      }
    });
  }


  // A delayed panel has no prior focused control for the prompt to restore. Claim focus once the prompt settles.
  function onPromptSettled(): void {
    queueMicrotask(() => {
      if (active && !hasMountedPrompt() && !inScope(root.activeElement)) pullBack();
    });
  }
  layer.addEventListener(PROMPT_SETTLED_EVENT, onPromptSettled);

  layer.addEventListener("keydown", onKeydown);

  function hold(on: boolean): void {
    if (on) {
      lastInside = undefined;
      document.addEventListener("focusin", onPageFocus, true);
      layer.addEventListener("focusin", onLayerFocus);
      layer.addEventListener("focusout", onLayerFocusOut);
      document.addEventListener("keydown", onDocumentKeydown, true);
      observer.observe(layer, { childList: true, subtree: true });
    } else {
      document.removeEventListener("focusin", onPageFocus, true);
      layer.removeEventListener("focusin", onLayerFocus);
      layer.removeEventListener("focusout", onLayerFocusOut);
      document.removeEventListener("keydown", onDocumentKeydown, true);
      observer.disconnect();
    }
  }

  return {
    sync(nextOpen, nextActive) {
      if (nextOpen && !open) {
        const page = document.activeElement;
        opener = page instanceof HTMLElement && page !== root.host && page !== document.body ? page : undefined;
        returnTo = undefined;
      } else if (!nextOpen && open) {
        returnTo = active ? opener : undefined;
        opener = undefined;
      }
      open = nextOpen;
      if (nextActive !== active) {
        active = nextActive;
        hold(active);
      }
    },
    restoreFocus() {
      const target = returnTo;
      returnTo = undefined;
      if (!target?.isConnected) return false;
      target.focus();
      return true;
    },
    dispose() {
      hold(false);
      layer.removeEventListener("keydown", onKeydown);
      layer.removeEventListener(PROMPT_SETTLED_EVENT, onPromptSettled);
      scrim.remove();
    },
  };
}
