import type { ViewResult } from "../data";
import type { SectionContext, SectionStatus } from "../slots";

/**
 * Status for a data-backed section, shared by every section's `status(ctx)`.
 * No data source reads as unavailable; a view the shell has not read yet shows
 * nothing; loading, needs-permission and error stay neutral. Only `ready`
 * reaches the section's own mapping.
 */
export function viewStatus<T>(
  ctx: SectionContext,
  result: ViewResult<T> | undefined,
  ready: (data: T) => SectionStatus,
): SectionStatus | undefined {
  if (ctx.data.source === undefined) return { text: ctx.text("section.status.unavailable"), tone: "info" };
  if (result === undefined) return undefined;
  switch (result.state) {
    case "loading":
      return { text: ctx.text("section.status.checking"), tone: "info" };
    case "needs-permission":
      return { text: ctx.text("section.status.needs_permission"), tone: "info" };
    case "error":
      return { text: ctx.text("section.status.unavailable"), tone: "info" };
    case "ready":
      return ready(result.data);
  }
}
