import type { ActionResult, LocalNodeConnection, LocalNodeState } from "../data";
import type { HostContext, PanelSection, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { LOCAL_TINYCLOUD_STRINGS } from "./local-tinycloud.strings";
import { viewStatus } from "./status";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";

/** Status word per connection state. */
const WORD: Record<LocalNodeConnection, string> = {
  off: "local.off",
  looking: "local.looking",
  found: "local.found",
  "not-found": "local.not-found",
  unavailable: "local.unavailable",
};

/** Address, node identity and version, each only when the source reports it. */
function detailLines(ctx: HostContext, node: LocalNodeState): HTMLParagraphElement[] {
  const rows: readonly (readonly [string, string | undefined])[] = [
    ["local.address", node.url],
    ["local.identity", node.identity?.nodeDid],
    ["local.version", node.version],
  ];
  return rows.flatMap(([code, value]) =>
    value === undefined ? [] : [textLine("note", `${ctx.text(code)}: ${value}`)],
  );
}

registerPanelStrings(LOCAL_TINYCLOUD_STRINGS);

/**
 * Local TinyCloud on this computer. Mounted only while the panel is open.
 * The switch is on for any connection except `off`. It is disabled when the
 * connection cannot be checked. Without a data source the body keeps the
 * neutral placeholder.
 */
export const localTinycloudSection: PanelSection = {
  id: "local-tinycloud",
  labelCode: "nav.local-tinycloud",
  icon: "monitor",
  summaryCode: "local-tinycloud.summary",
  isAvailable: alwaysAvailable,
  status: (ctx) =>
    viewStatus(ctx, ctx.data.latest("localNode"), (node): SectionStatus => {
      switch (node.connection) {
        case "found":
          return { text: ctx.text("local-tinycloud.glance.found"), tone: "ok" };
        case "looking":
          return { text: ctx.text("local-tinycloud.glance.looking"), tone: "info" };
        case "not-found":
          return { text: ctx.text("local-tinycloud.glance.not_found"), tone: "off" };
        case "off":
          return { text: ctx.text("local-tinycloud.glance.off"), tone: "off" };
        case "unavailable":
          return { text: ctx.text("section.status.unavailable"), tone: "info" };
      }
    }),
  mount(el, ctx: HostContext) {
    const data = ctx.client()?.data;
    if (!data) return mountPlaceholder(el);

    let disposed = false;
    let busy = false;
    let seq = 0;
    let node: LocalNodeState | undefined;

    const line = createStateLine(ctx, () => void load());

    const content = document.createElement("div");
    content.hidden = true;

    const row = document.createElement("div");
    row.className = "row";
    const label = textLine("label", ctx.text("local.switch"));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", ctx.text("local.switch"));
    const knob = document.createElement("span");
    knob.className = "knob";
    toggle.append(knob);
    row.append(label, toggle);

    const word = textLine("busy", "");
    const details = document.createElement("div");
    const errorLine = textLine("error", "");
    errorLine.setAttribute("role", "alert");
    errorLine.hidden = true;
    content.append(row, word, details, errorLine);

    function render(): void {
      if (disposed) return;
      content.hidden = node === undefined;
      if (node === undefined) return;
      toggle.setAttribute("aria-checked", String(node.connection !== "off"));
      toggle.disabled = busy || node.connection === "unavailable";
      word.textContent = ctx.text(WORD[node.connection]);
      details.replaceChildren(...detailLines(ctx, node));
    }

    async function load(): Promise<void> {
      const token = ++seq;
      const result = await settle(() => data.localNode());
      if (disposed || token !== seq) return;
      node = applyResult(line, ctx, result);
      render();
    }

    async function setOn(on: boolean): Promise<void> {
      busy = true;
      render();
      let result: ActionResult;
      try {
        result = await data.setLocalNodeEnabled(on);
      } catch {
        result = { ok: false, code: "unknown" };
      }
      busy = false;
      if (disposed) return;
      errorLine.hidden = result.ok;
      errorLine.textContent = result.ok ? "" : ctx.text("view.action.error");
      await load();
    }

    toggle.addEventListener("click", () => {
      if (busy || node === undefined) return;
      void setOn(node.connection === "off");
    });

    const unsubscribe = data.subscribe((view) => {
      if (view === "local") void load();
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
