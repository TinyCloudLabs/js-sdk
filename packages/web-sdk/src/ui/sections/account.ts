import type { AccountInfo, ViewResult } from "../data";
import type { PanelClient, PanelSection, SectionContext } from "../slots";
import { registerPanelStrings } from "../strings-panel";
import { ACCOUNT_STRINGS } from "./account.strings";
import { alwaysAvailable } from "./placeholder";
import {
  actionButton,
  confirmBox,
  glanceRow,
  icon,
  setGlanceStatus,
  statusNode,
  UI_STYLE,
  type ConfirmBox,
} from "./ui";

registerPanelStrings(ACCOUNT_STRINGS);

const DISPLAY = '"Literata Variable","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

const STYLE = `
.account-hint{margin:-14px 0 28px;font-size:12.5px;line-height:1.4}
.account-cols{display:grid;gap:28px 36px;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));align-items:start}
.account-ident{display:flex;gap:16px;align-items:center;min-width:0}
.account-avatar{flex:none;width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font:500 30px/1 ${DISPLAY};background:#09090b;color:#fff}
.account-who{min-width:0}
.account-ident .eyebrow{margin:0;font-size:13px;font-weight:600;line-height:1.3;color:#71717a}
.account-ident .name{margin:0;font:500 1.375rem/1.2 ${DISPLAY};overflow-wrap:anywhere}
.account-idline{display:flex;flex-wrap:wrap;align-items:center;margin-top:2px;min-width:0}
.account-did{min-width:0;font:.8125rem/1.5 ${MONO};color:#71717a;overflow-wrap:anywhere}
.account-copy{flex:none}
.account-copy .ui-ic{width:16px;height:16px;stroke-width:2}
.account-kv{display:flex;flex-direction:column;margin:18px 0 0;padding:0}
.account-kv>div{display:flex;align-items:center;gap:10px;box-sizing:border-box;min-height:44px;padding:9px 0;border-bottom:1px solid #e4e4e7}
.account-kv>div:last-child{border-bottom:0}
.account-kv dt{display:flex;flex:1 1 auto;align-items:baseline;gap:10px;min-width:0;font-size:14px;white-space:nowrap}
.account-kv dt::after{content:"";flex:1 1 12px;min-width:12px;border-bottom:2px dotted #a1a1aa;transform:translateY(-3px)}
.account-kv dd{display:flex;flex:0 1 auto;align-items:center;justify-content:flex-end;gap:2px;max-width:78%;margin:0;font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.account-kv .account-host{margin-left:8px;font:400 .8125rem ${MONO};color:#71717a}
.account-signout{margin-top:14px}
.account-glance{display:flex;flex-direction:column;gap:0}
.account-rule{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:13px;font-weight:600;line-height:1.3;letter-spacing:.02em}
.account-rule::after{content:"";flex:1;height:1px;background:#e4e4e7}
.account-button{display:flex;flex-direction:column;align-items:flex-start;gap:12px;margin-top:28px}
.account-button>*{margin:0}
.account-button .account-rule{align-self:stretch;margin:0}
.account-small{max-width:60ch;font-size:14px;line-height:1.45}
.account-devnote{display:flex;gap:12px;align-items:flex-start;box-sizing:border-box;width:100%;padding:14px 16px;border-radius:12px;box-shadow:inset 0 0 0 1px #e4e4e7;font-size:13.5px;line-height:1.5}
.account-devnote .ui-ic{margin-top:2px;flex:none}
.account-devnote code{padding:1px 6px;border-radius:6px;background:#f4f4f5;font:600 .8125rem ${MONO}}
@media (prefers-color-scheme: dark){
.account-avatar{background:#fafafa;color:#09090b}
.account-ident .eyebrow,.account-did,.account-kv .account-host{color:#a1a1aa}
.account-kv>div{border-bottom-color:#69696b}
.account-kv dt::after{border-bottom-color:#71717a}
.account-rule::after{background:#69696b}
.account-devnote{box-shadow:inset 0 0 0 1px #69696b}
.account-devnote code{background:#27272a}
}
`;

