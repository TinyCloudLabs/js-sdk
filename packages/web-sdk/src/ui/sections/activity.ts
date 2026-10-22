import type { RequestRow } from "../data";
import type { HostContext, PanelSection } from "../slots";
import { mountPlaceholder } from "./placeholder";
import { textLine } from "./view-body";

/** Newest first, as `activity.note` says. The log snapshot is oldest first. */
function renderRow(ctx: HostContext, row: RequestRow): HTMLElement {
  const item = document.createElement("div");
  item.className = "row";
  const info = document.createElement("div");
  const target = row.path === null ? row.op : `${row.op} ${row.path}`;
  const outcome = ctx.text(row.ok ? "activity.ok" : "activity.failed");
  const timing = row.durationMs === null ? outcome : `${outcome} · ${row.durationMs} ms`;
  info.append(textLine("label", target), textLine("busy", timing));
  item.append(info);
  return item;
}

/**
 * Request log for developer mode. Shown only while developer mode is on, as in
 * the mockup. Without a request log the body keeps the neutral placeholder.
 */
export const activitySection: PanelSection = {
  id: "activity",
  labelCode: "nav.activity",
  isAvailable: (ctx) => ctx.developerMode(),
  mount(el, ctx: HostContext) {
    const requests = ctx.client()?.data?.requests?.();
    if (!requests) return mountPlaceholder(el);

    const list = document.createElement("div");
    const empty = textLine("busy", ctx.text("activity.empty"));

    function render(): void {
      const rows = [...requests.rows()].reverse();
      empty.hidden = rows.length > 0;
      list.replaceChildren(...rows.map((row) => renderRow(ctx, row)));
    }

    const unsubscribe = requests.subscribe(() => render());
    el.append(textLine("note", ctx.text("activity.note")), empty, list);
    render();

    return () => {
      unsubscribe();
      el.replaceChildren();
    };
  },
};
