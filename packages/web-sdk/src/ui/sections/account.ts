import type { AccountInfo, ViewResult } from "../data";
import type { PanelClient, PanelSection, SectionContext, SectionId } from "../slots";
import type { StringKey } from "../strings";
import { alwaysAvailable } from "./placeholder";
import { actionButton, confirmBox, glanceRow, UI_STYLE, type ConfirmBox } from "./ui";

const STYLE = `
.account-cols{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));align-items:start}
.account-ident{display:flex;gap:12px;align-items:flex-start;min-width:0}
.account-avatar{flex:none;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;background:#e4e4e7;color:#18181b}
.account-ident .eyebrow{margin:0;font-size:12px;color:#4b5563}
.account-ident .name{margin:2px 0 0;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.account-idline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}
.account-did{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.account-kv{margin:18px 0 0;padding:0}
.account-kv>div{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid #e4e4e7}
.account-kv dt{color:#4b5563}
.account-kv dd{margin:0;text-align:right;overflow-wrap:anywhere}
.account-kv .account-host{margin-left:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#4b5563}
.account-signout{margin-top:14px}
.account-glance{display:flex;flex-direction:column;gap:0}
@media (prefers-color-scheme: dark){
.account-avatar{background:#3f3f46;color:#fafafa}
.account-ident .eyebrow,.account-kv dt,.account-kv .account-host{color:#a1a1aa}
.account-kv>div{border-bottom-color:#3f3f46}
}
`;

interface GlanceEntry {
  readonly id: SectionId;
  readonly labelCode: StringKey;
  readonly subCode: StringKey;
  /** Shown only when the client exposes developer-mode request logs. */
  readonly devOnly?: boolean;
}

/** At-a-glance rows, in nav order. Overview itself is not listed. */
const GLANCE: readonly GlanceEntry[] = [
  { id: "local-tinycloud", labelCode: "nav.local-tinycloud", subCode: "glance.local-tinycloud" },
  { id: "local-copy", labelCode: "nav.local-copy", subCode: "glance.local-copy" },
  { id: "delegations", labelCode: "nav.delegations", subCode: "glance.delegations" },
  { id: "nodes", labelCode: "nav.nodes", subCode: "glance.nodes" },
  { id: "storage", labelCode: "nav.storage", subCode: "glance.storage" },
  { id: "activity", labelCode: "nav.activity", subCode: "glance.activity", devOnly: true },
];

