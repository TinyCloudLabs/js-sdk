/** Nodes copy that is not in strings.ts. Registered with the panel string table by its section module. */
export const NODES_STRINGS = {
  "nodes.summary": "Nodes your data syncs with",
  "nodes.glance.none": "None",
  "nodes.glance.healthy": "Healthy",
  "nodes.glance.slow": "{count} slow",
  "nodes.glance.down": "{count} down",
} as const satisfies Readonly<Record<string, string>>;
