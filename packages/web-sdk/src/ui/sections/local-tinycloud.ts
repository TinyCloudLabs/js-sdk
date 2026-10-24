import type { ActionResult, LocalNodeConnection, LocalNodeState } from "../data";
import type { HostContext, PanelSection, SectionStatus } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { LOCAL_TINYCLOUD_STRINGS } from "./local-tinycloud.strings";
import { viewStatus } from "./status";
import { alwaysAvailable, mountPlaceholder } from "./placeholder";
import { actionButton, statusNode, UI_STYLE } from "./ui";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const STYLE = `
.ll-intro{margin:-20px 0 20px;font-size:15px;line-height:1.5;max-width:56ch;color:#52525b}
.ll-sub{margin:2px 0 0;font-size:12.5px;color:#52525b}
.ll-ctl{display:flex;align-items:center;gap:10px;flex:none}
.ll-word{min-width:2.5em;text-align:right;font-size:13px;font-weight:600}
.ll-card{display:flex;flex-direction:column;gap:10px;margin-top:14px;padding:16px;border:1px solid #e4e4e7;border-radius:12px}
.ll-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.ll-strong{margin:0;font-size:14px;font-weight:600}
.ll-body{margin:0;font-size:13px;line-height:1.5;color:#52525b}
.ll-looking{display:flex;align-items:flex-start;gap:12px}
.ll-spin{flex:none;width:18px;height:18px;margin-top:2px;border:2px solid #d4d4d8;border-top-color:#18181b;border-radius:50%;animation:ll-spin .9s linear infinite}
@keyframes ll-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.ll-spin{animation:none}}
.ll-kv{display:flex;flex-direction:column;margin:0;padding:0}
.ll-kv>div{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:44px;padding:9px 0;border-bottom:1px solid #e4e4e7}
.ll-kv>div:last-child{border-bottom:0}
.ll-kv dt{display:flex;flex:1 1 auto;align-items:baseline;gap:10px;min-width:0;font-size:14px;color:#52525b;white-space:nowrap}
.ll-kv dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted #a1a1aa;transform:translateY(-3px)}
.ll-kv dd{display:flex;flex:0 1 auto;align-items:center;justify-content:flex-end;gap:2px;max-width:100%;min-width:0;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.ll-mono,.ll-did{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-size:12.5px}
.ll-cell{display:flex;align-items:center;gap:8px;min-width:0}
.ll-cell>.action{flex:none;padding-left:10px;padding-right:10px}
.ll-steps{margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#52525b}
@media (prefers-color-scheme: dark){
.ll-intro,.ll-sub,.ll-body,.ll-kv dt,.ll-steps{color:#a1a1aa}
.ll-card{border-color:#3f3f46}
.ll-spin{border-color:#3f3f46;border-top-color:#fafafa}
.ll-kv>div{border-bottom-color:#69696b}
.ll-kv dt::after{border-bottom-color:#71717a}
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
    const data = ctx.client()?.data;
    if (!data) return mountPlaceholder(el);

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
    const label = textLine("label", ctx.text("local-tinycloud.switch"));
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
      const button = actionButton(ctx.text("local-tinycloud.copy"));
      button.setAttribute("aria-label", ctx.text(labelCode));
      button.addEventListener("click", () => void copy(value));
      return button;
    }

    async function copy(value: string): Promise<void> {
      try {
        await navigator.clipboard.writeText(value);
        ctx.toast({ kind: "success", textCode: "local-tinycloud.copied" });
      } catch {
        ctx.toast({ kind: "error", textCode: "local-tinycloud.copy_failed" });
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
          if (did !== undefined) {
            const idText = document.createElement("span");
            idText.className = "ll-did";
            idText.textContent =
              did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did;
            idText.title = did;
            const idCell = document.createElement("span");
            idCell.className = "ll-cell";
            idCell.append(idText, copyButton(did, "local-tinycloud.copy.node_id_label"));
            addRow("local-tinycloud.found.node_id", idCell);
          }
          if (current.version !== undefined) {
            const version = document.createElement("span");
            version.textContent = current.version;
            addRow("local-tinycloud.found.version", version);
          }
          if (current.url !== undefined) {
            const host = document.createElement("span");
            host.className = "ll-mono";
            host.textContent = current.url;
            host.title = current.url;
            const hostCell = document.createElement("span");
            hostCell.className = "ll-cell";
            hostCell.append(host, copyButton(current.url, "local-tinycloud.copy.host_label"));
            addRow("local-tinycloud.found.host", hostCell);
          }
          return [head(pill("found"), recheck), kv];
        }
        case "not-found": {
          const again = actionButton(ctx.text("local-tinycloud.not_found.retry"));
          again.addEventListener("click", () => void load());
          const command = ctx.text("local-tinycloud.not_found.step_command");
          const code = document.createElement("code");
          code.className = "ll-mono";
          code.textContent = command;
          const commandCell = document.createElement("span");
          commandCell.className = "ll-cell";
          commandCell.append(code, copyButton(command, "local-tinycloud.copy.command_label"));
          const steps = document.createElement("ol");
          steps.className = "ll-steps";
          const openItem = document.createElement("li");
          openItem.textContent = ctx.text("local-tinycloud.not_found.step_open");
          const commandItem = document.createElement("li");
          commandItem.append(commandCell);
          const listenItem = document.createElement("li");
          listenItem.textContent = ctx.text("local-tinycloud.not_found.step_listen");
          const retryItem = document.createElement("li");
          retryItem.textContent = ctx.text("local-tinycloud.not_found.step_retry");
          steps.append(openItem, commandItem, listenItem, retryItem);
          return [
            head(pill("not-found"), again),
            textLine("ll-strong", ctx.text("local-tinycloud.not_found.title")),
            textLine("ll-body", ctx.text("local-tinycloud.not_found.unchanged", { app: appName() })),
            textLine("ll-strong", ctx.text("local-tinycloud.not_found.steps_title")),
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
      const result = await settle(() => data.localNode());
      if (disposed || token !== seq) return;
      node = applyResult(line, ctx, result);
      render();
    }

    async function setOn(on: boolean): Promise<void> {
      busy = true;
      attempted = on;
      errorLine.hidden = true;
      retryWrite.hidden = true;
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
      retryWrite.hidden = result.ok;
      if (result.ok) attempted = undefined;
      await load();
    }

    toggle.addEventListener("click", () => {
      if (busy || node === undefined || node.connection === "unavailable") return;
      void setOn(node.connection === "off");
    });

    const unsubscribe = data.subscribe((view) => {
      if (view === "local") void load();
    });

    const style = document.createElement("style");
    style.textContent = STYLE + UI_STYLE;
    el.append(style, heading, intro, line.status, line.retry, content);
    startLoading(line, ctx);
    void load();

    return () => {
      disposed = true;
      unsubscribe();
      el.replaceChildren();
    };
  },
};
