/** Characters that can hide or reorder a filename are unsafe at share boundaries. */
const UNSAFE_FILENAME_CODE_POINT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

/** Validate and NFC-normalize one display filename; paths are never allowed. */
export function canonicalShareFilename(value: string): string {
  const canonical = value.normalize("NFC");
  if (
    canonical.length === 0
    || canonical === "."
    || canonical === ".."
    || canonical.includes("/")
    || canonical.includes("\\")
    || UNSAFE_FILENAME_CODE_POINT.test(canonical)
  ) {
    throw new TypeError("share filename is unsafe");
  }
  return canonical;
}
