import type { HostPart } from "../slots";

/** Storage watcher arrives with D3. Nothing runs until then. */
export const storageWatch: HostPart = {
  id: "storage-watch",
  start: () => () => undefined,
};
