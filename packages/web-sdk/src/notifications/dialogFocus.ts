/**
 * Focus helpers shared by the prompt dialogs. Both prompts render in their own
 * open shadow root, so the focused element is found by walking shadow roots.
 */

const CONTROL_SELECTOR =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";

/** The element that has focus, descending into open shadow roots. */
export function deepActiveElement(): HTMLElement | null {
  let el: Element | null = document.activeElement;
  while (el instanceof HTMLElement && el.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el instanceof HTMLElement ? el : null;
}

/** Enabled controls inside a dialog's shadow root, in DOM order. */
export function focusableControls(root: ShadowRoot): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
}

/**
 * Index of the control that Tab (or Shift+Tab) moves to. `current` is -1 when
 * focus is not on a control (for example on the dialog container). Forward
 * wraps from the last control to the first; backward wraps from the first to
 * the last. Returns -1 when there are no controls.
 */
export function nextTabIndex(count: number, current: number, shift: boolean): number {
  if (count === 0) return -1;
  if (shift) return current <= 0 ? count - 1 : current - 1;
  return current < 0 || current >= count - 1 ? 0 : current + 1;
}

/**
 * Returns focus to the element that was focused before a prompt opened. It
 * restores only when focus is still inside the prompt (or was lost to the
 * body), so a page that moved focus elsewhere keeps its focus.
 */
export function restoreFocusTo(opener: HTMLElement | null, owner: ShadowRoot): void {
  if (!opener?.isConnected) return;
  const active = deepActiveElement();
  if (active === null || active === document.body || owner.contains(active)) {
    opener.focus();
  }
}

/**
 * True only when `el` is the element that receives a pointer at its own centre,
 * so a control under another element (an app overlay above the prompt) is not
 * activated. Checked when the control is activated, never cached.
 *
 * This is a hit test, not a visual check:
 * - An element that covers the control and receives pointer events (including
 *   one with opacity 0.3 or a translucent background) takes the hit, so the
 *   control is blocked.
 * - An element with `pointer-events:none` is skipped by elementFromPoint, so it
 *   does not block. Its appearance is not considered.
 * - Script that calls `button.click()` directly bypasses this check. That is
 *   page code, outside the scope of this gate.
 *
 * A zero-size, offscreen, or detached element returns false.
 */
export function isTopmostControl(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const root = el.getRootNode() as Partial<Document & ShadowRoot>;
  if (typeof root.elementFromPoint !== "function") return false;
  const hit = root.elementFromPoint.call(root, rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit !== null && el.contains(hit);
}
