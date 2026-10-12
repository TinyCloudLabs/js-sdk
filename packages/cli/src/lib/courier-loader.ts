type CourierEntry = typeof import("../courier-entry.js");

/**
 * Load the bundled Courier entry. `index.js` and `legacy-entry.js` both live in
 * `dist/`, so the sibling URL resolves the same from either.
 */
export async function loadCourierEntry(): Promise<CourierEntry> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<CourierEntry>;
  return load(new URL("./courier-entry.js", import.meta.url).href);
}