/** Whole hours and minutes until `expires`, rounded up to the minute, never negative. */
function remaining(expires: Date, now: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.ceil((expires.getTime() - now) / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * Overview: identity, session and app facts, sign out behind a confirm box,
 * At-a-glance rows, and the hide-button block.
 * Reads `client.data.account()`; re-reads on reset. Each row opens its section.
 */
function mountAccount(el: HTMLElement, ctx: SectionContext): () => void {
  const client: PanelClient | undefined = ctx.client();
  const style = document.createElement("style");
  style.textContent = STYLE + UI_STYLE;
  const heading = document.createElement("h3");
  heading.className = "sec-title";
  heading.tabIndex = -1;
  heading.textContent = ctx.text("nav.account");
  el.append(style, heading);

  let disposed = false;
  let seq = 0;
  let view: ViewResult<AccountInfo> = { state: "loading" };
  let signingOut = false;
  let signOutFailed = false;
  let confirming: ConfirmBox | undefined;

  const signedOut = document.createElement("p");
  signedOut.className = "note";
  signedOut.textContent = ctx.text("account.signed_out");

  // Signed-in layout: identity and facts on the left, At a glance on the right.
  const cols = document.createElement("div");
  cols.className = "account-cols";

  const left = document.createElement("div");
  const identity = document.createElement("div");
  identity.className = "account-ident";
  const avatar = document.createElement("div");
  avatar.className = "account-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const who = document.createElement("div");
  who.style.minWidth = "0";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = ctx.text("account.signed_in_as");
  const name = document.createElement("p");
  name.className = "name";
  const idline = document.createElement("div");
  idline.className = "account-idline";
  const did = document.createElement("span");
  did.className = "account-did";
  const copy = actionButton(ctx.text("account.copy_did"));
  idline.append(did, copy);
  who.append(eyebrow, name, idline);
  identity.append(avatar, who);

  const status = document.createElement("p");
  status.className = "note";

  const facts = document.createElement("dl");
  facts.className = "account-kv";
  const sessionRow = document.createElement("div");
  const sessionLabel = document.createElement("dt");
  sessionLabel.textContent = ctx.text("account.session.label");
  const sessionValue = document.createElement("dd");
  sessionRow.append(sessionLabel, sessionValue);
  const appRow = document.createElement("div");
  const appLabel = document.createElement("dt");
  appLabel.textContent = ctx.text("account.app.label");
  const appValue = document.createElement("dd");
  const appName = document.createTextNode("");
  const appHost = document.createElement("span");
  appHost.className = "account-host";
  appValue.append(appName, appHost);
  appRow.append(appLabel, appValue);
  facts.append(sessionRow, appRow);

  const signOutBtn = actionButton(ctx.text("account.signout.button"));
  signOutBtn.classList.add("account-signout");
  const signOutNote = document.createElement("p");
  signOutNote.className = "note";
  signOutNote.textContent = ctx.text("account.signout.failed");
  const confirmHost = document.createElement("div");
  confirmHost.hidden = true;

  left.append(identity, status, facts, signOutBtn, signOutNote, confirmHost);

  const right = document.createElement("div");
  const glanceTitle = document.createElement("h4");
  glanceTitle.className = "label";
  glanceTitle.textContent = ctx.text("account.glance.title");
  const glance = document.createElement("div");
  glance.className = "glance account-glance";
  for (const entry of GLANCE) {
    if (entry.devOnly && client?.requests === undefined) continue;
    glance.append(
      glanceRow({
        label: ctx.text(entry.labelCode),
        sublabel: ctx.text(entry.subCode),
        onOpen: () => ctx.openSection(entry.id),
      }),
    );
  }
  right.append(glanceTitle, glance);

  cols.append(left, right);
  el.append(signedOut, cols);

  if (ctx.canHideButton()) {
    const block = document.createElement("div");
    block.className = "section";
    const title = document.createElement("h4");
    title.className = "label";
    title.textContent = ctx.text("account.button.title");
    const body = document.createElement("p");
    body.className = "note";
    body.textContent = ctx.text("account.button.body");
    const hide = actionButton(ctx.text("panel.hide"));
    hide.addEventListener("click", () => ctx.hideButton());
    block.append(title, body, hide);
    el.append(block);
  }

  function render(): void {
    if (disposed) return;
    const signed = client?.signedIn() === true;
    signedOut.hidden = signed;
    cols.hidden = !signed;
    if (!signed) return;

    const ready = view.state === "ready" ? view.data : undefined;
    status.hidden = ready !== undefined;
    status.textContent =
      view.state === "loading" ? ctx.text("account.loading") : ready === undefined ? ctx.text("account.unavailable") : "";
    identity.hidden = ready === undefined;
    facts.hidden = ready === undefined;
    if (ready !== undefined) {
      const label = ready.displayName ?? ready.did;
      name.textContent = label;
      avatar.textContent = label.charAt(0).toUpperCase();
      did.textContent = ready.did;
      sessionRow.hidden = ready.sessionExpiresAt === undefined;
      if (ready.sessionExpiresAt !== undefined) {
        const { hours, minutes } = remaining(ready.sessionExpiresAt, Date.now());
        sessionValue.textContent = ctx
          .text("account.session.expires")
          .replace("{hours}", String(hours))
          .replace("{minutes}", String(minutes).padStart(2, "0"));
      }
      appName.textContent = ready.appName;
      appHost.textContent = ready.appHost ?? "";
      appHost.hidden = ready.appHost === undefined;
    }

    signOutBtn.hidden = client?.signOut === undefined;
    signOutBtn.disabled = signingOut;
    signOutNote.hidden = !signOutFailed;
  }

  function closeConfirm(): void {
    confirming = undefined;
    confirmHost.replaceChildren();
    confirmHost.hidden = true;
  }

  async function runSignOut(): Promise<void> {
    if (!client?.signOut || signingOut) return;
    signingOut = true;
    signOutFailed = false;
    if (confirming) {
      confirming.confirm.disabled = true;
      confirming.cancel.disabled = true;
      confirming.confirm.textContent = ctx.text("account.signout.busy");
    }
    render();

    let ok = true;
    try {
      await client.signOut();
    } catch {
      ok = false;
    }
    signingOut = false;
    if (disposed) return;
    closeConfirm();
    if (ok) {
      // The panel stays open and shows the signed-out state, as in the mockup.
      await load();
      heading.focus();
      return;
    }
    signOutFailed = true;
    render();
    signOutBtn.focus();
  }

  function openConfirm(): void {
    if (confirming) return;
    const box = confirmBox({
      question: ctx.text("account.signout.question"),
      cancelLabel: ctx.text("account.signout.cancel"),
      confirmLabel: ctx.text("account.signout.confirm"),
      onCancel: () => {
        closeConfirm();
        signOutBtn.focus();
      },
      onConfirm: () => void runSignOut(),
    });
    confirming = box;
    confirmHost.replaceChildren(box.el);
    confirmHost.hidden = false;
    // The safe action takes focus, so Enter keeps the session.
    box.cancel.focus();
  }

  signOutBtn.addEventListener("click", () => openConfirm());

  async function copyDid(): Promise<void> {
    if (view.state !== "ready") return;
    let ok = true;
    try {
      await navigator.clipboard.writeText(view.data.did);
    } catch {
      ok = false;
    }
    ctx.toast(
      ok ? { kind: "success", textCode: "account.copied" } : { kind: "error", textCode: "account.copy_failed" },
    );
  }
  copy.addEventListener("click", () => void copyDid());

  async function load(): Promise<void> {
    const token = ++seq;
    const data = client?.data;
    if (!data) {
      view = { state: "error", code: "unavailable" };
      render();
      return;
    }
    // A refetch keeps the previous facts on screen; `loading` shows only with none.
    view = view.state === "ready" ? view : { state: "loading" };
    render();
    let next: ViewResult<AccountInfo>;
    try {
      next = await data.account();
    } catch {
      next = { state: "error", code: "unknown" };
    }
    if (disposed || token !== seq) return;
    view = next;
    render();
  }

  const offReset = client?.onReset(() => void load());
  // The session countdown is minute-grained, so one tick a minute is enough.
  const timer = setInterval(render, 60_000);
  void load();

  return () => {
    disposed = true;
    clearInterval(timer);
    offReset?.();
    el.replaceChildren();
  };
}

export const accountSection: PanelSection = {
  id: "account",
  labelCode: "nav.account",
  isAvailable: alwaysAvailable,
  mount: mountAccount,
};
