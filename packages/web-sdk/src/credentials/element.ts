import { CredentialError, canonicalMailbox, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import type { CredentialAcquisitionTheme, CredentialInputRequest, CredentialInteractionSurface, CredentialProofSubject, InlineCredentialProofRequest, PrimitiveStepResult } from "./types";

export const TINYCLOUD_CREDENTIAL_ACQUISITION_TAG = "tinycloud-credential-acquisition";

/** Length of the mailbox code OpenCredentials issues for the `mailbox_otp` step. */
export const MAILBOX_OTP_LENGTH = 8;

const ElementBase: typeof HTMLElement = (globalThis.HTMLElement ?? class {}) as unknown as typeof HTMLElement;
const SVG_NS = "http://www.w3.org/2000/svg";

function safeColor(value: string | undefined): string | undefined {
  return value !== undefined && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|rgb\([0-9., %]+\))$/.test(value) ? value : undefined;
}

function cancelled(): CredentialError {
  return new CredentialError("CANCELED", "Credential acquisition was canceled");
}

/**
 * Reduces typed, pasted, or autofilled text to the mailbox code digits.
 * Full-width digits are folded to ASCII, and a pasted sentence contributes
 * only its first eight-digit group (optionally split as `1234 5678`).
 */
export function normalizeMailboxCode(value: string): string {
  const text = value.normalize("NFKC");
  const grouped = /(?:^|[^0-9])([0-9]{4}[\s-]?[0-9]{4})(?![0-9])/.exec(text)?.[1];
  return (grouped ?? text).replace(/[^0-9]/g, "").slice(0, MAILBOX_OTP_LENGTH);
}

