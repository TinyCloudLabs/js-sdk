/** Activity copy that is not in strings.ts. Registered with the panel string table by its section module. */
export const ACTIVITY_STRINGS = {
  "activity.summary": "Recent requests this session",
  "activity.glance.no_errors": "No errors",
  "activity.glance.errors": "{count} errors",
  "activity.glance.clear": "Clear",
} as const satisfies Readonly<Record<string, string>>;
