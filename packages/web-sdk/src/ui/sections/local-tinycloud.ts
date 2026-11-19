import type { ActionResult, LocalNodeConnection, LocalNodeState, PanelDataSource } from "../data";
import type { HostContext, PanelSection, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { LOCAL_TINYCLOUD_STRINGS } from "./local-tinycloud.strings";
import { viewStatus } from "./status";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";
import { actionButton, icon, statusNode, UI_STYLE } from "./ui";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const DISPLAY = '"Literata Variable","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';

const STYLE = `
.ll-intro{margin:-20px 0 20px;font-size:15px;line-height:1.5;max-width:56ch;color:#52525b}
.ll-sub{margin:2px 0 0;font-size:12.5px;color:#52525b}
.ll-ctl{display:flex;align-items:center;gap:10px;flex:none}
.ll-word{min-width:22px;text-align:right;font-size:13px;font-weight:700}
.ll-label{margin:0;font-family:${DISPLAY};font-size:16px;font-weight:500;letter-spacing:-.005em}
.ll-eyebrow{margin:0;font-size:13px;font-weight:600;line-height:1.3;color:#71717a}
.ll-card{display:flex;flex-direction:column;gap:14px;margin-top:14px;padding:16px 18px;border-radius:16px;background:#fafafa;box-shadow:inset 0 0 0 1px #e4e4e7}
.layer .panel[data-layout="page"] .ll-card{background:#fff}
.ll-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.ll-strong{margin:0;font-size:14px;font-weight:600}
.ll-body{margin:0;font-size:14px;line-height:1.45;color:#52525b}
.ll-looking{display:flex;align-items:center;gap:14px}
.ll-spin{flex:none;width:26px;height:26px;border:3px solid #f4f4f5;border-top-color:#09090b;border-radius:50%;animation:ll-spin .9s linear infinite}
@keyframes ll-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.ll-spin{animation:none}}
.ll-cancel{align-self:flex-start;width:auto}
.ll-kv{display:flex;flex-direction:column;margin:0;padding:0}
.ll-kv>div{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:44px;padding:9px 0;border-bottom:1px solid #e4e4e7}
.ll-kv>div:last-child{border-bottom:0}
.ll-kv dt{display:flex;flex:1 1 auto;align-items:baseline;gap:10px;min-width:0;font-size:14px;color:#52525b;white-space:nowrap}
.ll-kv dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted #a1a1aa;transform:translateY(-3px)}
.ll-kv dd{display:flex;flex:0 1 auto;align-items:center;justify-content:flex-end;gap:2px;max-width:100%;min-width:0;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.ll-mono,.ll-did{min-width:0;font-family:${MONO};font-size:12.5px;overflow-wrap:anywhere}
.ll-host{overflow-wrap:anywhere}
.ll-cell{display:flex;align-items:center;gap:8px;min-width:0}
.ll-codeline{display:flex;align-items:center;justify-content:space-between;gap:4px;box-sizing:border-box;margin-top:8px;padding:2px 4px 2px 14px;border-radius:12px;background:#f4f4f5;min-height:44px;font-family:${MONO};font-size:13px}
.ll-codeline code{min-width:0;overflow-wrap:anywhere}
.ll-steps{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none;counter-reset:ll-step;font-size:14px;line-height:1.45;color:#09090b}
.ll-steps li{position:relative;padding-left:34px;counter-increment:ll-step}
.ll-steps li::before{content:counter(ll-step);position:absolute;left:0;top:-1px;width:24px;height:24px;border-radius:50%;box-shadow:inset 0 0 0 1px #71717a;font:600 12px/24px ${MONO};text-align:center}
.ll-unknown{color:#52525b}
@media (prefers-color-scheme: dark){
.ll-intro,.ll-sub,.ll-body,.ll-kv dt,.ll-unknown{color:#a1a1aa}
.ll-card{background:#151517;box-shadow:inset 0 0 0 1px #69696b}
.layer .panel[data-layout="page"] .ll-card{background:#151517}
.ll-eyebrow{color:#a1a1aa}
.ll-spin{border-color:#27272a;border-top-color:#fafafa}
.ll-kv>div{border-bottom-color:#69696b}
.ll-kv dt::after{border-bottom-color:#71717a}
.ll-codeline{background:#27272a}
.ll-steps{color:#fafafa}
}
`;

/** Glance-row status for each connection. */
const GLANCE: Record<LocalNodeConnection, { code: string; tone: SectionStatus["tone"] }> = {
  found: { code: "local-tinycloud.glance.found", tone: "ok" },
  looking: { code: "local-tinycloud.glance.looking", tone: "info" },
  "not-found": { code: "local-tinycloud.glance.not_found", tone: "off" },
  off: { code: "local-tinycloud.glance.off", tone: "off" },
  unavailable: { code: "section.status.unavailable", tone: "off" },
};

/** Sub-line under the switch label, one per connection. */
const SUB: Record<LocalNodeConnection, string> = {
  off: "local-tinycloud.sub.off",
  looking: "local-tinycloud.sub.looking",
  found: "local-tinycloud.sub.found",
  "not-found": "local-tinycloud.sub.not_found",
  unavailable: "local-tinycloud.sub.unavailable",
};

registerPanelStrings(LOCAL_TINYCLOUD_STRINGS);

/**
 * Local TinyCloud on this computer. Mounted only while the panel is open.
 * The switch is on for any connection except `off` and `unavailable`. It is
 * disabled only when the app cannot change the setting. While looking, the
 * switch stays usable so the check can be cancelled.
 */
export const localTinycloudSection: PanelSection = {
  id: "local-tinycloud",
  labelCode: "nav.local-tinycloud",
  icon: "monitor",
  summaryCode: "local-tinycloud.summary",
  isAvailable: alwaysAvailable,
  status: (ctx) =>
    viewStatus(ctx, ctx.data.latest("localNode"), (node): SectionStatus => {
      const glance = GLANCE[node.connection];
      return { text: ctx.text(glance.code), tone: glance.tone };
    }),
  mount(el, ctx: HostContext) {
    const first = ctx.client()?.data;
    if (!first) return mountPlaceholder(el);
    // The source this mount reads. A client change swaps it; a result still in flight for the old one is dropped.
    let source: PanelDataSource | undefined = first;
    let epoch = 0;
    let offSource: (() => void) | undefined;

    let disposed = false;
    let busy = false;
    let seq = 0;
    let node: LocalNodeState | undefined;
    let attempted: boolean | undefined;

    const appName = (): string => ctx.appLabel() ?? ctx.text("local-tinycloud.app_fallback");
    const line = createStateLine(ctx, () => void load());

    const content = document.createElement("div");
    content.hidden = true;

    const intro = textLine("ll-intro", ctx.text("local-tinycloud.intro"));
    const heading = document.createElement("h3");
    heading.className = "sec-title";
    heading.tabIndex = -1;
    heading.textContent = ctx.text("nav.local-tinycloud");

    const row = document.createElement("div");
    row.className = "row";
    const labelBlock = document.createElement("div");
    const label = textLine("label ll-label", ctx.text("local-tinycloud.switch"));
    const sub = textLine("ll-sub", "");
    labelBlock.append(label, sub);
    const control = document.createElement("div");
    control.className = "ll-ctl";
    const word = document.createElement("span");
    word.className = "ll-word";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", ctx.text("local-tinycloud.switch"));
    const knob = document.createElement("span");
    knob.className = "knob";
    toggle.append(knob);
    control.append(word, toggle);
    row.append(labelBlock, control);

    const card = document.createElement("div");
    card.className = "ll-card";

    const errorLine = textLine("error", ctx.text("local-tinycloud.error"));
    errorLine.setAttribute("role", "alert");
    errorLine.hidden = true;
    const retryWrite = actionButton(ctx.text("view.retry"));
    retryWrite.hidden = true;
    retryWrite.addEventListener("click", () => {
      if (attempted !== undefined) void setOn(attempted);
    });

    content.append(row, card, errorLine, retryWrite);

    function copyButton(value: string, labelCode: string): HTMLButtonElement {
      const button = document.createElement("button");
      button.className = "icon-btn";
      button.setAttribute("aria-label", ctx.text(labelCode));
      button.append(icon("copy"));
      button.addEventListener("click", () => void copy(value));
      return button;
    }

    /** Neutral placeholder for a value the node did not report. Never shown as zero or blank. */
    function unknownValue(): HTMLSpanElement {
      const span = document.createElement("span");
      span.className = "ll-unknown";
      span.textContent = ctx.text("local-tinycloud.unknown");
      return span;
    }

    async function copy(value: string): Promise<void> {
      const at = epoch;
      try {
        await navigator.clipboard.writeText(value);
        if (!disposed && at === epoch) ctx.toast({ kind: "success", textCode: "local-tinycloud.copied" });
      } catch {
        if (!disposed && at === epoch) ctx.toast({ kind: "error", textCode: "local-tinycloud.copy_failed" });
      }
    }

    function pill(connection: LocalNodeConnection): HTMLSpanElement {
      const glance = GLANCE[connection];
      return statusNode({ text: ctx.text(glance.code), tone: glance.tone });
    }

    function head(status: HTMLElement, action?: HTMLButtonElement): HTMLDivElement {
      const div = document.createElement("div");
      div.className = "ll-card-head";
      div.append(status, ...(action ? [action] : []));
      return div;
    }

    /** The card for the current connection. Built fresh on every render. */
    function cardFor(current: LocalNodeState): HTMLElement[] {
      switch (current.connection) {
        case "off":
          return [
            head(pill("off")),
            textLine("ll-body", ctx.text("local-tinycloud.off.body", { app: appName() })),
          ];
        case "looking": {
          const spin = document.createElement("span");
          spin.className = "ll-spin";
          spin.setAttribute("aria-hidden", "true");
          const text = document.createElement("div");
          text.append(
            textLine("ll-strong", ctx.text("local-tinycloud.looking.title")),
            textLine("ll-body", ctx.text("local-tinycloud.looking.permission", { app: appName() })),
          );
          const wrap = document.createElement("div");
          wrap.className = "ll-looking";
          wrap.append(spin, text);
          const cancel = actionButton(ctx.text("local-tinycloud.looking.cancel"));
          cancel.classList.add("ll-cancel");
          cancel.addEventListener("click", () => {
            if (!busy) void setOn(false);
          });
          return [wrap, cancel];
        }
        case "found": {
          const recheck = actionButton(ctx.text("local-tinycloud.found.recheck"));
          recheck.addEventListener("click", () => void load());
          const kv = document.createElement("dl");
          kv.className = "ll-kv";
          const addRow = (labelCode: string, value: HTMLElement): void => {
            const row = document.createElement("div");
            const dt = document.createElement("dt");
            dt.textContent = ctx.text(labelCode);
            const dd = document.createElement("dd");
            dd.append(value);
            row.append(dt, dd);
            kv.append(row);
          };
          const did = current.identity?.nodeDid;
          const idCell = document.createElement("span");
          idCell.className = "ll-cell";
          if (did) {
            const idText = document.createElement("span");
            idText.className = "ll-did";
            idText.textContent =
              did.length > 18 ? `${did.slice(0, 12)}…${did.slice(-6)}` : did;
            idText.title = did;
            idCell.append(idText, copyButton(did, "local-tinycloud.copy.node_id_label"));
          } else {
            idCell.append(unknownValue());
          }
          addRow("local-tinycloud.found.node_id", idCell);
          const version = document.createElement("span");
          if (current.version) version.textContent = current.version;
          else version.append(unknownValue());
          addRow("local-tinycloud.found.version", version);
          const hostCell = document.createElement("span");
          hostCell.className = "ll-cell";
          if (current.url) {
            const host = document.createElement("span");
            host.className = "ll-mono ll-host";
            host.textContent = current.url;
            host.title = current.url;
            hostCell.append(host, copyButton(current.url, "local-tinycloud.copy.host_label"));
          } else {
            hostCell.append(unknownValue());
          }
          addRow("local-tinycloud.found.host", hostCell);
          return [head(pill("found"), recheck), kv];
        }
        case "not-found": {
          const again = actionButton(ctx.text("local-tinycloud.not_found.retry"));
          again.addEventListener("click", () => void load());
          const command = ctx.text("local-tinycloud.not_found.step_command");
          const code = document.createElement("code");
          code.textContent = command;
          const codeline = document.createElement("div");
          codeline.className = "ll-codeline";
          codeline.append(code, copyButton(command, "local-tinycloud.copy.command_label"));
          const steps = document.createElement("ol");
          steps.className = "ll-steps";
          const openItem = document.createElement("li");
          openItem.append(ctx.text("local-tinycloud.not_found.step_open"), codeline);
          const listenItem = document.createElement("li");
          listenItem.textContent = ctx.text("local-tinycloud.not_found.step_listen");
          const retryItem = document.createElement("li");
          retryItem.textContent = ctx.text("local-tinycloud.not_found.step_retry");
          steps.append(openItem, listenItem, retryItem);
          const lead = document.createElement("p");
          lead.className = "ll-body";
          const title = document.createElement("strong");
          title.textContent = ctx.text("local-tinycloud.not_found.title");
          lead.append(title, ` ${ctx.text("local-tinycloud.not_found.unchanged", { app: appName() })}`);
          return [
            head(pill("not-found"), again),
            lead,
            textLine("ll-eyebrow", ctx.text("local-tinycloud.not_found.steps_title")),
            steps,
          ];
        }
        case "unavailable":
          return [
            head(pill("unavailable")),
            textLine("ll-strong", ctx.text("local-tinycloud.unavailable.line")),
            textLine("ll-body", ctx.text("local-tinycloud.unavailable.explain")),
          ];
      }
    }

    function render(): void {
      if (disposed) return;
      content.hidden = node === undefined;
      if (node === undefined) return;
      const connection = node.connection;
      const on = connection !== "off" && connection !== "unavailable";
      toggle.setAttribute("aria-checked", String(on));
      toggle.disabled = connection === "unavailable";
      toggle.setAttribute("aria-disabled", String(busy));
      word.textContent = ctx.text(on ? "local-tinycloud.switch.on" : "local-tinycloud.switch.off");
      sub.textContent = ctx.text(SUB[connection]);
      card.replaceChildren(...cardFor(node));
    }

    async function load(): Promise<void> {
      const token = ++seq;
      const src = source;
      const at = epoch;
      if (src === undefined) return;
      const result = await settle(() => src.localNode());
      if (disposed || token !== seq || at !== epoch) return;
      node = applyResult(line, ctx, result);
      render();
    }

    async function setOn(on: boolean): Promise<void> {
      const src = source;
      if (src === undefined) return;
      const at = epoch;
      busy = true;
      attempted = on;
      errorLine.hidden = true;
      retryWrite.hidden = true;
      render();
      let result: ActionResult;
      try {
        result = await src.setLocalNodeEnabled(on);
      } catch {
        result = { ok: false, code: "unknown" };
      }
      if (disposed || at !== epoch) return;
      busy = false;
      errorLine.hidden = result.ok;
      retryWrite.hidden = result.ok;
      if (result.ok) attempted = undefined;
      await load();
    }

    toggle.addEventListener("click", () => {
      if (busy || node === undefined || node.connection === "unavailable") return;
      void setOn(node.connection === "off");
    });

    function follow(): void {
      offSource?.();
      offSource = source?.subscribe((view) => {
        if (view === "local") void load();
      });
    }
    // Client change (account switch): drop the old source's in-flight results and read the new source.
    const offClient = ctx.onClientChange(() => {
      epoch += 1;
      busy = false;
      attempted = undefined;
      errorLine.hidden = true;
      retryWrite.hidden = true;
      node = undefined;
      source = ctx.client()?.data;
      follow();
      render();
      if (source === undefined) {
        line.status.hidden = true;
        line.retry.hidden = true;
        return;
      }
      startLoading(line, ctx);
      void load();
    });
    follow();

    const style = document.createElement("style");
    style.textContent = STYLE + UI_STYLE;
    el.append(style, heading, intro, line.status, line.retry, content);
    startLoading(line, ctx);
    void load();

    return () => {
      disposed = true;
      offClient();
      offSource?.();
      el.replaceChildren();
    };
  },
};
