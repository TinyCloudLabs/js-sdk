import { CredentialError, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import type { CredentialAcquisitionTheme, CredentialInteractionSurface, InlineCredentialProofRequest, PrimitiveStepResult } from "./types";

export const TINYCLOUD_CREDENTIAL_ACQUISITION_TAG = "tinycloud-credential-acquisition";

const ElementBase: typeof HTMLElement = (globalThis.HTMLElement ?? class {}) as unknown as typeof HTMLElement;

function safeColor(value: string | undefined): string | undefined {
  return value !== undefined && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|rgb\([0-9., %]+\))$/.test(value) ? value : undefined;
}

function cancelled(): CredentialError {
  return new CredentialError("CANCELED", "Credential acquisition was canceled");
}

/** SDK-owned Shadow-DOM view. It is deliberately unaware of locators, verifiers, sessions, and transport. */
export class TinyCloudCredentialAcquisitionElement extends ElementBase {
  private root?: ShadowRoot;
  private resolver?: (proof: PrimitiveStepResult) => void;
  private rejecter?: (reason: unknown) => void;
  private closed = false;

  connectedCallback(): void {
    this.root ??= this.attachShadow({ mode: "closed" });
    this.renderShell();
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

  async requestProof(request: InlineCredentialProofRequest): Promise<PrimitiveStepResult> {
    if (this.closed) throw cancelled();
    this.renderPrompt(request);
    return new Promise<PrimitiveStepResult>((resolve, reject) => { this.resolver = resolve; this.rejecter = reject; });
  }

  report(state: "signing" | "verifying" | "saving" | "success" | "recovery", message?: string): void {
    if (!this.root || this.closed) return;
    const live = this.root.querySelector<HTMLElement>("[data-live]");
    if (live) live.textContent = message ?? ({ signing: "Confirming with your active TinyCloud key…", verifying: "Verifying credential…", saving: "Saving credential…", success: "Credential acquired.", recovery: "Credential acquisition needs attention." }[state]);
  }

  finish(): void { this.report("success"); }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejecter?.(cancelled());
    this.resolver = undefined;
    this.rejecter = undefined;
  }

  isClosed(): boolean { return this.closed; }

  private renderShell(): void {
    if (!this.root) return;
    this.root.innerHTML = `<style>:host{--tinycloud-credential-accent:#3559e0;--tinycloud-credential-background:#fff;--tinycloud-credential-text:#172033;display:block;color:var(--tinycloud-credential-text);font:inherit}.card{background:var(--tinycloud-credential-background);border:1px solid #c8d0df;border-radius:12px;padding:20px;max-width:420px;box-shadow:0 4px 16px #1720331f}.actions{display:flex;gap:8px;margin-top:16px}button{font:inherit;border-radius:7px;padding:8px 12px;border:1px solid #8993a7;background:#fff;color:inherit;cursor:pointer}button[type=submit]{background:var(--tinycloud-credential-accent);border-color:var(--tinycloud-credential-accent);color:#fff}input{box-sizing:border-box;width:100%;padding:9px;margin-top:5px;font:inherit;border:1px solid #8993a7;border-radius:6px}label{display:block;margin-top:12px}p{line-height:1.45}</style><section class="card" role="dialog" aria-modal="false" aria-labelledby="title"><h2 id="title">Credential check</h2><p data-description></p><div data-form></div><p data-live role="status" aria-live="polite">Preparing credential acquisition…</p></section>`;
  }

  private renderPrompt(request: InlineCredentialProofRequest): void {
    this.root ??= this.attachShadow({ mode: "closed" });
    this.renderShell();
    const description = this.root.querySelector<HTMLElement>("[data-description]")!;
    const formHost = this.root.querySelector<HTMLElement>("[data-form]")!;
    const live = this.root.querySelector<HTMLElement>("[data-live]")!;
    description.textContent = request.display.description;
    const isOtp = request.stepId === "mailbox_otp";
    const fields = isOtp ? [{ id: "otp", label: "One-time mailbox code", type: "text", inputMode: "numeric" }] : request.inputs.map((field) => ({ id: field.id, label: field.label, type: field.schema.format === "email" ? "email" : "text", inputMode: field.schema.format === "email" ? "email" : "text" }));
    formHost.innerHTML = `<form novalidate>${fields.map((field) => `<label>${field.label}<input required name="${field.id}" type="${field.type}" inputmode="${field.inputMode}" autocomplete="off" /></label>`).join("")}<p>${request.display.consent}</p><div class="actions"><button type="submit">Continue</button><button type="button" data-cancel>Cancel</button></div></form>`;
    live.setAttribute("aria-live", request.display.errorLiveRegion);
    live.textContent = isOtp ? "Enter the mailbox code to continue." : request.display.progressLabel;
    const form = formHost.querySelector("form")!;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      new FormData(form).forEach((value, key) => { values[key] = String(value).trim(); });
      if (Object.values(values).some((value) => value.length === 0)) { live.textContent = "Complete the required field to continue."; return; }
      this.resolver?.(values);
      this.resolver = undefined;
      this.rejecter = undefined;
      live.setAttribute("aria-live", "polite");
      live.textContent = "Submitting proof…";
    }, { once: true });
    formHost.querySelector<HTMLButtonElement>("[data-cancel]")!.addEventListener("click", () => this.cancel(), { once: true });
    queueMicrotask(() => form.querySelector<HTMLInputElement>("input")?.focus());
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
  constructor(private readonly options: { readonly descriptor: CredentialFlowDescriptor; readonly mountTarget?: Element | string; readonly theme?: CredentialAcquisitionTheme }) {}

  async start(input: { readonly signal?: AbortSignal }): Promise<CredentialInteractionSurface> {
    if (typeof document === "undefined") throw new CredentialError("UNSUPPORTED_PROFILE", "Inline credential acquisition requires a browser document");
    defineTinyCloudCredentialAcquisitionElement();
    const target = this.target();
    const element = document.createElement(TINYCLOUD_CREDENTIAL_ACQUISITION_TAG) as TinyCloudCredentialAcquisitionElement;
    element.configure(this.options.theme);
    target.append(element);
    this.element = element;
    input.signal?.addEventListener("abort", () => element.cancel(), { once: true });
    return { wake: async () => undefined, close: () => element.remove(), closed: () => element.isClosed(), requestProof: (request) => element.requestProof(request) };
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
