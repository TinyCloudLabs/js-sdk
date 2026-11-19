// The browser plugin imports this only after a refused restore.
// No registration or session state lives in this separately bundled entry.
export { createGatedNetworkReadThrough } from "@tinycloud/node-sdk/replication/gated-network";