// Host pages theme the view through inherited `--tinycloud-credential-*`
// properties; the private `--_*` tokens only supply light and dark defaults.
const STYLES = `
:host{--_accent:var(--tinycloud-credential-accent,#2a56f6);--_accent-ink:var(--tinycloud-credential-accent-text,#fff);--_surface:var(--tinycloud-credential-background,#fff);--_text:var(--tinycloud-credential-text,#1a1c21);--_muted:var(--tinycloud-credential-muted,#536176);--_line:var(--tinycloud-credential-line,#cfd8e6);--_field:var(--tinycloud-credential-field,#f8f9fb);--_field-line:var(--tinycloud-credential-field-line,#7a8497);--_danger:var(--tinycloud-credential-danger,#9f1d2d);--_success:var(--tinycloud-credential-success,#17663a);--_radius:var(--tinycloud-credential-radius,12px);--_mono:var(--tinycloud-credential-mono,ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace);--_ease:cubic-bezier(.16,1,.3,1);display:block;color:var(--_text);font:inherit;font-family:var(--tinycloud-credential-font,inherit);line-height:1.5}
@media (prefers-color-scheme:dark){:host{--_accent:var(--tinycloud-credential-accent,#6a91ff);--_accent-ink:var(--tinycloud-credential-accent-text,#081021);--_surface:var(--tinycloud-credential-background,#12151e);--_text:var(--tinycloud-credential-text,#e2e8f0);--_muted:var(--tinycloud-credential-muted,#a4afbf);--_line:var(--tinycloud-credential-line,#2c3445);--_field:var(--tinycloud-credential-field,#0b0e14);--_field-line:var(--tinycloud-credential-field-line,#626d80);--_danger:var(--tinycloud-credential-danger,#ff9da8);--_success:var(--tinycloud-credential-success,#7ddc9f)}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.card{width:100%;max-width:30rem;padding:clamp(20px,5vw,28px);border:1px solid var(--_line);border-radius:var(--_radius);background:var(--_surface);color:var(--_text)}
.mark{display:grid;width:40px;height:40px;place-items:center;border-radius:50%;background:color-mix(in srgb,var(--_accent) 12%,transparent);color:var(--_accent)}
.mark svg,.error svg,.status svg{flex:none}
h2{margin:16px 0 0;font-size:1.25rem;line-height:1.25;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
.lede{max-width:44ch;margin:6px 0 0;color:var(--_muted);text-wrap:pretty}
.subject{color:var(--_text);font-weight:600;overflow-wrap:anywhere}
form{margin:20px 0 0}
.label{display:block;margin:0 0 8px;font-size:.875rem;font-weight:600}
.otp{position:relative;max-width:26rem}
.otp input{position:absolute;inset:0;z-index:1;width:100%;height:100%;margin:0;padding:0;border:0;outline:0;background:transparent;color:transparent;-webkit-text-fill-color:transparent;caret-color:transparent;font:16px/1 var(--_mono);letter-spacing:-.5em;cursor:text}
.otp input::selection{background:transparent}
.otp input:disabled{cursor:progress}
.slots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) 8px repeat(4,minmax(0,1fr));gap:clamp(3px,1.2vw,6px)}
.slot{display:grid;min-width:0;height:clamp(48px,13vw,56px);place-items:center;border:1px solid var(--_field-line);border-radius:8px;background:var(--_field);font:600 clamp(1.15rem,4.6vw,1.45rem)/1 var(--_mono);font-variant-numeric:tabular-nums;transition:border-color 160ms ease-out,box-shadow 160ms ease-out,background-color 160ms ease-out}
.slot[data-filled]{border-color:color-mix(in srgb,var(--_text) 55%,var(--_field-line))}
.divider{align-self:center;justify-self:center;width:6px;height:2px;border-radius:1px;background:var(--_field-line)}
.otp:focus-within .slot[data-active]{border-color:var(--_accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--_accent) 24%,transparent)}
.otp:focus-within .slot[data-active]:not([data-filled])::after{content:"";width:2px;height:1.1em;border-radius:1px;background:var(--_text);animation:caret 1.1s steps(1) infinite}
.otp[data-invalid] .slot{border-color:var(--_danger)}
.otp[data-invalid] .slots{animation:nudge 320ms var(--_ease)}
.otp[data-busy] .slot{opacity:.62}
.field{display:block;width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--_field-line);border-radius:8px;background:var(--_field);color:var(--_text);font:inherit;font-size:max(16px,1rem)}
.field:focus-visible{border-color:var(--_accent);outline:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--_accent) 24%,transparent)}
.hint{max-width:44ch;margin:10px 0 0;color:var(--_muted);font-size:.875rem;text-wrap:pretty}
.error{display:flex;gap:8px;align-items:flex-start;max-width:44ch;margin:10px 0 0;color:var(--_danger);font-size:.875rem;font-weight:550}
.error svg{margin-top:.2em}
.actions{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin-top:20px}
button{display:inline-flex;gap:8px;align-items:center;justify-content:center;min-height:44px;font:inherit;cursor:pointer;touch-action:manipulation}
.primary{padding:10px 20px;border:1px solid var(--_accent);border-radius:999px;background:var(--_accent);color:var(--_accent-ink);font-weight:600;transition:filter 160ms ease-out,transform 160ms var(--_ease)}
.primary:hover:not(:disabled){filter:brightness(1.08)}
.primary:active:not(:disabled){transform:translateY(1px)}
.primary:disabled{cursor:progress;opacity:.72}
.quiet{padding:6px 2px;border:0;background:transparent;color:var(--_text);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.quiet:hover:not(:disabled){text-decoration-thickness:2px}
.quiet:disabled{cursor:default;opacity:.5}
button:focus-visible{outline:2px solid var(--_accent);outline-offset:3px}
.status{display:flex;gap:10px;align-items:center;min-height:1.5em;margin:16px 0 0;color:var(--_muted);font-size:.875rem}
.status:empty{display:none}
.card[data-phase=working] .status,.card[data-phase=done] .status{margin-top:20px;color:var(--_text);font-size:.9375rem}
.card[data-phase=done] .status{color:var(--_success);font-weight:600}
.spinner{flex:none;width:16px;height:16px;border:2px solid color-mix(in srgb,currentColor 22%,transparent);border-top-color:var(--_accent);border-radius:50%;animation:spin 700ms linear infinite}
.primary .spinner{border-color:color-mix(in srgb,var(--_accent-ink) 35%,transparent);border-top-color:var(--_accent-ink)}
.check path{stroke-dasharray:24;stroke-dashoffset:24;animation:draw 420ms var(--_ease) forwards}
@keyframes spin{to{transform:rotate(1turn)}}
@keyframes caret{50%{opacity:0}}
@keyframes nudge{20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}.spinner{animation:spin 1.6s linear infinite!important}}
@media (forced-colors:active){.slots{display:none}.otp input{position:static;min-height:48px;padding:10px 12px;border:1px solid CanvasText;color:CanvasText;-webkit-text-fill-color:CanvasText;caret-color:CanvasText;letter-spacing:.3em}}
`;

