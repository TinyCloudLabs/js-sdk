/**
 * PermissionRequestModal
 *
 * Web Component that shows the user a list of additional capabilities an
 * app wants to request on top of the currently-signed session. Used by
 * `TinyCloudWeb.requestPermissions` as the confirmation step before the
 * SDK installs a scoped runtime permission delegation.
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
                This app is asking you to grant scoped permission. Review what it will be allowed to do before approving.
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
    const scopeLabel = permissionScopeLabel(entry);
    const resource = entry.path === "" ? "/" : entry.path;
    const actionDetails = entry.actions.map((action) =>
      describeAction(entry, action),
    );
    const capabilities = actionDetails
      .map((detail) => `
        <li class="permission-summary-item">
          <div class="permission-summary-row">
            <span class="permission-summary-label">Permission</span>
            <strong class="permission-summary-title">${escapeHtml(detail.title)}</strong>
          </div>
          <p class="permission-summary-description">${escapeHtml(detail.description)}</p>
        </li>
      `)
      .join("");
    const dictionaryRows = [
      ["Service", entry.service],
      ["Scope", scopeLabel],
      ["Resource", resource],
      [
        "Actions",
        actionDetails.map((detail) => detail.canonicalAction).join(", "),
      ],
    ]
      .map(([label, value]) => `
        <div class="dictionary-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `)
      .join("");

    return `
      <li class="permission-entry">
        <ul class="permission-summary-list">${capabilities}</ul>
        <details class="technical-details">
          <summary>Show technical details</summary>
          <p class="entry-summary">${escapeHtml(permissionScopeSummary(entry))}</p>
          <dl class="permission-dictionary">${dictionaryRows}</dl>
        </details>
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
        border-radius: 10px; padding: 14px;
      }
      .entry-summary {
        font-size: 13px; line-height: 1.45; color: var(--modal-muted);
        margin: 10px 0;
      }
      .permission-summary-list {
        list-style: none; padding: 0; margin: 0;
        display: flex; flex-direction: column; gap: 10px;
      }
      .permission-summary-item {
        display: flex; flex-direction: column; gap: 6px;
      }
      .permission-summary-row {
        display: grid; grid-template-columns: 88px 1fr;
        gap: 10px; align-items: baseline;
      }
      .permission-summary-label {
        font-size: 12px; color: var(--modal-muted);
      }
      .permission-summary-title {
        font-size: 15px; font-weight: 600; color: var(--modal-foreground);
        line-height: 1.35;
      }
      .permission-summary-description {
        font-size: 13px; line-height: 1.45; color: var(--modal-muted);
        margin: 0;
      }
      .technical-details {
        margin-top: 12px;
        border-top: 1px solid var(--modal-border);
        padding-top: 10px;
      }
      .technical-details summary {
        cursor: pointer; color: var(--modal-muted); font-size: 12px;
        user-select: none;
      }
      .technical-details summary:hover { color: var(--modal-foreground); }
      .technical-details[open] summary { margin-bottom: 8px; }
      .permission-dictionary {
        margin: 0; padding: 0;
        border: 1px solid var(--modal-border);
        border-radius: 8px; overflow: hidden;
      }
      .dictionary-row {
        display: grid; grid-template-columns: 86px 1fr;
        border-top: 1px solid var(--modal-border);
      }
      .dictionary-row:first-child { border-top: 0; }
      .dictionary-row dt,
      .dictionary-row dd {
        margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.4;
      }
      .dictionary-row dt {
        color: var(--modal-muted); background: var(--modal-bg);
      }
      .dictionary-row dd {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace;
        color: var(--modal-foreground); word-break: break-all;
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
        .permission-summary-row { grid-template-columns: 1fr; gap: 3px; }
        .dictionary-row { grid-template-columns: 1fr; }
        .dictionary-row dd { padding-top: 0; }
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

interface CapabilityDescription {
  title: string;
  description: string;
}

const SERVICE_LABELS: Record<string, string> = {
  "tinycloud.encryption": "Encryption network permission",
  "tinycloud.kv": "Key-value storage permission",
  "tinycloud.sql": "SQL storage permission",
  "tinycloud.duckdb": "DuckDB storage permission",
  "tinycloud.capabilities": "Capability registry permission",
  "tinycloud.hooks": "Hook permission",
};

const CAPABILITY_DESCRIPTIONS: Record<string, CapabilityDescription> = {
  "tinycloud.encryption/decrypt": {
    title: "Decrypt data keys for this network",
    description:
      "Allows this app to ask a TinyCloud node to unwrap encrypted data keys for data encrypted to this network. The app still needs separate data-read permission to fetch encrypted records.",
  },
  "tinycloud.encryption/network.create": {
    title: "Create an encryption network",
    description:
      "Allows this app to create or initialize an encryption network that data can be encrypted to. The network key is managed by TinyCloud nodes and used later for delegated decrypt requests.",
  },
  "tinycloud.encryption/network.revoke": {
    title: "Revoke an encryption network",
    description:
      "Allows this app to revoke or disable an encryption network so future decrypt requests for that network are denied.",
  },
  "tinycloud.kv/get": {
    title: "Read key-value data",
    description:
      "Allows this app to read values at the selected key or key prefix in the requested space.",
  },
  "tinycloud.kv/put": {
    title: "Write key-value data",
    description:
      "Allows this app to create or replace values at the selected key or key prefix in the requested space.",
  },
  "tinycloud.kv/del": {
    title: "Delete key-value data",
    description:
      "Allows this app to remove values at the selected key or key prefix in the requested space.",
  },
  "tinycloud.kv/list": {
    title: "List key-value entries",
    description:
      "Allows this app to list keys under the selected key-value prefix in the requested space.",
  },
  "tinycloud.kv/metadata": {
    title: "Read key-value metadata",
    description:
      "Allows this app to inspect metadata for keys without necessarily reading the stored value.",
  },
  "tinycloud.sql/read": {
    title: "Read SQL data",
    description:
      "Allows this app to read rows and query results from the selected SQL database in the requested space.",
  },
  "tinycloud.sql/write": {
    title: "Write SQL data",
    description:
      "Allows this app to insert, update, or delete rows in the selected SQL database.",
  },
  "tinycloud.sql/ddl": {
    title: "Change SQL schema",
    description:
      "Allows this app to create, alter, or drop SQL tables, indexes, and schema objects.",
  },
  "tinycloud.sql/admin": {
    title: "Administer SQL storage",
    description:
      "Allows this app to perform administrative SQL operations for the selected database.",
  },
  "tinycloud.sql/select": {
    title: "Select SQL rows",
    description:
      "Allows this app to run SELECT queries against the selected SQL database.",
  },
  "tinycloud.sql/insert": {
    title: "Insert SQL rows",
    description:
      "Allows this app to insert rows into the selected SQL database.",
  },
  "tinycloud.sql/update": {
    title: "Update SQL rows",
    description:
      "Allows this app to update rows in the selected SQL database.",
  },
  "tinycloud.sql/delete": {
    title: "Delete SQL rows",
    description:
      "Allows this app to delete rows from the selected SQL database.",
  },
  "tinycloud.sql/execute": {
    title: "Execute SQL statements",
    description:
      "Allows this app to execute SQL statements against the selected database.",
  },
  "tinycloud.sql/export": {
    title: "Export SQL data",
    description:
      "Allows this app to export data from the selected SQL database.",
  },
  "tinycloud.sql/*": {
    title: "Full SQL access",
    description:
      "Allows this app to read, write, administer, and export the selected SQL database.",
  },
  "tinycloud.duckdb/read": {
    title: "Read DuckDB data",
    description:
      "Allows this app to read data and query results from the selected DuckDB database.",
  },
  "tinycloud.duckdb/write": {
    title: "Write DuckDB data",
    description:
      "Allows this app to write data to the selected DuckDB database.",
  },
  "tinycloud.duckdb/admin": {
    title: "Administer DuckDB storage",
    description:
      "Allows this app to perform administrative operations for the selected DuckDB database.",
  },
  "tinycloud.duckdb/describe": {
    title: "Describe DuckDB data",
    description:
      "Allows this app to inspect tables, columns, and metadata in the selected DuckDB database.",
  },
  "tinycloud.duckdb/export": {
    title: "Export DuckDB data",
    description:
      "Allows this app to export data from the selected DuckDB database.",
  },
  "tinycloud.duckdb/import": {
    title: "Import DuckDB data",
    description:
      "Allows this app to import data into the selected DuckDB database.",
  },
  "tinycloud.duckdb/execute": {
    title: "Execute DuckDB statements",
    description:
      "Allows this app to execute statements against the selected DuckDB database.",
  },
  "tinycloud.duckdb/*": {
    title: "Full DuckDB access",
    description:
      "Allows this app to read, write, administer, import, export, and execute statements on the selected DuckDB database.",
  },
  "tinycloud.capabilities/read": {
    title: "Read delegated capabilities",
    description:
      "Allows this app to read capability and delegation records for the selected scope.",
  },
  "tinycloud.hooks/subscribe": {
    title: "Subscribe to hooks",
    description:
      "Allows this app to receive hook events for the selected hook scope.",
  },
  "tinycloud.hooks/register": {
    title: "Register hooks",
    description:
      "Allows this app to register hook handlers for the selected hook scope.",
  },
  "tinycloud.hooks/list": {
    title: "List hooks",
    description:
      "Allows this app to list registered hooks for the selected hook scope.",
  },
  "tinycloud.hooks/unregister": {
    title: "Unregister hooks",
    description:
      "Allows this app to remove registered hook handlers for the selected hook scope.",
  },
};

interface ActionDetail extends CapabilityDescription {
  canonicalAction: string;
  displayAction: string;
}

function permissionScopeLabel(entry: PermissionEntry): string {
  if (entry.space !== undefined && entry.space !== "") {
    return entry.space;
  }
  return entry.service === "tinycloud.encryption"
    ? "network-scoped"
    : "unscoped";
}

function serviceDisplayName(service: string): string {
  return SERVICE_LABELS[service] ?? `${service} permission`;
}

function permissionScopeSummary(entry: PermissionEntry): string {
  if (entry.service === "tinycloud.encryption") {
    return "This permission applies to an encryption network, not a TinyCloud data space.";
  }
  const scope = permissionScopeLabel(entry);
  return `This permission applies to the ${scope} TinyCloud space and the resource path shown below.`;
}

function describeAction(entry: PermissionEntry, action: string): ActionDetail {
  const canonicalAction = canonicalizeAction(entry.service, action);
  const displayAction = displayActionName(entry.service, action);
  const description =
    contextualCapabilityDescription(entry, canonicalAction) ??
    CAPABILITY_DESCRIPTIONS[canonicalAction] ??
    fallbackCapabilityDescription(entry.service, displayAction);
  return {
    canonicalAction,
    displayAction,
    ...description,
  };
}

function contextualCapabilityDescription(
  entry: PermissionEntry,
  canonicalAction: string,
): CapabilityDescription | undefined {
  if (entry.service !== "tinycloud.kv" || entry.space !== "secrets") {
    return undefined;
  }

  const secret = describeSecretPath(entry.path);
  if (secret === undefined) {
    return undefined;
  }

  switch (canonicalAction) {
    case "tinycloud.kv/get":
      return {
        title: "Read an encrypted secret",
        description:
          `Allows this app to read the encrypted secret record for ${secret}. Decrypting it still requires encryption-network decrypt permission.`,
      };
    case "tinycloud.kv/put":
      return {
        title: "Write a secret",
        description:
          `Allows this app to create or update the encrypted secret record for ${secret}.`,
      };
    case "tinycloud.kv/del":
      return {
        title: "Delete a secret",
        description:
          `Allows this app to remove the encrypted secret record for ${secret}.`,
      };
    case "tinycloud.kv/list":
      return {
        title: "List secrets",
        description:
          `Allows this app to list encrypted secret records under ${secret}.`,
      };
    case "tinycloud.kv/metadata":
      return {
        title: "Read secret metadata",
        description:
          `Allows this app to inspect metadata for encrypted secret records under ${secret}.`,
      };
    default:
      return undefined;
  }
}

function describeSecretPath(path: string): string | undefined {
  const prefix = "vault/secrets/";
  if (path === "vault/secrets") {
    return "all secrets";
  }
  if (!path.startsWith(prefix)) {
    return undefined;
  }

  const rest = path.slice(prefix.length);
  if (rest === "") {
    return "all secrets";
  }

  const scopedPrefix = "scoped/";
  if (rest.startsWith(scopedPrefix)) {
    const [scope, ...nameParts] = rest.slice(scopedPrefix.length).split("/");
    const name = nameParts.join("/");
    if (scope !== "" && name !== "") {
      return `the scoped secret ${name} in ${scope}`;
    }
  }

  return `the secret ${rest}`;
}

function canonicalizeAction(service: string, action: string): string {
  if (action.includes("/")) {
    return action;
  }
  if (action.startsWith(`${service}.`)) {
    return `${service}/${action.slice(service.length + 1)}`;
  }
  return `${service}/${action}`;
}

function displayActionName(service: string, action: string): string {
  if (action.startsWith(`${service}/`)) {
    return action.slice(service.length + 1);
  }
  if (action.startsWith(`${service}.`)) {
    return action.slice(service.length + 1);
  }
  return action;
}

function fallbackCapabilityDescription(
  service: string,
  action: string,
): CapabilityDescription {
  return {
    title: `Use ${serviceDisplayName(service).replace(/ permission$/, "")}`,
    description: `Allows this app to perform ${action} on the resource shown below.`,
  };
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
