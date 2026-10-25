import type { StatusCode } from "./slots";
import { PANEL_ID } from "./ids";
import { text } from "./strings";

/** Neutral sliders glyph. currentColor, no fills. */
const GLYPH_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M4 7h10M18 7h2M4 17h2M10 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '<circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<circle cx="8" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  "</svg>";

export interface ButtonView {
  readonly el: HTMLButtonElement;
  setExpanded(expanded: boolean): void;
  setHidden(hidden: boolean): void;
  setStatus(status: StatusCode | null): void;
  focus(): void;
}

export function createButton(onActivate: () => void, onPreload: () => void): ButtonView {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "button";
  el.setAttribute("aria-label", text("button.aria"));
  el.setAttribute("aria-expanded", "false");
  el.setAttribute("aria-controls", PANEL_ID);
  el.innerHTML = GLYPH_SVG;

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.hidden = true;
  el.append(dot);

  el.addEventListener("click", () => onActivate());
  // Hover or focus starts the panel chunk early; the click still does the real work.
  el.addEventListener("pointerenter", () => onPreload());
  el.addEventListener("focus", () => onPreload());

  return {
    el,
    setExpanded(expanded) {
      el.setAttribute("aria-expanded", String(expanded));
    },
    setHidden(hidden) {
      el.hidden = hidden;
    },
    setStatus(status) {
      dot.hidden = status === null;
      if (status === null) dot.removeAttribute("data-status");
      else dot.setAttribute("data-status", status);
    },
    focus() {
      el.focus();
    },
  };
}