function svg(paths: readonly string[], className?: string, size = 20): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", String(size));
  icon.setAttribute("height", String(size));
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  if (className) icon.setAttribute("class", className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

const MAIL_ICON = ["M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z", "m3.5 7 8.5 6 8.5-6"];
const SHIELD_ICON = ["M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3Z"];
const ALERT_ICON = ["M12 8v5", "M12 16.5v.01", "M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z"];
const CHECK_ICON = ["m5 12.5 4.5 4.5L19 7.5"];

function spinner(): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = "spinner";
  node.setAttribute("aria-hidden", "true");
  return node;
}

function codeLabel(subject: CredentialProofSubject | undefined): (HTMLElement | string)[] {
  if (subject === undefined) return ["your mailbox"];
  const strong = document.createElement("strong");
  strong.className = "subject";
  strong.textContent = subject.value;
  return [strong];
}

function minutes(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 60) return undefined;
  const count = Math.round(seconds / 60);
  return `${count} minute${count === 1 ? "" : "s"}`;
}

/** SDK-owned Shadow-DOM view. It is deliberately unaware of locators, verifiers, sessions, and transport. */
export class TinyCloudCredentialAcquisitionElement extends ElementBase {
  private root?: ShadowRoot;
  private resolver?: (proof: PrimitiveStepResult) => void;
  private inputResolver?: (inputs: Readonly<Record<string, string>>) => void;
  private rejecter?: (reason: unknown) => void;
  private closed = false;
  private subject?: CredentialProofSubject;
  private mailboxDomain?: string;
  private codeTtlSeconds?: number;

  connectedCallback(): void {
    this.root ??= this.attachShadow({ mode: "open" });
    if (!this.root.querySelector(".card")) this.renderShell();
  }

  disconnectedCallback(): void { this.cancel(); }

  configure(theme?: CredentialAcquisitionTheme): void {
    const style = this.style;
    const accent = safeColor(theme?.accentColor);
    const background = safeColor(theme?.backgroundColor);
    const text = safeColor(theme?.textColor);
    if (accent) style.setProperty("--tinycloud-credential-accent", accent);
    if (background) style.setProperty("--tinycloud-credential-background", background);
    if (text) style.setProperty("--tinycloud-credential-text", text);
  }

  /** Context known before the first proof request, used for the opening state. */
  prepare(input: { readonly subject?: CredentialProofSubject; readonly mailboxDomain?: string; readonly codeTtlSeconds?: number }): void {
    this.subject = input.subject;
    this.mailboxDomain = input.mailboxDomain;
    this.codeTtlSeconds = input.codeTtlSeconds;
  }

  async requestProof(request: InlineCredentialProofRequest): Promise<PrimitiveStepResult> {
    if (this.closed) throw cancelled();
    this.renderPrompt(request);
    return new Promise<PrimitiveStepResult>((resolve, reject) => { this.resolver = resolve; this.rejecter = reject; });
  }

  /** Collects inputs the requirement does not carry, such as the recipient's own mailbox. */
  async requestInputs(request: CredentialInputRequest): Promise<Readonly<Record<string, string>>> {
    if (this.closed) throw cancelled();
    const shell = this.renderShell();
    shell.live.replaceChildren();
    const form = request.mailboxDomain !== undefined && request.inputs.length === 1 && request.inputs[0]!.id === "email"
      ? this.mailboxEntryForm(request.mailboxDomain, shell)
      : this.collectForm(request, shell);
    shell.body.replaceChildren(form);
    form.querySelector<HTMLButtonElement>("[data-cancel]")!.addEventListener("click", () => this.cancel(), { once: true });
    queueMicrotask(() => form.querySelector<HTMLInputElement>("input")?.focus());
    return new Promise((resolve, reject) => { this.inputResolver = resolve; this.rejecter = reject; });
  }

