/**
 * Characters that can hide or visually reorder a filename: every Unicode
 * control, format and surrogate code point, plus U+2028/U+2029. Matches the
 * share viewer's `src/filename-policy.ts`.
 */
const UNSAFE_FILENAME_CODE_POINT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

export function hasUnsafeFilenameCodePoint(value: string): boolean {
  return UNSAFE_FILENAME_CODE_POINT.test(value);
}

/** A single display/download filename, never a path. Returns the NFC form. */
export function canonicalShareFilename(value: string): string {
  const canonical = value.normalize("NFC");
  if (
    canonical.length === 0
    || canonical === "."
    || canonical === ".."
    || canonical.includes("/")
    || canonical.includes("\\")
    || hasUnsafeFilenameCodePoint(canonical)
  ) {
    throw new TypeError("share filename is unsafe");
  }
  return canonical;
}
