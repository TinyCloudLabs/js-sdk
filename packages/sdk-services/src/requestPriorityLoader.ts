let loading: Promise<typeof import("@tinycloud/sdk-services/request-priority")> | undefined;

/** Share one module load across dispatches and allow a failed load to retry. */
export function loadRequestPriority(): Promise<typeof import("@tinycloud/sdk-services/request-priority")> {
  return loading ??= import("@tinycloud/sdk-services/request-priority").catch((error) => {
    loading = undefined;
    throw error;
  });
}
