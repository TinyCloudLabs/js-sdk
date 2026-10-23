/**
 * Phone = a viewport at most 600 CSS px wide, or a coarse pointer. Phones always
 * open the full page. The host reads this query in JS, and the panel stylesheet
 * uses the same query, so state and CSS cannot disagree.
 */
export const PHONE_QUERY = "(max-width: 600px), (pointer: coarse)";

export interface PhoneWatch {
  /** Current match. False where `matchMedia` is missing (jsdom, older runtimes). */
  readonly phone: boolean;
  stop(): void;
}

/** Calls `onChange` each time the phone query flips, until `stop()`. */
export function watchPhone(onChange: (phone: boolean) => void): PhoneWatch {
  const media = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(PHONE_QUERY) : undefined;
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches);
  media?.addEventListener("change", listener);
  return {
    phone: media?.matches === true,
    stop: () => media?.removeEventListener("change", listener),
  };
}
