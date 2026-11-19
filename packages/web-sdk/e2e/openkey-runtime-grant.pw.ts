import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// TC-2281. A restored session, the app's Allow button, `requestPermissions`: the runtime grant is signed through the REAL
// `@openkey/sdk` OpenKey class, whose connect() and signMessage() each open a popup with window.open.
//
// A browser lets a page open a popup only while the user's click is fresh (transient user activation, about 5 s, and
// opening a popup can spend it). The user needs longer than that to sign in inside the connect popup, so the sign popup that
// follows is blocked (the OpenKey class then rejects POPUP_BLOCKED). In popup mode the SDK therefore connects an unconnected
// client, rejects OPENKEY_CONNECTED_RETRY, and signs on the next click. Iframe mode opens no popup and signs in one click.
//
// Playwright's page.evaluate counts as a user gesture, so the spec never evaluates while a popup waits for the user.
// Playwright launches Chromium with --disable-popup-blocking; it is removed here so popups are blocked as in a user's browser.
// Chromium's headless shell never blocks popups, so the spec runs the full Chromium (channel "chromium"). The control test
// proves the blocking is on. Only the node (no WASM, no network) and the OpenKey widget pages are stand-ins.
// Built by `bun run build:e2e-openkey-grant`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/openkey-grant.bundle.js"), "utf8");
const APP = "http://tinycloud-ui.test";
const OPENKEY = "https://openkey.test";
const ALICE = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
// Longer than Chromium's 5 s transient user activation.
const USER_SIGN_IN_MS = 6000;

test.use({ channel: "chromium", launchOptions: { ignoreDefaultArgs: ["--disable-popup-blocking"] } });

interface GrantWindow {
  __grant: {
    restore(mode: "popup" | "iframe"): void;
    allow(): Promise<void>;
    connectThenSignInOneClick(): Promise<void>;
    state(): { signatures: string[]; outcomes: Array<{ ok: boolean; code?: string; name?: string; message?: string }> };
  };
}

// One page for the popup (window.opener) and the iframe (window.parent). It answers like the OpenKey widget: a connect
// request gets the connected key after the time a user needs to sign in (longer than the activation window), a sign request
// signs, and a sign request with no key dead-ends as the real widget does.
const WIDGET = `<!doctype html><html><body><script>
const target = window.opener || window.parent;
const appOrigin = new URLSearchParams(location.search).get("origin");
// The popup closes itself once it has answered, so the next window.open opens a new window instead of reusing this one.
const answered = () => { if (window.opener) window.close(); };
addEventListener("message", (event) => {
  if (event.origin !== appOrigin) return;
  const request = event.data;
  if (request.type === "openkey:auth:request") {
    setTimeout(() => { target.postMessage({ type: "openkey:auth:response", success: true, address: "${ALICE}", keyId: "key-1", keyType: "MANAGED" }, appOrigin); answered(); }, ${USER_SIGN_IN_MS});
  } else if (request.type === "openkey:sign:request") {
    target.postMessage(request.keyId
      ? { type: "openkey:sign:response", success: true, signature: "0xsig:" + request.keyId + ":" + request.message, address: "${ALICE}" }
      : { type: "openkey:sign:response", success: false, error: { code: "NO_KEY", message: "Please connect first to sign messages." } }, appOrigin);
    answered();
  }
});
target.postMessage({ type: "openkey:ready" }, appOrigin);
</script></body></html>`;

async function mount(context: BrowserContext, page: Page, mode: "popup" | "iframe") {
  await context.route(`${OPENKEY}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: WIDGET }));
  await page.route(`${APP}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/grant.bundle.js") return route.fulfill({ status: 200, contentType: "application/javascript", body: BUNDLE });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body><button id="allow" onclick="__grant.allow()">Allow</button><button id="one-click" onclick="__grant.connectThenSignInOneClick()">One click</button><script src="/grant.bundle.js"></script></body></html>`,
    });
  });
  await page.goto(`${APP}/`);
  await page.evaluate((m) => (window as unknown as GrantWindow).__grant.restore(m), mode);
}

const state = (page: Page) => page.evaluate(() => (window as unknown as GrantWindow).__grant.state());

// Clicks, then waits without evaluating in the page, then reads the outcome (see the note on page.evaluate above).
async function click(page: Page, selector: string, outcomes: number, waitMs: number) {
  await page.click(selector);
  await page.waitForTimeout(waitMs);
  expect((await state(page)).outcomes).toHaveLength(outcomes);
}

test("control: connect() then signMessage() from one click in popup mode, the sign popup is blocked because the user took a while to connect", async ({ context, page }) => {
  await mount(context, page, "popup");
  const popups: Page[] = [];
  page.on("popup", (popup) => popups.push(popup));

  await page.click("#one-click");
  await page.waitForTimeout(USER_SIGN_IN_MS + 3000);

  expect((await state(page)).outcomes[0]).toMatchObject({ ok: false, code: "POPUP_BLOCKED" });
  expect((await state(page)).signatures).toEqual([]);
  expect(popups).toHaveLength(1);
});

test("popup mode, restored session: the first Allow connects and asks for another click, the second signs with the connected keyId in one popup", async ({ context, page }) => {
  await mount(context, page, "popup");
  const popups: Page[] = [];
  page.on("popup", (popup) => popups.push(popup));

  await click(page, "#allow", 1, USER_SIGN_IN_MS + 2000);

  let now = await state(page);
  expect(now.outcomes[0]).toMatchObject({ ok: false, name: "OpenKeySigningKeyError", code: "OPENKEY_CONNECTED_RETRY" });
  expect(now.signatures).toEqual([]);
  expect(popups).toHaveLength(1);

  await click(page, "#allow", 2, 1500);

  now = await state(page);
  expect(now.outcomes[1]).toEqual({ ok: true });
  expect(now.signatures).toEqual(["0xsig:key-1:prepared-siwe"]);
  expect(popups).toHaveLength(2);
});

test("iframe mode, restored session: one Allow connects and signs with the connected keyId, no popup", async ({ context, page }) => {
  await mount(context, page, "iframe");
  const popups: Page[] = [];
  page.on("popup", (popup) => popups.push(popup));

  await click(page, "#allow", 1, USER_SIGN_IN_MS + 2000);

  const now = await state(page);
  expect(now.outcomes[0]).toEqual({ ok: true });
  expect(now.signatures).toEqual(["0xsig:key-1:prepared-siwe"]);
  expect(popups).toHaveLength(0);
});
