import type { HostPart } from "../slots";
import { prompts } from "./prompts";
import { storageWatch } from "./storage-watch";
import { syncStatusPart } from "./sync-status";
import { toasts } from "./toasts";

/** Static, ordered. Each slice replaces the body of its own file only. */
export const HOST_PARTS: readonly HostPart[] = [toasts, prompts, storageWatch, syncStatusPart];
