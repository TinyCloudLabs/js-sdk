import * as priority from "@tinycloud/sdk-services/request-priority";

// The worker already owns a self-contained bundle, so its dispatcher needs no lazy module bootstrap.
const loaded = Promise.resolve(priority);

export function loadRequestPriority(): Promise<typeof priority> {
  return loaded;
}