/** Keeps the start and the last four characters of a long identifier, as in the mockup (did:pkh:0xEXAMPLE…c41d). */
function middleTruncate(id: string): string {
  return id.length > 26 ? `${id.slice(0, 20)}…${id.slice(-4)}` : id;
}

/** Whole hours and minutes until `expires`, rounded up to the minute, never negative. */
function remaining(expires: Date, now: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.ceil((expires.getTime() - now) / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * Overview: identity, session and app facts, sign out behind a confirm box,
 * At-a-glance rows, and the hide-button block.
 * Reads `client.data.account()`; re-reads on reset. Each row opens its section.
 * Row labels, icons and statuses come from the sections themselves
 * (`section.status(ctx)`), the same source as the page rail; the shell refreshes them.
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
  // The DID on screen: the account's when its read is ready, the one the source already knows when it failed.
  let shownDid: string | undefined;

  const signedOut = document.createElement("p");
  signedOut.className = "note";
  signedOut.textContent = ctx.text("account.signed_out");

  const hint = document.createElement("p");
  hint.className = "account-hint";
  hint.textContent = ctx.text("account.hint");

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
  who.className = "account-who";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = ctx.text("account.signed_in_as");
  const name = document.createElement("p");
  name.className = "name";
  const idline = document.createElement("div");
  idline.className = "account-idline";
  const did = document.createElement("span");
  did.className = "account-did";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "icon-btn account-copy";
  copy.setAttribute("aria-label", ctx.text("account.copy_did"));
  copy.append(icon("copy"));
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
  signOutBtn.prepend(icon("out"));
  const signOutNote = document.createElement("p");
  signOutNote.className = "note";
  signOutNote.textContent = ctx.text("account.signout.failed");
  const confirmHost = document.createElement("div");
  confirmHost.hidden = true;

  left.append(identity, status, facts, signOutBtn, signOutNote, confirmHost);

  const right = document.createElement("div");
  const glanceTitle = document.createElement("h4");
  glanceTitle.className = "account-rule";
  glanceTitle.textContent = ctx.text("account.glance.title");
  const glance = document.createElement("div");
  glance.className = "glance account-glance";
  const glanceRows: Array<{ section: PanelSection; row: HTMLButtonElement }> = [];
  for (const section of ctx.sections()) {
    if (section.id === "account" || section.summaryCode === undefined) continue;
    const row = glanceRow({
      icon: section.icon,
      label: ctx.text(section.labelCode),
      sublabel: ctx.text(section.summaryCode),
      onOpen: () => ctx.openSection(section.id),
    });
    glanceRows.push({ section, row });
    glance.append(row);
  }
  right.append(glanceTitle, glance);

  cols.append(left, right);
  el.append(signedOut, hint, cols);

  if (ctx.canHideButton()) {
    const block = document.createElement("div");
    block.className = "account-button";
    const title = document.createElement("h4");
    title.className = "account-rule";
    title.textContent = ctx.text("account.button.title");
    const body = document.createElement("p");
    body.className = "account-small";
    body.textContent = ctx.text("account.button.body").replace("{app}", ctx.appLabel() ?? ctx.text("account.button.app"));
    const hide = actionButton(ctx.text("panel.hide"));
    hide.prepend(icon("eyeoff"));
    hide.addEventListener("click", () => ctx.hideButton());
    const dev = document.createElement("div");
    dev.className = "account-devnote";
    const lead = document.createElement("b");
    lead.textContent = ctx.text("account.button.dev.lead");
    const call = document.createElement("code");
    call.textContent = "tc.ui.open()";
    const words = document.createElement("div");
    words.append(lead, ` ${ctx.text("account.button.dev.body")} `, call, `. ${ctx.text("account.button.dev.tail")}`);
    dev.append(icon("info"), words);
    block.append(title, body, hide, dev);
    el.append(block);
  }

  function render(): void {
    if (disposed) return;
    const signed = client?.signedIn() === true;
    signedOut.hidden = signed;
    // The hint points at the sidebar's switch; on the full page (and every phone) there is nothing to point at.
    hint.hidden = !signed || ctx.layout() !== "drawer";
    cols.hidden = !signed;
    if (!signed) return;

    const ready = view.state === "ready" ? view.data : undefined;
    // A failed read keeps what the panel already knows without it: the account DID and the app name.
    const knownDid = view.state === "error" ? client?.data?.knownDid?.() : undefined;
    const knownApp = view.state === "error" ? ctx.appLabel() : undefined;
    status.hidden = ready !== undefined;
    status.textContent =
      view.state === "loading" ? ctx.text("account.loading") : ready === undefined ? ctx.text("account.unavailable") : "";
    shownDid = ready?.did ?? knownDid;
    identity.hidden = shownDid === undefined;
    facts.hidden = ready === undefined && knownApp === undefined;
    if (shownDid !== undefined) {
      // With a name (ENS), the name is the title and the short DID sits under it. Without one, the short DID is
      // the title and appears once; the copy button still copies the full DID.
      const shortId = middleTruncate(shownDid);
      const label = ready?.displayName ?? shortId;
      name.textContent = label;
      name.title = ready?.displayName === undefined ? shownDid : "";
      avatar.textContent = label.charAt(0).toUpperCase();
      did.textContent = shortId;
      did.title = shownDid;
      did.hidden = ready?.displayName === undefined;
    }
    sessionRow.hidden = ready?.sessionExpiresAt === undefined;
    if (ready?.sessionExpiresAt !== undefined) {
      const { hours, minutes } = remaining(ready.sessionExpiresAt, Date.now());
      const expires = ctx
        .text("account.session.expires")
        .replace("{hours}", String(hours))
        .replace("{minutes}", String(minutes).padStart(2, "0"));
      sessionValue.replaceChildren(statusNode({ text: expires, tone: "ok" }));
    }
    const appText = ready?.appName ?? knownApp;
    appRow.hidden = appText === undefined;
    if (appText !== undefined) appName.textContent = appText;
    appHost.textContent = ready?.appHost ?? "";
    appHost.hidden = ready?.appHost === undefined;

    signOutBtn.hidden = client?.signOut === undefined;
    signOutBtn.disabled = signingOut;
    signOutNote.hidden = !signOutFailed;
  }

  /** Repaints each row's status in place from its section, so a refresh keeps focus on the row. */
  function paintGlance(): void {
    if (disposed || client?.signedIn() !== true) return;
    for (const { section, row } of glanceRows) setGlanceStatus(row, section.status(ctx));
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
    if (shownDid === undefined) return;
    const copied = shownDid;
    const generation = ctx.data.generation();
    let ok = true;
    try {
      await navigator.clipboard.writeText(copied);
    } catch {
      ok = false;
    }
    // The DID was the old account's; say nothing about it to the new one.
    if (disposed || generation !== ctx.data.generation()) return;
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
    // A refetch keeps the previous facts on screen (and a failed read's local identity); `loading` shows only with none.
    view = view.state === "ready" || view.state === "error" ? view : { state: "loading" };
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

  const offReset = client?.onReset(() => {
    // A refetch keeps the old facts on screen, which is wrong across an account change: start from loading.
    view = { state: "loading" };
    void load();
  });
  // The shell refreshes the cache on open, on data change and each minute; each refresh repaints the rows.
  const offData = ctx.data.subscribe(paintGlance);
  // A read that failed is retried once by the data source; when it settles, show it without leaving Overview.
  const offSource = client?.data?.subscribe((changed) => {
    if (changed === "overview" && view.state === "error") void load();
  });
  // The session countdown is minute-grained, so one tick a minute is enough.
  const timer = setInterval(render, 60_000);
  void load();
  paintGlance();

  return () => {
    disposed = true;
    clearInterval(timer);
    offReset?.();
    offData();
    offSource?.();
    el.replaceChildren();
  };
}

export const accountSection: PanelSection = {
  id: "account",
  labelCode: "nav.account",
  icon: "person",
  isAvailable: alwaysAvailable,
  // Overview has no status of its own while signed in; signed out says so on the rail.
  status: (ctx) =>
    ctx.client()?.signedIn() === true ? undefined : { text: ctx.text("account.status.signed_out"), tone: "off" },
  mount: mountAccount,
};