  report(state: "signing" | "verifying" | "saving" | "success" | "recovery", message?: string): void {
    if (!this.root || this.closed) return;
    const card = this.root.querySelector<HTMLElement>(".card");
    const live = this.root.querySelector<HTMLElement>("[data-live]");
    if (!card || !live) return;
    const text = message ?? ({
      signing: "Confirming with your active TinyCloud key…",
      verifying: "Verifying credential…",
      saving: "Saving credential…",
      success: this.subject === undefined ? "Credential acquired." : "Email verified.",
      recovery: "Credential acquisition needs attention.",
    }[state]);
    if (state !== "recovery") {
      // The proof was accepted: the form has nothing further to collect.
      card.dataset.phase = state === "success" ? "done" : "working";
      this.root.querySelector<HTMLElement>("form")?.setAttribute("hidden", "");
    }
    live.replaceChildren(...(state === "success" ? [svg(CHECK_ICON, "check", 18)] : state === "recovery" ? [] : [spinner()]), text);
  }

  finish(): void { this.report("success"); }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejecter?.(cancelled());
    this.resolver = undefined;
    this.inputResolver = undefined;
    this.rejecter = undefined;
  }

  isClosed(): boolean { return this.closed; }

  private renderShell(): { readonly card: HTMLElement; readonly title: HTMLElement; readonly lede: HTMLElement; readonly body: HTMLElement; readonly live: HTMLElement } {
    this.root ??= this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    const card = document.createElement("section");
    card.className = "card";
    card.setAttribute("aria-labelledby", "title");
    const mark = document.createElement("div");
    mark.className = "mark";
    mark.append(svg(this.subject === undefined && this.mailboxDomain === undefined ? SHIELD_ICON : MAIL_ICON));
    const title = document.createElement("h2");
    title.id = "title";
    const lede = document.createElement("p");
    lede.className = "lede";
    lede.id = "lede";
    lede.dataset.description = "";
    const body = document.createElement("div");
    body.dataset.form = "";
    const live = document.createElement("p");
    live.className = "status";
    live.dataset.live = "";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    if (this.subject === undefined && this.mailboxDomain !== undefined) {
      title.textContent = "Verify your email";
      live.append(spinner(), "Preparing email verification…");
    } else if (this.subject === undefined) {
      title.textContent = "Credential check";
      live.append(spinner(), "Preparing credential acquisition…");
    } else {
      title.textContent = "Verify your email";
      lede.append(`We’re sending an ${MAILBOX_OTP_LENGTH}-digit code to `, ...codeLabel(this.subject), ".");
      live.append(spinner(), "Sending your code…");
    }
    card.append(mark, title, lede, body, live);
    this.root.replaceChildren(style, card);
    return { card, title, lede, body, live };
  }

  private renderPrompt(request: InlineCredentialProofRequest): void {
    const shell = this.renderShell();
    shell.live.replaceChildren();
    const form = request.stepId === "mailbox_otp" ? this.mailboxForm(request, shell) : this.inputForm(request, shell);
    shell.body.replaceChildren(form);
    form.querySelector<HTMLButtonElement>("[data-cancel]")!.addEventListener("click", () => this.cancel(), { once: true });
    queueMicrotask(() => form.querySelector<HTMLInputElement>("input")?.focus());
  }

  private settleInputs(inputs: Readonly<Record<string, string>>): void {
    const resolve = this.inputResolver;
    this.inputResolver = undefined;
    this.rejecter = undefined;
    resolve?.(inputs);
  }

  private mailboxEntryForm(domain: string, shell: ReturnType<TinyCloudCredentialAcquisitionElement["renderShell"]>): HTMLFormElement {
    shell.title.textContent = "Enter your email";
    const at = document.createElement("strong");
    at.className = "subject";
    at.textContent = `@${domain}`;
    shell.lede.replaceChildren("Use your own address at ", at, `. We’ll send an ${MAILBOX_OTP_LENGTH}-digit code there.`);
    const form = document.createElement("form");
    form.noValidate = true;
    const label = document.createElement("label");
    label.className = "label";
    label.htmlFor = "mailbox";
    label.textContent = "Email address";
    const input = document.createElement("input");
    input.className = "field";
    input.id = "mailbox";
    input.name = "email";
    input.type = "email";
    input.inputMode = "email";
    input.autocomplete = "email";
    input.required = true;
    input.spellcheck = false;
    input.placeholder = `name@${domain}`;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("enterkeyhint", "send");
    input.setAttribute("aria-describedby", "mailbox-hint mailbox-error");
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.id = "mailbox-hint";
    hint.textContent = "The code proves you can read that inbox. The address you verify is shared with the file owner’s TinyCloud node.";
    const error = document.createElement("p");
    error.className = "error";
    error.id = "mailbox-error";
    error.hidden = true;
    const { actions } = this.actions("Send code");
    form.append(label, input, hint, error, actions);
    const showError = (message: string) => {
      error.replaceChildren(svg(ALERT_ICON, undefined, 16), message);
      error.hidden = false;
      error.setAttribute("role", "alert");
      input.setAttribute("aria-invalid", "true");
      input.focus();
    };
    input.addEventListener("input", () => { error.hidden = true; error.removeAttribute("role"); input.removeAttribute("aria-invalid"); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const mailbox = canonicalMailbox(input.value);
      if (mailbox === undefined) { showError(`Enter an email address like name@${domain}.`); return; }
      // Exact equality only: subdomains and look-alike suffixes are other domains.
      if (mailbox.domain !== domain) { showError(`This invitation needs an address at @${domain}. @${mailbox.domain} is a different domain.`); return; }
      this.subject = { kind: "email", value: mailbox.email };
      this.renderShell();
      this.settleInputs({ email: mailbox.email });
    });
    return form;
  }

  private collectForm(request: CredentialInputRequest, shell: ReturnType<TinyCloudCredentialAcquisitionElement["renderShell"]>): HTMLFormElement {
    shell.title.textContent = "Credential check";
    const form = document.createElement("form");
    form.noValidate = true;
    for (const field of request.inputs) {
      const label = document.createElement("label");
      label.className = "label";
      label.textContent = field.label;
      const input = document.createElement("input");
      input.className = "field";
      input.required = true;
      input.name = field.id;
      input.type = field.schema.format === "email" ? "email" : "text";
      input.autocomplete = "off";
      label.append(input);
      form.append(label);
    }
    const { actions } = this.actions("Continue");
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      new FormData(form).forEach((value, key) => { values[key] = String(value).trim(); });
      if (Object.values(values).some((value) => value.length === 0)) { shell.live.textContent = "Complete the required field to continue."; return; }
      this.settleInputs(values);
    });
    return form;
  }

  private settle(proof: PrimitiveStepResult): void {
    this.resolver?.(proof);
    this.resolver = undefined;
    this.rejecter = undefined;
  }

  private actions(label: string): { readonly actions: HTMLDivElement; readonly submit: HTMLButtonElement; readonly cancel: HTMLButtonElement } {
    const actions = document.createElement("div");
    actions.className = "actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary";
    submit.textContent = label;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet";
    cancel.dataset.cancel = "";
    cancel.textContent = "Cancel";
    actions.append(submit, cancel);
    return { actions, submit, cancel };
  }

  private mailboxForm(request: InlineCredentialProofRequest, shell: ReturnType<TinyCloudCredentialAcquisitionElement["renderShell"]>): HTMLFormElement {
    shell.title.textContent = "Check your email";
    shell.lede.replaceChildren(`Enter the ${MAILBOX_OTP_LENGTH}-digit code we sent to `, ...codeLabel(this.subject), ".");
    const form = document.createElement("form");
    form.noValidate = true;
    const label = document.createElement("label");
    label.className = "label";
    label.htmlFor = "otp";
    label.textContent = "Verification code";
    const field = document.createElement("div");
    field.className = "otp";
    const input = document.createElement("input");
    input.id = "otp";
    input.name = "otp";
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.pattern = `[0-9]{${MAILBOX_OTP_LENGTH}}`;
    input.required = true;
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("enterkeyhint", "done");
    input.setAttribute("aria-describedby", "otp-hint otp-error");
    const slots = document.createElement("div");
    slots.className = "slots";
    slots.setAttribute("aria-hidden", "true");
    const cells: HTMLSpanElement[] = [];
    for (let index = 0; index < MAILBOX_OTP_LENGTH; index += 1) {
      if (index === MAILBOX_OTP_LENGTH / 2) {
        const divider = document.createElement("span");
        divider.className = "divider";
        slots.append(divider);
      }
      const cell = document.createElement("span");
      cell.className = "slot";
      cells.push(cell);
      slots.append(cell);
    }
    field.append(input, slots);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.id = "otp-hint";
    const ttl = minutes(this.codeTtlSeconds);
    hint.textContent = `${ttl === undefined ? "The code expires soon" : `The code expires in ${ttl}`}. If it hasn’t arrived, check your spam or junk folder.`;
    const error = document.createElement("p");
    error.className = "error";
    error.id = "otp-error";
    error.hidden = true;
    const { actions, submit, cancel } = this.actions("Verify email");
    form.append(label, field, hint, error, actions);

    const showError = (message: string) => {
      error.replaceChildren(svg(ALERT_ICON, undefined, 16), message);
      error.hidden = false;
      error.setAttribute("role", "alert");
      input.setAttribute("aria-invalid", "true");
      field.removeAttribute("data-invalid");
      void field.offsetWidth;
      field.dataset.invalid = "";
    };
    const clearError = () => {
      error.hidden = true;
      error.removeAttribute("role");
      input.removeAttribute("aria-invalid");
      field.removeAttribute("data-invalid");
    };
    let code = "";
    const paint = () => {
      const value = code;
      cells.forEach((cell, index) => {
        cell.textContent = value[index] ?? "";
        cell.toggleAttribute("data-filled", index < value.length);
        cell.toggleAttribute("data-active", index === Math.min(value.length, MAILBOX_OTP_LENGTH - 1));
      });
    };
    let busy = false;
    const submitCode = () => {
      if (busy) return;
      if (code.length !== MAILBOX_OTP_LENGTH) {
        showError(`Enter all ${MAILBOX_OTP_LENGTH} digits of the code.`);
        input.focus();
        return;
      }
      busy = true;
      clearError();
      input.readOnly = true;
      field.dataset.busy = "";
      submit.disabled = true;
      cancel.disabled = true;
      submit.replaceChildren(spinner(), "Verifying…");
      shell.live.replaceChildren(spinner(), "Checking your code…");
      this.settle({ otp: code });
    };
    const setValue = (next: string) => {
      const previous = code;
      code = next;
      input.value = next;
      paint();
      if (next !== previous) clearError();
      // Autofill and paste deliver the whole code at once; submitting then
      // spares a second step. Typing the last digit behaves the same way.
      if (next.length === MAILBOX_OTP_LENGTH && previous.length < MAILBOX_OTP_LENGTH) submitCode();
    };
    input.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text");
      if (text === undefined || busy) return;
      event.preventDefault();
      setValue(normalizeMailboxCode(text));
    });
    input.addEventListener("input", () => {
      if (busy) { input.value = code; return; }
      setValue(normalizeMailboxCode(input.value));
    });
    // The digits are always edited from the end, like a single text field.
    const keepCaretAtEnd = () => { const end = input.value.length; input.setSelectionRange?.(end, end); };
    input.addEventListener("focus", keepCaretAtEnd);
    input.addEventListener("click", keepCaretAtEnd);
    input.addEventListener("keyup", keepCaretAtEnd);
    form.addEventListener("submit", (event) => { event.preventDefault(); submitCode(); });
    paint();

    if (request.feedback?.kind === "rejected") {
      const remaining = request.feedback.attemptsRemaining;
      showError(`That code didn’t match. You can try ${remaining} more time${remaining === 1 ? "" : "s"}.`);
    }
    return form;
  }

  private inputForm(request: InlineCredentialProofRequest, shell: ReturnType<TinyCloudCredentialAcquisitionElement["renderShell"]>): HTMLFormElement {
    shell.lede.textContent = request.display.description;
    const form = document.createElement("form");
    form.noValidate = true;
    for (const field of request.inputs) {
      const label = document.createElement("label");
      label.className = "label";
      label.textContent = field.label;
      const input = document.createElement("input");
      input.className = "field";
      input.required = true;
      input.name = field.id;
      input.type = field.schema.format === "email" ? "email" : "text";
      input.inputMode = field.schema.format === "email" ? "email" : "text";
      input.autocomplete = "off";
      label.append(input);
      form.append(label);
    }
    const consent = document.createElement("p");
    consent.className = "hint";
    consent.textContent = request.display.consent;
    const { actions } = this.actions("Continue");
    form.append(consent, actions);
    shell.live.setAttribute("aria-live", request.display.errorLiveRegion);
    shell.live.textContent = request.display.progressLabel;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      new FormData(form).forEach((value, key) => { values[key] = String(value).trim(); });
      if (Object.values(values).some((value) => value.length === 0)) { shell.live.textContent = "Complete the required field to continue."; return; }
      this.settle(values);
      shell.live.setAttribute("aria-live", "polite");
      shell.live.textContent = "Submitting proof…";
    }, { once: true });
    return form;
  }
}

