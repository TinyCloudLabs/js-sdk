import type { HostContext, PanelSection } from "../slots";
import { alwaysAvailable } from "./placeholder";

/**
 * Overview. Hiding the launcher lives here, not in the header, so the header
 * stays to brand, layout, and close. Hidden when the app has no launcher.
 */
function mountAccount(el: HTMLElement, ctx: HostContext): () => void {
  const heading = document.createElement("h3");
  heading.className = "sec-title";
  heading.textContent = ctx.text("nav.account");
  el.append(heading);
  if (!ctx.canHideButton()) return () => undefined;

  const block = document.createElement("div");
  block.className = "section";
  const title = document.createElement("h4");
  title.className = "label";
  title.textContent = ctx.text("account.button.title");
  const body = document.createElement("p");
  body.className = "note";
  body.textContent = ctx.text("account.button.body");
  const hide = document.createElement("button");
  hide.type = "button";
  hide.className = "action";
  hide.textContent = ctx.text("panel.hide");
  hide.addEventListener("click", () => ctx.hideButton());
  block.append(title, body, hide);
  el.append(block);
  return () => undefined;
}

export const accountSection: PanelSection = {
  id: "account",
  labelCode: "nav.account",
  isAvailable: alwaysAvailable,
  mount: mountAccount,
};
