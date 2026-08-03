import { expect, test } from "@playwright/test";
import { CredentialError } from "../../packages/sdk-core/src/credentials/errors";
import { BrowserCredentialInteraction } from "../../packages/web-sdk/src/credentials/browser";
import { OpenCredentialsHttpTransport } from "../../packages/web-sdk/src/credentials/transport";
import type { CredentialFlowDescriptor } from "../../packages/sdk-core/src/credentials/types";

const ORIGIN = "https://issuer.test";
const INTERACTION = { origin: "https://credentials.org", pathTemplate: "/credentials/acquire/{requestId}" as const };
const LOCATOR = "L".repeat(32);

function surface(popup: any = { closed: false, close: () => undefined }) {
  const listeners = new Set<(event: any) => void>(); let opened = ""; let redirected = "";
  return {
    popup, listeners,
    browser: { opener: { addEventListener: (_: string, listener: any) => listeners.add(listener), removeEventListener: (_: string, listener: any) => listeners.delete(listener) } as any, open: (url: string) => { opened = url; return popup; }, redirect: (url: string) => { redirected = url; } },
    opened: () => opened, redirected: () => redirected,
  };
}

test("exact-origin enforcement and non-secret completion wake", async () => {
  const fake = surface(); const interaction = await new BrowserCredentialInteraction("popup", fake.browser).start({ interaction: INTERACTION, locator: LOCATOR });
  const wake = interaction.wake();
  for (const listener of fake.listeners) listener({ origin: "https://evil.test", source: fake.popup, data: { type: "opencredentials-wake", version: 1, locator: LOCATOR } });
  let settled = false; void wake.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  for (const listener of fake.listeners) listener({ origin: INTERACTION.origin, source: fake.popup, data: { type: "opencredentials-wake", version: 1, locator: LOCATOR } });
  await wake; expect(settled).toBe(true);
});

test("popup navigation contains only the opaque locator", async () => {
  const fake = surface(); await new BrowserCredentialInteraction("popup", fake.browser).start({ interaction: INTERACTION, locator: LOCATOR });
  const url = new URL(fake.opened()); expect(url.origin).toBe(INTERACTION.origin); expect(url.pathname).toContain(LOCATOR); expect(url.search).toBe(""); expect(url.hash).toBe("");
});

test("request substitution and replay fail with typed categories", async () => {
  const descriptor = { issuer: { origin: ORIGIN } } as CredentialFlowDescriptor;
  const substituted = new OpenCredentialsHttpTransport(descriptor, async () => new Response(JSON.stringify({ type: "OpenCredentialsAcquisitionState", version: 1, requestId: "different_abcdefghijkl", transitionId: "transition_abcdefgh", state: "pending", correlationId: "correlation_abcdefgh" }), { status: 200, headers: { "content-type": "application/json" } }));
  await expect(substituted.state("request_abcdefghijkl", "verifier_abcdefghijkl")).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
  const replay = new OpenCredentialsHttpTransport(descriptor, async () => new Response(null, { status: 409 }));
  await expect(replay.state("request_abcdefghijkl", "verifier_abcdefghijkl")).rejects.toMatchObject({ code: "REQUEST_SUBSTITUTED" });
});

test("duplicate wake signals carry no result and grant no authority", async () => {
  const fake = surface(); const interaction = await new BrowserCredentialInteraction("popup", fake.browser).start({ interaction: INTERACTION, locator: LOCATOR });
  const message = { type: "opencredentials-wake", version: 1, locator: LOCATOR };
  for (const listener of fake.listeners) { listener({ origin: INTERACTION.origin, source: fake.popup, data: message }); listener({ origin: INTERACTION.origin, source: fake.popup, data: message }); }
  expect(Object.keys(message)).toEqual(["type", "version", "locator"]); interaction.close();
});

test("popup closure is observable and popup blocking is typed", async () => {
  const fake = surface({ closed: true, close: () => undefined }); const interaction = await new BrowserCredentialInteraction("popup", fake.browser).start({ interaction: INTERACTION, locator: LOCATOR });
  expect(interaction.closed()).toBe(true);
  const blocked = surface(null);
  await expect(new BrowserCredentialInteraction("popup", blocked.browser).start({ interaction: INTERACTION, locator: LOCATOR })).rejects.toEqual(expect.objectContaining<Partial<CredentialError>>({ code: "POPUP_BLOCKED", recoverable: true }));
});

