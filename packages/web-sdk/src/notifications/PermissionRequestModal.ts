/**
 * PermissionRequestModal
 *
 * Web Component that shows the user a list of additional capabilities an
 * app wants to request on top of the currently-signed session. Used by
 * `TinyCloudWeb.requestPermissions` as the confirmation step before we
 * tear down the current session and run a fresh signIn with an expanded
 * manifest.
 *
 * Matches the `SpaceCreationModal` pattern: a Web Component with a shadow
 * DOM, returning a completion promise via `getCompletionPromise()`. The
 * DOM lifecycle (append / remove) is managed by `ModalManager`.
 *
 * Canonical spec: `.claude/specs/capability-chain.md`.
 */

import type { PermissionEntry } from "@tinycloud/sdk-core";

export interface PermissionRequestModalOptions {
  /** Display name of the app requesting permissions (from the manifest). */
  appName: string;
  /** Optional app icon URL (from the manifest). */
  appIcon?: string;
  /** The additional permissions the app wants on top of its current session. */
  additional: PermissionEntry[];
  /** Called when the user clicks Decline or dismisses the modal. */
  onDismiss?: () => void;
}

export interface PermissionRequestResult {
  /** True when the user clicked Approve, false when they declined or dismissed. */
  approved: boolean;
}

export class TinyCloudPermissionRequestModal extends HTMLElement {
  private options: PermissionRequestModalOptions;
  private isVisible: boolean = false;
  private resolveResult: ((result: PermissionRequestResult) => void) | null =
    null;
  private completionPromise: Promise<PermissionRequestResult>;

