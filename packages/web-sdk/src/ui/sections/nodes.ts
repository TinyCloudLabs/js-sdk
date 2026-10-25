import type { NodeRow, NodeStatus, PanelDataSource } from "../data";
import type { HostContext, PanelSection, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { NODES_STRINGS } from "./nodes.strings";
import { viewStatus } from "./status";
import { alwaysAvailable } from "./placeholder";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";
import { UI_STYLE, icon, statusNode } from "./ui";

registerPanelStrings(NODES_STRINGS);

const STYLE = `
.nd-wrap{container-type:inline-size;min-width:0}
.nd-wrap>.nd-lede{margin:0 0 20px;font-size:15px;line-height:1.5;max-width:56ch;color:#09090b}
.nd-cards{display:grid;gap:14px;grid-template-columns:minmax(0,1fr);margin:0;padding:0;list-style:none}
@container (min-width:720px){.nd-cards{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.nd-card{min-width:0;padding:14px 16px;border:1px solid #e4e4e7;border-radius:12px;--nd-leader:#a1a1aa}
.nd-card .row{align-items:baseline}
.nd-card .row>div{min-width:0;flex:1}
.nd-host{font:600 15px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.nd-kv{display:flex;flex-direction:column;margin:8px 0 0;padding:0}
.nd-kv>div{display:flex;align-items:center;gap:10px;min-height:40px;padding:0;border-top:1px solid #f4f4f5}
.nd-kv dt{display:flex;align-items:baseline;gap:10px;flex:1 1 auto;min-width:0;margin:0;font-size:14px;color:#52525b;white-space:nowrap}
.nd-kv dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted var(--nd-leader);transform:translateY(-3px)}
.nd-kv dd{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex:0 1 auto;max-width:78%;min-width:0;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.nd-kv dd.nd-mono{font-size:12px;font-weight:500}
.nd-did-row{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.nd-did{min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.nd-did-head,.nd-did-tail{overflow-wrap:anywhere}
.nd-chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin:0;padding:0;list-style:none}
.nd-chip{display:inline-flex;align-items:center;min-height:28px;padding:0 11px;border-radius:999px;background:#f4f4f5;font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.nd-card .icon-btn{margin:-10px -10px -10px 0}
.nd-did-row .icon-btn{margin:-10px 0}
@media (prefers-color-scheme: dark){
.nd-wrap>.nd-lede{color:#fafafa}
.nd-card{border-color:#3f3f46;--nd-leader:#71717a}
.nd-kv>div{border-top-color:#27272a}
.nd-kv dt{color:#a1a1aa}
.nd-chip{background:#27272a}
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

/** Relative age for the last-seen stamp; undefined when the stamp is missing, invalid, or in the future. */
function seenAge(lastSeenAt: unknown, now: number, ctx: HostContext): string | undefined {
  if (!(lastSeenAt instanceof Date)) return undefined;
  const elapsed = now - lastSeenAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return ctx.text("nodes.seen.seconds", { count: seconds });
  return ctx.text("nodes.seen.minutes", { count: Math.floor(seconds / 60) });
}

/** Role line under the host: local, this session's own hosted node, or another hosted node. */
function roleOf(node: NodeRow, ctx: HostContext): string {
  if (node.kind === "local") return ctx.text("nodes.role.local");
  return node.active ? ctx.text("nodes.role.ownHosted") : ctx.text("nodes.kind.hosted");
}

/**
 * Nodes this session talks to. Mounted only while the panel is open.
 * Without a client or data source it shows the unavailable line.
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
    // Undefined without a client or data source; the unavailable line shows until one appears.
    let source: PanelDataSource | undefined = ctx.client()?.data;

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
    lede.classList.add("nd-lede");
    const empty = textLine("note", ctx.text("nodes.empty"));
    empty.hidden = true;
    const list = document.createElement("ul");
    list.className = "nd-cards";
    content.className = "nd-wrap";
    content.append(lede, empty, list);

    function renderCard(node: NodeRow): HTMLElement {
      const host = hostOf(node.origin);
      const card = document.createElement("li");
      card.className = "nd-card";
      card.setAttribute("aria-label", host);

      const head = document.createElement("div");
      head.className = "row";
      const info = document.createElement("div");
      const name = textLine("label", host);
      name.classList.add("nd-host");
      info.append(name, textLine("note", roleOf(node, ctx)));
      const status: SectionStatus = { text: ctx.text(STATUS_WORD[node.status]), tone: STATUS_TONE[node.status] };
      head.append(info, statusNode(status));
      card.append(head);

      const rows: HTMLElement[] = [];
      const addRow = (label: string, value: HTMLElement, mono = false): void => {
        const item = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        if (mono) dd.className = "nd-mono";
        dd.append(value);
        item.append(dt, dd);
        rows.push(item);
      };
      const plain = (value: string): HTMLElement => {
        const span = document.createElement("span");
        span.textContent = value;
        return span;
      };

      if (node.nodeDid !== undefined) {
        // Text is split only for display: the head elides, the last four characters stay visible.
        // textContent is always the full DID, which is what copy writes.
        const did = document.createElement("span");
        did.className = "nd-did";
        const cut = Math.max(0, node.nodeDid.length - 4);
        const didHead = document.createElement("span");
        didHead.className = "nd-did-head";
        didHead.textContent = node.nodeDid.slice(0, cut);
        const didTail = document.createElement("span");
        didTail.className = "nd-did-tail";
        didTail.textContent = node.nodeDid.slice(cut);
        did.append(didHead, didTail);
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "icon-btn";
        copy.setAttribute("aria-label", ctx.text("nodes.copy", { host }));
        copy.append(icon("copy"));
        copy.addEventListener("click", () => {
          // Clipboard may be unavailable (insecure context, denied permission); the button then does nothing.
          void navigator.clipboard?.writeText(did.textContent ?? "").catch(() => undefined);
        });
        const wrapDid = document.createElement("span");
        wrapDid.className = "nd-did-row";
        wrapDid.append(did, copy);
        addRow(ctx.text("nodes.nodeid"), wrapDid, true);
      }
      if (typeof node.version === "string" && node.version.trim() !== "") {
        addRow(ctx.text("nodes.version"), plain(`v${node.version}`));
      }
      const latency = typeof node.latencyMs === "number" && Number.isFinite(node.latencyMs) ? node.latencyMs : undefined;
      if (latency !== undefined) {
        const ms = String(latency);
        const seen = seenAge(node.lastSeenAt, Date.now(), ctx);
        const value =
          seen !== undefined ? ctx.text("nodes.latency.value", { ms, seen }) : ctx.text("nodes.latency.only", { ms });
        addRow(ctx.text("nodes.latency"), plain(value));
      }
      // NodeRow.spaces is typed as a string list; anything else, and blank names, are treated as absent.
      const spaces = Array.isArray(node.spaces)
        ? node.spaces.filter((name): name is string => typeof name === "string" && name.trim() !== "")
        : [];
      if (spaces.length > 0) {
        const chips = document.createElement("ul");
        chips.className = "nd-chips";
        chips.append(
          ...spaces.map((name) => {
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
      const current = source;
      if (current === undefined) return showUnavailable();
      const result = await settle(() => current.nodes());
      if (disposed || token !== seq) return;
      const nodes = applyResult(line, ctx, result);
      content.hidden = nodes === undefined;
      if (nodes !== undefined) {
        empty.hidden = nodes.length > 0;
        list.replaceChildren(...nodes.map((node) => renderCard(node)));
      }
    }

    function attach(next: PanelDataSource): () => void {
      return next.subscribe((view) => {
        if (view === "nodes") void load();
      });
    }

    function clearRows(): void {
      content.hidden = true;
      empty.hidden = true;
      list.replaceChildren();
    }

    // Shown when there is no client or data source. Nothing is loading, so no spinner.
    function showUnavailable(): void {
      clearRows();
      line.status.hidden = false;
      line.status.textContent = ctx.text("nodes.unavailable");
      line.retry.hidden = true;
    }

    // Bumping seq drops any read still in flight for the previous account or client.
    function onAccountChange(): void {
      seq++;
      unsubscribe();
      offReset?.();
      clearRows();
      const next = ctx.client()?.data;
      source = next;
      // The stylesheet ships with the rows. Without a data source nothing it styles can render, so it stays out.
      if (next === undefined) style.remove();
      else el.prepend(style);
      unsubscribe = next ? attach(next) : () => undefined;
      offReset = ctx.client()?.onReset(onAccountChange);
      if (next !== undefined) startLoading(line, ctx);
      void load();
    }

    let unsubscribe = source ? attach(source) : () => undefined;
    let offReset = ctx.client()?.onReset(onAccountChange);
    const offClient = ctx.onClientChange(onAccountChange);

    // The stylesheet is attached only with a data source; see onAccountChange.
    el.append(heading, line.status, line.retry, content);
    if (source !== undefined) {
      el.prepend(style);
      startLoading(line, ctx);
    }
    void load();

    return () => {
      disposed = true;
      offClient();
      offReset?.();
      unsubscribe();
      el.replaceChildren();
    };
  },
};