/** Registers the element once in a browser document. */
export function defineTinyCloudCredentialAcquisitionElement(): void {
  if (typeof customElements === "undefined" || customElements.get(TINYCLOUD_CREDENTIAL_ACQUISITION_TAG)) return;
  customElements.define(TINYCLOUD_CREDENTIAL_ACQUISITION_TAG, TinyCloudCredentialAcquisitionElement);
}

/** Controller that turns the SDK element into the safe low-level inline interaction surface. */
export class CredentialAcquisitionController {
  private element?: TinyCloudCredentialAcquisitionElement;
  constructor(private readonly options: { readonly descriptor: CredentialFlowDescriptor; readonly mountTarget?: Element | string; readonly theme?: CredentialAcquisitionTheme; readonly subject?: CredentialProofSubject; readonly mailboxDomain?: string }) {}

  async start(input: { readonly signal?: AbortSignal }): Promise<CredentialInteractionSurface> {
    if (typeof document === "undefined") throw new CredentialError("UNSUPPORTED_PROFILE", "Inline credential acquisition requires a browser document");
    defineTinyCloudCredentialAcquisitionElement();
    const target = this.target();
    const element = document.createElement(TINYCLOUD_CREDENTIAL_ACQUISITION_TAG) as TinyCloudCredentialAcquisitionElement;
    element.configure(this.options.theme);
    element.prepare({ subject: this.options.subject, mailboxDomain: this.options.mailboxDomain, codeTtlSeconds: this.options.descriptor.lifecycle.challengeTtlSeconds });
    target.append(element);
    this.element = element;
    input.signal?.addEventListener("abort", () => element.cancel(), { once: true });
    return { wake: async () => undefined, close: () => element.remove(), closed: () => element.isClosed(), requestProof: (request) => element.requestProof(request), requestInputs: (request) => element.requestInputs(request) };
  }

  progress(state: "signing" | "verifying" | "saving" | "success" | "recovery"): void { this.element?.report(state); }
  finish(): void { this.element?.finish(); }
  fail(): void { this.element?.report("recovery"); }

  private target(): Element {
    const target = typeof this.options.mountTarget === "string" ? document.querySelector(this.options.mountTarget) : this.options.mountTarget;
    if (target) return target;
    if (!document.body) throw new CredentialError("UNSUPPORTED_PROFILE", "Inline credential acquisition requires a document body");
    return document.body;
  }
}