  constructor(options: PermissionRequestModalOptions) {
    super();
    this.options = options;
    this.attachShadow({ mode: "open" });
    this.render();

    this.completionPromise = new Promise<PermissionRequestResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  public getCompletionPromise(): Promise<PermissionRequestResult> {
    return this.completionPromise;
  }

  connectedCallback() {
    this.show();
    this.setupEventListeners();
  }

  disconnectedCallback() {
    document.body.style.overflow = "";
  }

  private render(): void {
    const entriesHtml = this.options.additional
      .map((entry) => this.renderEntry(entry))
      .join("");

    // We deliberately HTML-escape every dynamic string below. appName and
    // path come straight from user-controlled manifest input; dropping
    // them into innerHTML without escaping would be an XSS vector.
    const appName = escapeHtml(this.options.appName);
    const iconMarkup = this.options.appIcon
      ? `<img class="app-icon" src="${escapeAttr(this.options.appIcon)}" alt="" />`
      : `<div class="app-icon app-icon--placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
        </div>`;

    this.shadowRoot!.innerHTML = `
      <style>${this.getModalStyles()}</style>
      <div class="modal-backdrop" data-state="hidden">
        <div class="modal-container">
          <div class="modal-content">
            <div class="modal-header">
              ${iconMarkup}
              <h2 class="modal-title">${appName} is requesting additional permissions</h2>
              <button class="modal-close" aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            </div>

            <div class="modal-body">
              <p class="modal-description">
                Approving will sign you out of your current session and start a new one with the expanded permissions.
              </p>
              <ul class="permission-list">${entriesHtml}</ul>
            </div>

            <div class="modal-actions">
              <button class="modal-button modal-button--secondary" data-action="decline">
                Decline
              </button>
              <button class="modal-button modal-button--primary" data-action="approve">
                Approve
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderEntry(entry: PermissionEntry): string {
    const service = escapeHtml(entry.service);
    const space = escapeHtml(entry.space);
    const path = escapeHtml(entry.path === "" ? "/" : entry.path);
    const actions = entry.actions
      .map((a) => `<code class="action">${escapeHtml(a)}</code>`)
      .join(" ");
    return `
      <li class="permission-entry">
        <div class="entry-head">
          <span class="entry-service">${service}</span>
          <span class="entry-space">${space}</span>
        </div>
        <div class="entry-path">${path}</div>
        <div class="entry-actions">${actions}</div>
      </li>
    `;
  }

  private getModalStyles(): string {
    return `
      :host {
        --modal-bg: hsl(0 0% 3.9%);
        --modal-border: hsl(0 0% 14.9%);
        --modal-foreground: hsl(0 0% 98%);
        --modal-muted: hsl(0 0% 63.9%);
        --modal-accent: hsl(217 91% 60%);
        --modal-accent-hover: hsl(217 91% 65%);
        --modal-secondary: hsl(0 0% 10%);
        --modal-secondary-hover: hsl(0 0% 15%);
        --modal-overlay: rgba(0, 0, 0, 0.5);
      }
      .modal-backdrop {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: var(--modal-overlay);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 2000000;
        display: flex; align-items: center; justify-content: center;
        padding: 20px; opacity: 0;
        transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: none;
      }
      .modal-backdrop[data-state="visible"] { opacity: 1; pointer-events: auto; }
      .modal-container {
        transform: scale(0.95) translateY(10px);
        transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .modal-backdrop[data-state="visible"] .modal-container { transform: scale(1) translateY(0); }
      .modal-content {
        background: var(--modal-bg);
        border: 1px solid var(--modal-border);
        border-radius: 16px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.05);
        max-width: 520px; width: 100%;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: var(--modal-foreground);
      }
      .modal-header {
        padding: 24px 24px 0 24px;
        display: flex; align-items: flex-start; gap: 16px; position: relative;
      }
      .app-icon {
        flex-shrink: 0; width: 48px; height: 48px;
        border-radius: 12px; object-fit: cover;
        background: var(--modal-secondary);
      }
      .app-icon--placeholder {
        display: flex; align-items: center; justify-content: center;
        background: var(--modal-accent); color: white;
      }
      .modal-title {
        flex: 1; font-size: 18px; font-weight: 600; line-height: 1.3;
        margin: 0; margin-top: 4px;
      }
      .modal-close {
        position: absolute; top: 0; right: 0;
        background: transparent; border: none;
        color: var(--modal-muted); cursor: pointer;
        padding: 8px; border-radius: 6px; opacity: 0.7;
        transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex; align-items: center; justify-content: center;
      }
      .modal-close:hover { opacity: 1; background: var(--modal-secondary); color: var(--modal-foreground); }
      .modal-body { padding: 20px 24px; }
      .modal-description {
        font-size: 14px; line-height: 1.5; margin: 0 0 16px 0; color: var(--modal-muted);
      }
      .permission-list {
        list-style: none; padding: 0; margin: 0;
        display: flex; flex-direction: column; gap: 10px;
        max-height: 320px; overflow-y: auto;
      }
      .permission-entry {
        background: var(--modal-secondary);
        border: 1px solid var(--modal-border);
        border-radius: 10px; padding: 12px 14px;
      }
      .entry-head {
        display: flex; justify-content: space-between; align-items: center;
        font-size: 13px; margin-bottom: 6px;
      }
      .entry-service { font-weight: 600; color: var(--modal-foreground); }
      .entry-space {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace;
        font-size: 11px; color: var(--modal-muted);
      }
      .entry-path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace;
        font-size: 12px; color: var(--modal-muted); margin-bottom: 8px;
        word-break: break-all;
      }
      .entry-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .action {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace;
        font-size: 11px; padding: 2px 8px;
        background: var(--modal-bg); border: 1px solid var(--modal-border);
        border-radius: 6px; color: var(--modal-foreground);
      }
      .modal-actions {
        padding: 0 24px 24px 24px;
        display: flex; gap: 12px; justify-content: flex-end;
      }
      .modal-button {
        padding: 12px 20px; border-radius: 8px;
        font-size: 14px; font-weight: 500; cursor: pointer;
        transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid transparent;
        display: flex; align-items: center; gap: 8px;
        min-width: 100px; justify-content: center;
      }
      .modal-button--secondary {
        background: var(--modal-secondary);
        border-color: var(--modal-border);
        color: var(--modal-foreground);
      }
      .modal-button--secondary:hover {
        background: var(--modal-secondary-hover);
        border-color: hsl(0 0% 25%);
        transform: translateY(-1px);
      }
      .modal-button--primary { background: var(--modal-accent); color: white; }
      .modal-button--primary:hover { background: var(--modal-accent-hover); transform: translateY(-1px); }
      .modal-button--primary:active { transform: translateY(0); }
      @media (max-width: 640px) {
        .modal-content { max-width: 100%; margin: 0 16px; border-radius: 12px; }
        .modal-header { padding: 20px 20px 0 20px; }
        .modal-body { padding: 16px 20px; }
        .modal-actions { padding: 0 20px 20px 20px; flex-direction: column-reverse; }
        .modal-button { width: 100%; }
      }
    `;
  }

  private setupEventListeners(): void {
    const backdrop = this.shadowRoot!.querySelector(".modal-backdrop");
    const closeButton = this.shadowRoot!.querySelector(".modal-close");
    const declineButton = this.shadowRoot!.querySelector('[data-action="decline"]');
    const approveButton = this.shadowRoot!.querySelector('[data-action="approve"]');

    backdrop?.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        this.dismiss();
      }
    });

    closeButton?.addEventListener("click", () => this.dismiss());
    declineButton?.addEventListener("click", () => this.dismiss());
    approveButton?.addEventListener("click", () => this.handleApprove());

    document.addEventListener("keydown", this.handleKeyDown);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.isVisible) {
      this.dismiss();
    }
  };

  private handleApprove(): void {
    this.resolveResult?.({ approved: true });
    this.hide();
  }

  private show(): void {
    this.isVisible = true;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const backdrop = this.shadowRoot!.querySelector(".modal-backdrop");
      backdrop?.setAttribute("data-state", "visible");
    });
  }

  private hide(): void {
    const backdrop = this.shadowRoot!.querySelector(".modal-backdrop");
    backdrop?.setAttribute("data-state", "hidden");
    setTimeout(() => {
      this.remove();
      document.body.style.overflow = "";
      document.removeEventListener("keydown", this.handleKeyDown);
    }, 200);
    this.isVisible = false;
  }

  private dismiss(): void {
    this.resolveResult?.({ approved: false });
    this.options.onDismiss?.();
    this.hide();
  }
}

// HTML escaping helpers. Kept local so the modal file has no cross-package
// dependency — any future "html-entities" move can replace these in-place.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Register exactly once even under HMR / repeated bundler runs.
if (
  typeof customElements !== "undefined" &&
  !customElements.get("tinycloud-permission-request-modal")
) {
  customElements.define(
    "tinycloud-permission-request-modal",
    TinyCloudPermissionRequestModal,
  );
}
