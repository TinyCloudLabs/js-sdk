/** Storage copy that is not in strings.ts. Registered with the panel string table by its section module. */
export const STORAGE_PANEL_STRINGS = {
  "storage.summary": "How much space is used",
  "storage.glance.normal": "Normal",
  "storage.glance.nearly_full": "Nearly full",
  "storage.glance.full": "Full",
} as const satisfies Readonly<Record<string, string>>;
