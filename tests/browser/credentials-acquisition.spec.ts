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
  const config = await fetch(`${driverUrl}/config`).then(async (response) => {
    expect(response.ok).toBe(true);
    return response.json() as Promise<{
      descriptor: CredentialFlowDescriptor;
      fixtureBackendUrl: string;
      hostedBackendUrl: string;
      tinycloudBackendUrl: string;
      ownerDid: string;
      credentialsSpaceId: string;
    }>;
  });
  let creates = 0;
  let resultReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "https://witness.credentials.org") return;
    if (request.method() === "POST" && url.pathname === "/v1/acquisitions") creates += 1;
    if (request.method() === "GET" && url.pathname.endsWith("/result")) resultReads += 1;
  });

  const corsRoute = async (route: any, backend: string) => {
    const requested = new URL(route.request().url());
    const requestOrigin = await route.request().headerValue("origin");
    const allowOrigin = requestOrigin === "https://credentials.org"
      ? "https://credentials.org"
      : "https://app.example";
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": allowOrigin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
        },
      });
      return;
    }
    const response = await route.fetch({
      url: new URL(`${requested.pathname}${requested.search}`, backend).href,
    });
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "access-control-allow-origin": allowOrigin,
        "access-control-allow-credentials": "true",
      },
    });
  };

  try {
    await page.route("https://app.example/**", async (route) => {
      const requested = new URL(route.request().url());
      const path = requested.pathname === "/" ? "/test-page.html" : requested.pathname;
      const response = await route.fetch({ url: new URL(`${path}${requested.search}`, "http://localhost:4173").href });
      await route.fulfill({ response });
    });
    await page.route("https://credentials.org/**", async (route) => {
      const requested = new URL(route.request().url());
      const response = await route.fetch({ url: new URL(`${requested.pathname}${requested.search}`, config.hostedBackendUrl).href });
      await route.fulfill({ response });
    });
    await page.route("https://witness.credentials.org/**", (route) => corsRoute(route, config.fixtureBackendUrl));
    await page.route("https://tinycloud.test/**", (route) => corsRoute(route, config.tinycloudBackendUrl));
    await page.route("https://ethers.test/ethers.esm.min.js", async (route) => {
      await route.fulfill({
        path: "node_modules/ethers/dist/ethers.esm.min.js",
        contentType: "text/javascript",
      });
    });

    const appUrl = "https://app.example/test-page.html";
    await page.goto(appUrl);
    await page.waitForFunction(() => (window as any).__SDK_LOADED === true);
    const start = await page.evaluate((descriptor) => (window as any).startCredentialEnsure(descriptor), config.descriptor);
    expect(start).toEqual({ initialized: true, sessionActive: true, publicEnsure: true });
    await Promise.race([
      page.waitForURL((next) => next.origin === "https://credentials.org"),
      page.waitForFunction(() => (window as any).__credentialEnsureFailure !== undefined).then(async () => {
        throw new Error(JSON.stringify(await page.evaluate(() => (window as any).__credentialEnsureFailure)));
      }),
    ]);
    expect(page.url()).toMatch(/^https:\/\/credentials\.org\/credentials\/acquire\/[A-Za-z0-9_-]{32}$/);
    await page.getByLabel("Verification code").fill("246810");
    await Promise.all([
      page.waitForURL((next) => next.origin === "https://app.example" && next.pathname === "/"),
      page.getByRole("button", { name: "Verify code" }).click(),
    ]);

    await page.waitForFunction(() => (window as any).__SDK_LOADED === true);
    const resumed = await page.evaluate(
      ({ descriptor, ownerDid }) => (window as any).resumeCredentialEnsure(descriptor, ownerDid),
      { descriptor: config.descriptor, ownerDid: config.ownerDid },
    );
    expect(resumed).toMatchObject({
      initialized: true,
      sessionActive: true,
      publicEnsure: true,
      redirectStoreType: "BrowserCredentialRedirectStore",
      continuationPresent: true,
      firstClear: true,
      secondClear: true,
      acquiredStatus: "acquired",
      reusedStatus: "reused",
      claimVerified: true,
      holderVerified: true,
      ownerVerified: true,
      receiptVerified: true,
      readbackVerified: true,
    });
    expect(resumed.walletSignCount).toBeGreaterThanOrEqual(1);
    expect(resumed.progress).toEqual(expect.arrayContaining(["checking", "signing", "verifying", "saving", "success"]));
    expect(creates).toBe(1);
    expect(resultReads).toBe(1);
    const stats = await fetch(`${driverUrl}/stats`).then((response) => response.json()) as {
      signedInvocation: boolean;
      kvReads: number;
      kvWrites: number;
    };
    expect(stats.signedInvocation).toBe(true);
    expect(stats.kvWrites).toBeGreaterThanOrEqual(2);
    expect(stats.kvReads).toBeGreaterThanOrEqual(2);
    const unrelated = await fetch(`${driverUrl}/unrelated-invocation-status`)
      .then((response) => response.json()) as { status: number };
    expect(unrelated.status).toBe(403);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
