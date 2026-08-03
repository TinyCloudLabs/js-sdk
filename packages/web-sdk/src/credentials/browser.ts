import { CredentialError, credentialEndpointPath } from "@tinycloud/sdk-core";
import type { CredentialInteractionAdapter, CredentialRedirectResumeState, CredentialRedirectStore } from "./types";

interface BrowserSurface {
  readonly opener: Window;
  open(url: string): Window | null;
  redirect(url: string): void;
}

function interactionUrl(origin: string, locator: string): string {
  const url = new URL(credentialEndpointPath("interaction", locator), origin);
  if (url.origin !== origin || url.search || url.hash) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential interaction URL is invalid");
  return url.href;
}

/** Exact-origin, locator-only browser interaction. Messages are non-secret wake signals. */
export class BrowserCredentialInteraction implements CredentialInteractionAdapter {
  readonly kind: "popup" | "redirect";
  constructor(kind: "popup" | "redirect" = "popup", private readonly surface: BrowserSurface = { opener: window, open: (url) => window.open(url, "tinycloud-credential", "popup,width=460,height=720"), redirect: (url) => window.location.assign(url) }) { this.kind = kind; }

  async start(input: { issuerOrigin: string; locator: string; signal?: AbortSignal }) {
    const url = interactionUrl(input.issuerOrigin, input.locator);
    if (this.kind === "redirect") {
      this.surface.redirect(url);
      return { wake: async () => undefined, close: () => undefined, closed: () => false };
    }
    const popup = this.surface.open(url);
    if (!popup) throw new CredentialError("POPUP_BLOCKED", "Credential popup was blocked");
    let wakeResolve: (() => void) | undefined;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== input.issuerOrigin || event.source !== popup || typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
      const message = event.data as Record<string, unknown>;
      if (Object.keys(message).length !== 3 || message.type !== "opencredentials-wake" || message.version !== 1 || message.locator !== input.locator) return;
      wakeResolve?.(); wakeResolve = undefined;
    };
    this.surface.opener.addEventListener("message", onMessage);
    input.signal?.addEventListener("abort", () => { try { popup.close(); } finally { this.surface.opener.removeEventListener("message", onMessage); } }, { once: true });
    return {
      wake: () => new Promise<void>((resolve) => { wakeResolve = resolve; setTimeout(() => { if (wakeResolve === resolve) { wakeResolve = undefined; resolve(); } }, 100); }),
      close: () => { this.surface.opener.removeEventListener("message", onMessage); try { popup.close(); } catch { /* no authority is derived from popup lifecycle */ } },
      closed: () => popup.closed,
    };
  }
}

/** Request-scoped redirect continuation. It stores no TinyCloud session or key material. */
export class BrowserCredentialRedirectStore implements CredentialRedirectStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.sessionStorage, private readonly key = "tinycloud.credentials.redirect.v1") {}
  async load(): Promise<CredentialRedirectResumeState | undefined> {
    const encoded = this.storage.getItem(this.key);
    if (encoded === null) return undefined;
    let value: unknown; try { value = JSON.parse(encoded); } catch { await this.clear(); return undefined; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) { await this.clear(); return undefined; }
    const item = value as Record<string, unknown>;
    const expected = ["type", "version", "requestId", "locator", "verifier", "expiresAt", "correlationId", "holderDid", "descriptorDigest", "requirementDigest", "openerOrigin"].sort();
    const actual = Object.keys(item).sort();
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index]) || item.type !== "TinyCloudCredentialRedirectResume" || item.version !== 1 || !["requestId", "locator", "verifier", "correlationId", "holderDid", "descriptorDigest", "requirementDigest", "openerOrigin", "expiresAt"].every((name) => typeof item[name] === "string")) { await this.clear(); return undefined; }
    return item as unknown as CredentialRedirectResumeState;
  }
  async save(state: CredentialRedirectResumeState): Promise<void> { this.storage.setItem(this.key, JSON.stringify(state)); }
  async clear(): Promise<void> { this.storage.removeItem(this.key); }
}
