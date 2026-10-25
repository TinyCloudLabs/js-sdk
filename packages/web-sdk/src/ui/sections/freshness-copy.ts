/**
 * Freshness chip copy. Only the lazy panel sections read it, so it stays out of
 * the eager STRINGS table in ../strings.ts.
 */
const FRESHNESS_COPY = {
  "freshness.updating": "Updating…",
  "freshness.updated": "Updated {age}",
  "freshness.failed": "Couldn't refresh. Showing data from {age}.",
  "freshness.age.now": "just now",
  "freshness.age.minutes": "{n} min ago",
  "freshness.age.hours": "{n} h ago",
  "freshness.age.days": "{n} d ago",
} as const;

export type FreshnessCode = keyof typeof FRESHNESS_COPY;

export function freshnessCopy(code: FreshnessCode): string {
  return FRESHNESS_COPY[code];
}
