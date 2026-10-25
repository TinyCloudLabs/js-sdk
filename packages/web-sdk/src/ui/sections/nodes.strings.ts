/**
 * Nodes copy that is not in strings.ts. Registered with the panel string table by its section module.
 * Mockup copy wins where the spec and the mockup differ (see the section brief).
 */
export const NODES_STRINGS = {
  "nodes.summary": "Nodes your data syncs with",
  "nodes.title": "Connected nodes",
  "nodes.lede": "The nodes this session is talking to right now. TinyCloud picks the node for each space; there is nothing to switch here.",
  "nodes.empty": "No node is in use right now.",
  "nodes.unavailable": "Not available right now.",
  "nodes.glance.none": "None",
  "nodes.glance.healthy": "Healthy",
  "nodes.glance.slow": "{count} slow",
  "nodes.glance.down": "{count} down",
  "nodes.card.ok": "Connected",
  "nodes.card.slow": "Slow to respond",
  "nodes.role.local": "On this computer",
  "nodes.role.ownHosted": "Your hosted TinyCloud",
  "nodes.nodeid": "Node ID",
  "nodes.copy": "Copy the node ID of {host}",
  "nodes.spaces": "Spaces here",
  "nodes.latency.value": "{ms} ms · seen {seen}",
  "nodes.latency.only": "{ms} ms",
  "nodes.seen.seconds": "{count} s ago",
  "nodes.seen.minutes": "{count} min ago",
} as const satisfies Readonly<Record<string, string>>;