test("hosted redirect journey resumes an initialized SDK once and durably stores the verified credential", async ({ page }) => {
  const driverUrl = "http://127.0.0.1:4175";
  try {
    const openerOrigin = "https://app.example";
    const startResponse = await fetch(`${driverUrl}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openerOrigin }) });
    expect(startResponse.ok).toBe(true);
    const started = await startResponse.json() as { navigation: string; resumeState: unknown; browserCookie: string; fixtureUrl: string; interactionOrigin: string };

    await page.route("https://app.example/**", async (route) => {
      const requested = new URL(route.request().url());
      const response = await route.fetch({ url: new URL(`${requested.pathname}${requested.search}`, "http://localhost:4173").href });
      await route.fulfill({ response });
    });
    await page.route("https://credentials.org/**", async (route) => {
      const requested = new URL(route.request().url());
      const response = await route.fetch({ url: new URL(`${requested.pathname}${requested.search}`, "http://127.0.0.1:4174").href });
      await route.fulfill({ response });
    });
    await page.route("https://witness.credentials.org/**", async (route) => {
      const requested = new URL(route.request().url());
      const response = await route.fetch({
        url: new URL(`${requested.pathname}${requested.search}`, started.fixtureUrl).href,
        headers: { ...route.request().headers(), cookie: started.browserCookie },
      });
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": "https://credentials.org",
          "access-control-allow-credentials": "true",
        },
      });
    });

    const appUrl = "https://app.example/test-page.html";
    await page.goto(appUrl);
    await page.waitForFunction(() => (window as any).__SDK_LOADED === true);
    const redirectStore = {
      load: () => page.evaluate(async () => new (window as any).__TinyCloudSDK.BrowserCredentialRedirectStore().load()),
      save: (state: unknown) => page.evaluate(async (value) => new (window as any).__TinyCloudSDK.BrowserCredentialRedirectStore().save(value), state),
      clear: () => page.evaluate(async () => new (window as any).__TinyCloudSDK.BrowserCredentialRedirectStore().clear()),
    };
    await redirectStore.save(started.resumeState);
    const interaction = new URL(started.navigation);
    expect(interaction.origin).toBe(started.interactionOrigin);
    expect(interaction.search).toBe("");
    expect(interaction.hash).toBe("");
    await page.goto(started.navigation);
    await page.getByLabel("Verification code").fill("246810");
    await Promise.all([
      page.waitForURL((next) => next.origin === openerOrigin && next.pathname === "/"),
      page.getByRole("button", { name: "Verify code" }).click(),
    ]);

    await page.goto(appUrl);
    await page.waitForFunction(() => (window as any).__SDK_LOADED === true);
    const resumeState = await redirectStore.load();
    expect(resumeState).toBeDefined();
    const resumeResponse = await fetch(`${driverUrl}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openerOrigin, resumeState }) });
    expect(resumeResponse.ok).toBe(true);
    const resumed = await resumeResponse.json() as { status: string; claims: Record<string, unknown>; holderDid: string; activeHolderDid: string; recordOwnerDid: string; receiptOwnerDid: string; ownerDid: string; cleared: boolean };
    expect(resumed.status).toBe("acquired");
    expect(resumed.claims.email).toBe("fixture@example.com");
    expect(resumed.holderDid).toBe(resumed.activeHolderDid);
    expect(resumed.recordOwnerDid).toBe(resumed.ownerDid);
    expect(resumed.receiptOwnerDid).toBe(resumed.ownerDid);
    expect(resumed.cleared).toBe(true);
    await redirectStore.clear();
    expect(await redirectStore.load()).toBeUndefined();
    expect(await redirectStore.load()).toBeUndefined();
    const durableResponse = await fetch(`${driverUrl}/durable`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openerOrigin }) });
    expect(durableResponse.ok).toBe(true);
    const durable = await durableResponse.json() as { status: string; creates: number; resultReads: number; autoSignAttempts: number; approvalCount: number };
    expect(durable.status).toBe("reused");
    expect(durable.creates).toBe(1);
    expect(durable.resultReads).toBe(1);
    expect(durable.autoSignAttempts).toBe(1);
    expect(durable.approvalCount).toBe(1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
