import type { NodeRow, NodeStatus } from "../data";
import type { HostContext, PanelSection } from "../slots";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";

const STATUS_WORD: Record<NodeStatus, string> = {
  ok: "nodes.status.ok",
  slow: "nodes.status.slow",
  down: "nodes.status.down",
};

const KIND_WORD: Record<NodeRow["kind"], string> = {
  hosted: "nodes.kind.hosted",
  local: "nodes.kind.local",
};

/**
 * Nodes this session talks to. Mounted only while the panel is open.
 * Without a data source the body keeps the neutral placeholder.
 */
export const nodesSection: PanelSection = {
  id: "nodes",
  labelCode: "nav.nodes",
  isAvailable: alwaysAvailable,
  mount(el, ctx: HostContext) {
    const data = ctx.client()?.data;
    if (!data) return mountPlaceholder(el);

    let disposed = false;
    let seq = 0;

    const line = createStateLine(ctx, () => void load());

    const content = document.createElement("div");
    content.hidden = true;
    const list = document.createElement("div");
    content.append(textLine("note", ctx.text("nodes.note")), list);

    function renderRow(node: NodeRow): HTMLElement {
      const item = document.createElement("div");
      item.className = "row";
      const details = [ctx.text(KIND_WORD[node.kind]), ctx.text(STATUS_WORD[node.status])];
      if (node.active) details.push(ctx.text("nodes.active"));
      const info = document.createElement("div");
      info.append(textLine("label", node.origin), textLine("busy", details.join(" · ")));
      if (node.version !== undefined) {
        info.append(textLine("note", `${ctx.text("nodes.version")}: ${node.version}`));
      }
      if (node.latencyMs !== undefined) {
        info.append(textLine("note", `${ctx.text("nodes.latency")}: ${node.latencyMs} ms`));
      }
      item.append(info);
      return item;
    }

    async function load(): Promise<void> {
      const token = ++seq;
      const result = await settle(() => data.nodes());
      if (disposed || token !== seq) return;
      const nodes = applyResult(line, ctx, result);
      content.hidden = nodes === undefined;
      if (nodes !== undefined) list.replaceChildren(...nodes.map((node) => renderRow(node)));
    }

    const unsubscribe = data.subscribe((view) => {
      if (view === "nodes") void load();
    });

    el.append(line.status, line.retry, content);
    startLoading(line, ctx);
    void load();

    return () => {
      disposed = true;
      unsubscribe();
      el.replaceChildren();
    };
  },
};
