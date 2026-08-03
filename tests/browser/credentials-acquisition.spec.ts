import { expect, test } from "@playwright/test";
import { CredentialError } from "../../packages/sdk-core/src/credentials/errors";
import { BrowserCredentialInteraction } from "../../packages/web-sdk/src/credentials/browser";
import { OpenCredentialsHttpTransport } from "../../packages/web-sdk/src/credentials/transport";
import type { CredentialFlowDescriptor } from "../../packages/sdk-core/src/credentials/types";

const ORIGIN = "https://issuer.test";
const LOCATOR = "locator_abcdefghijklmnop";

function surface(popup: any = { closed: false, close: () => undefined }) {
  const listeners = new Set<(event: any) => void>(); let opened = ""; let redirected = "";
  return {
    popup, listeners,
    browser: { opener: { addEventListener: (_: string, listener: any) => listeners.add(listener), removeEventListener: (_: string, listener: any) => listeners.delete(listener) } as any, open: (url: string) => { opened = url; return popup; }, redirect: (url: string) => { redirected = url; } },
    opened: () => opened, redirected: () => redirected,
  };
}

test("exact-origin enforcement and non-secret completion wake", async () => {
  const fake = surface(); const interaction = await new BrowserCredentialInteraction("popup", fake.browser).start({ issuerOrigin: ORIGIN, locator: LOCATOR });
  const wake = interaction.wake();
  for (const listener of fake.listeners) listener({ origin: "https://evil.test", source: fake.popup, data: { type: "opencredentials-wake", version: 1, locator: LOCATOR } });
  let settled = false; void wake.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  for (const listener of fake.listeners) listener({ origin: ORIGIN, source: fake.popup, data: { type: "opencredentials-wake", version: 1, locator: LOCATOR } });
  await wake; expect(settled).toBe(true);
});

test("popup navigation contains only the opaque locator", async () => {
  const fake = surface(); await new BrowserCredentialInteraction("popup", fake.browser).start({ issuerOrigin: ORIGIN, locator: LOCATOR });
  const url = new URL(fake.opened()); expect(url.origin).toBe(ORIGIN); expect(url.pathname).toContain(LOCATOR); expect(url.search).toBe(""); expect(url.hash).toBe("");
});

test("request substitution and replay fail with typed categories", async () => {
  const descriptor = { issuer: { origin: ORIGIN } } as CredentialFlowDescriptor;
  const substituted = new OpenCredentialsHttpTransport(descriptor, async () => new Response(JSON.stringify({ type: "OpenCredentialsAcquisitionState", version: 1, requestId: "different_abcdefghijkl", transitionId: "transition_abcdefgh", state: "pending", correlationId: "correlation_abcdefgh" }), { status: 200, headers: { "content-type": "application/json" } }));
  await expect(substituted.state("request_abcdefghijkl", "verifier_abcdefghijkl")).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
  const replay = new OpenCredentialsHttpTransport(descriptor, async () => new Response(null, { status: 409 }));
  await expect(replay.state("request_abcdefghijkl", "verifier_abcdefghijkl")).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
});

test("duplicate wake signals carry no result and grant no authority", async () => {
  const fake = surface(); const interaction = await new BrowserCredentialInteraction("popup", fake.browser).start({ issuerOrigin: ORIGIN, locator: LOCATOR });
  const message = { type: "opencredentials-wake", version: 1, locator: LOCATOR };
  for (const listener of fake.listeners) { listener({ origin: ORIGIN, source: fake.popup, data: message }); listener({ origin: ORIGIN, source: fake.popup, data: message }); }
  expect(Object.keys(message)).toEqual(["type", "version", "locator"]); interaction.close();
});

test("popup closure is observable and popup blocking is typed", async () => {
  const fake = surface({ closed: true, close: () => undefined }); const interaction = await new BrowserCredentialInteraction("popup", fake.browser).start({ issuerOrigin: ORIGIN, locator: LOCATOR });
  expect(interaction.closed()).toBe(true);
  const blocked = surface(null);
  await expect(new BrowserCredentialInteraction("popup", blocked.browser).start({ issuerOrigin: ORIGIN, locator: LOCATOR })).rejects.toEqual(expect.objectContaining<Partial<CredentialError>>({ code: "POPUP_BLOCKED", recoverable: true }));
});

test("redirect fallback preserves the authority model and locator-only URL", async () => {
  const fake = surface(); await new BrowserCredentialInteraction("redirect", fake.browser).start({ issuerOrigin: ORIGIN, locator: LOCATOR });
  const url = new URL(fake.redirected()); expect(url.search).toBe(""); expect(url.hash).toBe(""); expect(url.pathname).toContain(LOCATOR);
});
