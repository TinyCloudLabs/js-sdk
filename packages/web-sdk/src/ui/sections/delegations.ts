import type {
  DelegationGroup,
  DelegationRow,
  DelegationStatus,
  RevokeOutcome,
} from "../data";
import type { HostContext, PanelSection } from "../slots";
import { mountPlaceholder } from "./placeholder";
import { applyResult, createStateLine, settle, startLoading, textLine } from "./view-body";

const GROUPS: readonly DelegationGroup[] = ["this-app", "to-others", "received"];

const GROUP_WORD: Record<DelegationGroup, string> = {
  "this-app": "delegations.group.this-app",
  "to-others": "delegations.group.to-others",
  received: "delegations.group.received",
};

const STATUS_WORD: Record<DelegationStatus, string> = {
  active: "delegations.status.active",
  pending: "delegations.status.pending",
  expired: "delegations.status.expired",
  revoked: "delegations.status.revoked",
  ancestor_revoked: "delegations.status.ancestor_revoked",
};

/**
 * Delegations the account granted or received. Mounted only while the panel is
 * open and the session is signed in. Revoke asks first and moves focus to Keep.
 */
export const delegationsSection: PanelSection = {
  id: "delegations",
  labelCode: "nav.delegations",
  isAvailable: (ctx) => ctx.client()?.signedIn() === true,
  mount(el, ctx: HostContext) {
    const data = ctx.client()?.data;
    if (!data) return mountPlaceholder(el);

    let disposed = false;
    let busy = false;
    let seq = 0;
    let loaded = false;
    let rows: readonly DelegationRow[] = [];
    let nextCursor: string | undefined;
    let confirming: string | undefined;

    const line = createStateLine(ctx, () => void load());

    const content = document.createElement("div");
    content.hidden = true;
    const empty = textLine("busy", ctx.text("delegations.empty"));
    const groups = document.createElement("div");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "action";
    more.textContent = ctx.text("delegations.more");
    more.hidden = true;
    more.addEventListener("click", () => void load(nextCursor));
    const errorLine = textLine("error", "");
    errorLine.setAttribute("role", "alert");
    errorLine.hidden = true;
    content.append(empty, groups, more, errorLine);

    function render(): void {
      if (disposed) return;
      content.hidden = !loaded;
      if (!loaded) return;
      empty.hidden = rows.length > 0;
      groups.replaceChildren(...GROUPS.flatMap((group) => groupBlock(group)));
      more.hidden = nextCursor === undefined;
      more.disabled = busy;
    }

    function groupBlock(group: DelegationGroup): HTMLElement[] {
      const members = rows.filter((row) => row.group === group);
      if (members.length === 0) return [];
      const block = document.createElement("div");
      block.append(
        textLine("label", ctx.text(GROUP_WORD[group])),
        ...members.map((row) => rowBlock(row)),
      );
      return [block];
    }

    function rowBlock(row: DelegationRow): HTMLElement {
      const wrap = document.createElement("div");
      const item = document.createElement("div");
      item.className = "row";
      const info = document.createElement("div");
      info.append(
        textLine("label", row.label.text),
        textLine("busy", ctx.text(STATUS_WORD[row.status])),
      );
      if (row.expiringSoon) info.append(textLine("note", ctx.text("delegations.expiring")));
      item.append(info);
      wrap.append(item);
      if (row.status !== "active") return wrap;
      if (confirming === row.cid) {
        wrap.append(confirmBlock(row.cid));
        return wrap;
      }
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "action";
      revoke.textContent = ctx.text("delegations.revoke");
      revoke.disabled = busy;
      revoke.addEventListener("click", () => {
        confirming = row.cid;
        render();
        groups.querySelector<HTMLButtonElement>(".confirm .action")?.focus();
      });
      item.append(revoke);
      return wrap;
    }

    function confirmBlock(cid: string): HTMLElement {
      const box = document.createElement("div");
      box.className = "confirm";
      const actions = document.createElement("div");
      actions.className = "actions";
      // Keep comes first in the order and takes focus, so Enter cannot revoke by accident.
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "action";
      keep.textContent = ctx.text("delegations.revoke.cancel");
      keep.addEventListener("click", () => {
        confirming = undefined;
        render();
      });
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "action";
      confirm.textContent = ctx.text("delegations.revoke.confirm");
      confirm.disabled = busy;
      confirm.addEventListener("click", () => void revoke(cid));
      actions.append(keep, confirm);
      box.append(textLine("busy", ctx.text("delegations.revoke.question")), actions);
      return box;
    }

    async function load(cursor?: string): Promise<void> {
      const token = ++seq;
      const result = await settle(() => data.delegations(cursor));
      if (disposed || token !== seq) return;
      const page = applyResult(line, ctx, result);
      if (page === undefined) {
        loaded = false;
        rows = [];
        nextCursor = undefined;
      } else {
        loaded = true;
        rows = cursor === undefined ? page.rows : [...rows, ...page.rows];
        nextCursor = page.nextCursor;
      }
      render();
    }

    async function revoke(cid: string): Promise<void> {
      if (busy) return;
      busy = true;
      errorLine.hidden = true;
      render();
      let outcome: RevokeOutcome;
      try {
        outcome = await data.revoke(cid);
      } catch {
        outcome = { ok: false, code: "unknown" };
      }
      busy = false;
      if (disposed) return;
      confirming = undefined;
      if (!outcome.ok) {
        errorLine.hidden = false;
        errorLine.textContent = ctx.text("view.action.error");
        render();
        return;
      }
      await load();
    }

    const unsubscribe = data.subscribe((view) => {
      if (view === "delegations") void load();
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
