import type { NodeRow, NodeStatus } from "../data";
import type { HostContext, PanelSection, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { NODES_STRINGS } from "./nodes.strings";
import { viewStatus } from "./status";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";
import { UI_STYLE, icon, statusNode } from "./ui";

registerPanelStrings(NODES_STRINGS);

const STYLE = `
.nd-cards{display:grid;gap:14px;grid-template-columns:minmax(0,1fr);margin:0;padding:0;list-style:none}
.nd-card{min-width:0;padding:14px 16px;border:1px solid #e4e4e7;border-radius:12px}
.nd-card .row{align-items:flex-start}
.nd-card .row>div{min-width:0;flex:1}
.nd-card .label{overflow-wrap:anywhere}
.nd-kv{display:grid;margin:8px 0 0;padding:0}
.nd-kv>div{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;min-height:40px;padding:6px 0;border-top:1px solid #f4f4f5}
.nd-kv dt{margin:0;color:#52525b}
.nd-kv dd{display:flex;align-items:center;gap:6px;margin:0;min-width:0;max-width:100%;text-align:right}
.nd-did{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8125rem;overflow-wrap:anywhere;text-align:right}
.nd-did-row{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.nd-did{min-width:0;word-break:break-all}
.nd-chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin:0;padding:0;list-style:none}
.nd-chip{padding:2px 10px;border:1px solid #d4d4d8;border-radius:999px;font-size:.8125rem;overflow-wrap:anywhere}
.nd-card .icon-btn{margin:-10px -10px -10px 0}
.nd-did-row .icon-btn{margin:-10px 0}
@media (prefers-color-scheme: dark){
.nd-card{border-color:#3f3f46}
.nd-kv>div{border-top-color:#27272a}
.nd-kv dt{color:#a1a1aa}
.nd-chip{border-color:#52525b}
}
`;

const STATUS_WORD: Record<NodeStatus, string> = {
  ok: "nodes.card.ok",
  slow: "nodes.card.slow",
  down: "nodes.status.down",
};

const STATUS_TONE: Record<NodeStatus, SectionStatus["tone"]> = {
  ok: "ok",
  slow: "warn",
  down: "warn",
};

/** Host part of an origin for display; falls back to the origin when it does not parse. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Relative age for the last-seen stamp, in whole seconds or minutes. */
function seenAge(lastSeenAt: Date, now: number, ctx: HostContext): string {
  const seconds = Math.max(0, Math.floor((now - lastSeenAt.getTime()) / 1000));
  if (seconds < 60) return ctx.text("nodes.seen.seconds", { count: seconds });
  return ctx.text("nodes.seen.minutes", { count: Math.floor(seconds / 60) });
}

/**
 * Nodes this session talks to. Mounted only while the panel is open.
 * Without a data source the body keeps the neutral placeholder.
 */
export const nodesSection: PanelSection = {
  id: "nodes",
  labelCode: "nav.nodes",
  icon: "nodes",
  summaryCode: "nodes.summary",
  isAvailable: alwaysAvailable,
  status: (ctx) =>
    viewStatus(ctx, ctx.data.latest("nodes"), (rows): SectionStatus => {
      const count = String(rows.length);
      if (rows.length === 0) return { text: ctx.text("nodes.glance.none"), tone: "off", count };
      const down = rows.filter((row) => row.status === "down").length;
      if (down > 0) return { text: ctx.text("nodes.glance.down", { count: down }), tone: "warn", count };
      const slow = rows.filter((row) => row.status === "slow").length;
      if (slow > 0) return { text: ctx.text("nodes.glance.slow", { count: slow }), tone: "warn", count };
      return { text: ctx.text("nodes.glance.healthy"), tone: "ok", count };
    }),
  mount(el, ctx: HostContext) {
    const data = ctx.client()?.data;
    if (!data) return mountPlaceholder(el);

    let disposed = false;
    let seq = 0;

    const style = document.createElement("style");
    style.textContent = STYLE + UI_STYLE;
    const heading = document.createElement("h3");
    heading.className = "sec-title";
    heading.tabIndex = -1;
    heading.textContent = ctx.text("nodes.title");

    const line = createStateLine(ctx, () => void load());

    const content = document.createElement("div");
    content.hidden = true;
    const lede = textLine("note", ctx.text("nodes.lede"));
    const empty = textLine("note", ctx.text("nodes.empty"));
    empty.hidden = true;
    const list = document.createElement("ul");
    list.className = "nd-cards";
    content.append(lede, empty, list);

    function renderCard(node: NodeRow): HTMLElement {
      const host = hostOf(node.origin);
      const card = document.createElement("li");
      card.className = "nd-card";
      card.setAttribute("aria-label", host);

      const head = document.createElement("div");
      head.className = "row";
      const info = document.createElement("div");
      const roleWord = node.kind === "local" ? ctx.text("nodes.role.local") : ctx.text("nodes.kind.hosted");
      const role = node.active ? `${roleWord} · ${ctx.text("nodes.active")}` : roleWord;
      info.append(textLine("label", node.origin), textLine("note", role));
      const status: SectionStatus = { text: ctx.text(STATUS_WORD[node.status]), tone: STATUS_TONE[node.status] };
      head.append(info, statusNode(status));
      card.append(head);

      const rows: HTMLElement[] = [];
      const addRow = (label: string, value: HTMLElement): void => {
        const item = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.append(value);
        item.append(dt, dd);
        rows.push(item);
      };
      const plain = (className: string, value: string): HTMLElement => {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = value;
        return span;
      };

      if (node.nodeDid !== undefined) {
        const did = document.createElement("span");
        did.className = "nd-did";
        did.textContent = node.nodeDid;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "icon-btn";
        copy.setAttribute("aria-label", ctx.text("nodes.copy", { host }));
        copy.append(icon("copy"));
        copy.addEventListener("click", () => {
          // Clipboard may be unavailable (insecure context, denied permission); the button then does nothing.
          void navigator.clipboard?.writeText(did.textContent ?? "").catch(() => undefined);
        });
        const wrap = document.createElement("span");
        wrap.className = "nd-did-row";
        wrap.append(did, copy);
        addRow(ctx.text("nodes.nodeid"), wrap);
      }
      if (node.version !== undefined) addRow(ctx.text("nodes.version"), plain("", node.version));
      if (node.latencyMs !== undefined) {
        const ms = String(node.latencyMs);
        const value =
          node.lastSeenAt !== undefined
            ? ctx.text("nodes.latency.value", { ms, seen: seenAge(node.lastSeenAt, Date.now(), ctx) })
            : ctx.text("nodes.latency.only", { ms });
        addRow(ctx.text("nodes.latency"), plain("", value));
      }
      // NodeRow.spaces is typed as a string list; anything else is treated as absent.
      if (Array.isArray(node.spaces) && node.spaces.length > 0) {
        const chips = document.createElement("ul");
        chips.className = "nd-chips";
        chips.append(
          ...node.spaces.map((name: string) => {
            const chip = document.createElement("li");
            chip.className = "nd-chip";
            chip.textContent = name;
            return chip;
          }),
        );
        addRow(ctx.text("nodes.spaces"), chips);
      }

      if (rows.length > 0) {
        const kv = document.createElement("dl");
        kv.className = "nd-kv";
        kv.append(...rows);
        card.append(kv);
      }
      return card;
    }

    async function load(): Promise<void> {
      const token = ++seq;
      const result = await settle(() => data.nodes());
      if (disposed || token !== seq) return;
      const nodes = applyResult(line, ctx, result);
      content.hidden = nodes === undefined;
      if (nodes !== undefined) {
        empty.hidden = nodes.length > 0;
        list.replaceChildren(...nodes.map((node) => renderCard(node)));
      }
    }

    const unsubscribe = data.subscribe((view) => {
      if (view === "nodes") void load();
    });

    el.append(style, heading, line.status, line.retry, content);
    startLoading(line, ctx);
    void load();

    return () => {
      disposed = true;
      unsubscribe();
      el.replaceChildren();
    };
  },
};
