import { text } from "../strings";

/** Always available. Sections with no sign-in or developer gate use this. */
export const alwaysAvailable = (): boolean => true;

/**
 * Body for shell sections whose content lands in a later slice. The host sets
 * `data-section` on `el` before mount, so the title comes from the section id.
 */
export function mountPlaceholder(el: HTMLElement): () => void {
  const heading = document.createElement("h3");
  heading.className = "sec-title";
  heading.textContent = text(`nav.${el.dataset.section ?? ""}`);
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = text("section.placeholder");
  el.append(heading, note);
  return () => undefined;
}
