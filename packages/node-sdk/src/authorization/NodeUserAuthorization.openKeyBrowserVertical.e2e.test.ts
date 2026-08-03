// Vertical happy-path browser e2e proof.
//
// This test spans two repos and three processes:
//   1. `scripts/vertical-happy-path-harness.test.ts` in OpenKey — a real Hono
//      server mounted on 127.0.0.1:<harnessPort> exposing `/api/delegate/*`,
//      `/api/keys/*`, and `/api/auth/get-session`.
//   2. `apps/web` in OpenKey — the real SvelteKit widget served by vite dev
//      on http://localhost:5778 with VITE-visible `VITE_API_URL` pointed at
//      the harness.
//   3. A tiny `Bun.serve` requester page that imports the OpenKey SDK's built
//      `dist/index.mjs` (with an import map for `@openkey/core`) and exposes
//      an `OpenKey` instance on `window.openkey`.
//
// The test drives the full flow with Playwright chromium:
//   - `NodeUserAuthorization.signInWithOpenKey(authorizeFn, { openkeyKeyId: 'key_harness' })`
//   - `authorizeFn` invokes `window.openkey.authorizeTinyCloud(...)` in the page
//   - Playwright waits for the widget iframe (`/widget/embed/sign`) to navigate,
//     clicks Approve → waits for the button label to change to "Approve exact
//     bytes" → opens `<details class="advanced-details">` → reads
//     `pre.raw-bytes` (the EXACT bytes the widget will sign) → clicks Approve
//     again → returns the finalize result.
//   - The test asserts byte-for-byte equality (no trim, no normalization) of
//     the displayed bytes against the intercepted preview response body, the
//     intercepted finalize response body, the returned OpenKey result, and
//     the completed js-sdk `ClientSession.siwe` — proving the operator
//     reviewed EXACTLY the bytes that flow into the resulting session.
//
// This is the missing link between the wire-shape test
// (`NodeUserAuthorization.crossRepoHono.e2e.test.ts`) and the UI. It proves
// that what the user visually reviews is what actually flows into the TinyCloud
// session — without mocking either the widget UI, the server, or the SDK.
//
// Opt-in only. The test must be able to run in CI from a clean checkout, so
// the CI job is responsible for pointing at a real OpenKey worktree and
// building its `packages/sdk` / `packages/core` dist artifacts. When neither
// env is set the test THROWS at module load time — silently skipping would
// leave the vertical contract untested and the acceptance gate would pass
// spuriously.
//
// Documented deterministic seams (do NOT expand this list):
//   * `HARNESS_SIGNER_PRIVATE_KEY` — deterministic ETH private key so the
//     harness signer matches the OpenKey SDK-side private-key signer.
//   * `requireSession` middleware mock — the OpenKey `/api/*` routes require
//     an authenticated session; the mock injects a fixed userId so the
//     otherwise-unrelated better-auth flow does not gate the review path.
//   * `activateSessionWithHost` / `fetchPeerId` / `submitHostDelegation` are
//     stubbed so the SDK's post-sign activation step does not hit the
//     TinyCloud node (it does not exist in this test).
//   * A narrow fetch stub for the fake `https://tinycloud.test` host so the
//     `/info` and `/delegate` calls inside `signInWithPreparedSession` do not
//     hit the network. Every other URL (harness on 127.0.0.1, vite dev on
//     localhost, the requester page) goes through the real fetch.
// The public preparation, OpenKey preview/finalize routes, SDK transport,
// production review components, and result completion path are ALL real.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chromium,
  type Browser,
  type Frame,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "playwright";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { wireOpenKeyAuthorize } from "./openKeyBridge";

// Deterministic test key — MUST match the harness signer so
// `result.address === signer.getAddress()` holds and the widget's `key.address`
// (from the mocked prisma record) agrees with the signature the harness emits.
const PRIVATE_KEY = ("0x" + "1".padStart(64, "0")) as `0x${string}`;

const VITE_PORT = 5778;
const REQUESTER_PORT_HINT = 0; // Bun.serve picks a free port when 0.

function resolveHarnessPath(): { harnessPath: string; openkeyWorktree: string } | null {
  const envHarness = process.env.OPENKEY_VERTICAL_HARNESS?.trim();
  if (envHarness) {
    if (!existsSync(envHarness)) {
      throw new Error(
        `OPENKEY_VERTICAL_HARNESS is set to ${envHarness} but that path does not exist`,
      );
    }
    const openkeyWorktree = resolve(envHarness, "..", "..");
    return { harnessPath: envHarness, openkeyWorktree };
  }

  const envWorktree = process.env.OPENKEY_WORKTREE?.trim();
  if (envWorktree) {
    const harnessPath = resolve(envWorktree, "scripts/vertical-happy-path-harness.test.ts");
    if (!existsSync(harnessPath)) {
      throw new Error(
        `OPENKEY_WORKTREE=${envWorktree} does not contain scripts/vertical-happy-path-harness.test.ts`,
      );
    }
    return { harnessPath, openkeyWorktree: envWorktree };
  }

  const defaultHarnessPath = resolve(
    import.meta.dirname,
    "../../../../../../../openkey/skgbafa/openkey-authorization-consolidation/scripts/vertical-happy-path-harness.test.ts",
  );
  const defaultWorktree = resolve(
    import.meta.dirname,
    "../../../../../../../openkey/skgbafa/openkey-authorization-consolidation",
  );
  if (existsSync(defaultHarnessPath) && existsSync(defaultWorktree)) {
    return { harnessPath: defaultHarnessPath, openkeyWorktree: defaultWorktree };
  }
  return null;
}

const resolved = resolveHarnessPath();
if (!resolved) {
  throw new Error(
    "OpenKey vertical happy-path harness not found. This browser e2e test proves " +
      "that the widget-rendered `pre.raw-bytes` (Approve exact bytes) is byte-for-byte " +
      "the SIWE that flows into signInWithOpenKey — silently skipping would leave " +
      "that vertical contract untested. Set one of:\n" +
      "  OPENKEY_VERTICAL_HARNESS=<absolute path to scripts/vertical-happy-path-harness.test.ts>\n" +
      "  OPENKEY_WORKTREE=<absolute path to the OpenKey repo root>\n" +
      "and ensure the OpenKey worktree's packages/sdk and packages/core have been built.",
  );
}

const HARNESS_PATH = resolved.harnessPath;
const OPENKEY_WORKTREE = resolved.openkeyWorktree;

let harnessProc: ReturnType<typeof Bun.spawn> | null = null;
let viteProc: ReturnType<typeof Bun.spawn> | null = null;
let harnessPort: number | null = null;
let requesterServer: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
let originalFetch: typeof globalThis.fetch;

async function waitForPort(url: string, budgetMs: number, fetchImpl: typeof fetch): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < budgetMs) {
    try {
      const res = await fetchImpl(url);
      if (res.ok || res.status < 500) {
        return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForPort timed out after ${budgetMs}ms waiting for ${url} — last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

beforeAll(async () => {
  // Capture the un-stubbed fetch BEFORE we install any stubs so the
  // wait-for-vite and wait-for-harness probes reach the real network.
  originalFetch = globalThis.fetch;

  // 1. Spawn the vertical harness subprocess.
  harnessProc = Bun.spawn(
    ["bun", "test", HARNESS_PATH],
    {
      cwd: OPENKEY_WORKTREE,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HARNESS_PORT: "0",
        HARNESS_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
        OPENKEY_RUN_HARNESS: "1",
      },
    },
  );
  {
    const start = Date.now();
    const reader = harnessProc.stdout.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    while (Date.now() - start < 30_000) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value);
      const match = acc.match(/HARNESS_READY (\d+)/);
      if (match && match[1]) {
        harnessPort = Number(match[1]);
        break;
      }
    }
    reader.releaseLock();
    if (!harnessPort) {
      const errBytes: Uint8Array[] = [];
      const errReader = harnessProc.stderr.getReader();
      const errStart = Date.now();
      while (Date.now() - errStart < 500) {
        const { value, done } = await errReader.read();
        if (done) break;
        if (value) errBytes.push(value);
      }
      errReader.releaseLock();
      const errText = new TextDecoder().decode(
        Buffer.concat(errBytes.map((b) => Buffer.from(b))),
      );
      throw new Error(
        `Vertical harness never printed HARNESS_READY; stderr:\n${errText}\nstdout so far:\n${acc}`,
      );
    }
    // Small settle so Bun.serve is accepting connections.
    await new Promise((r) => setTimeout(r, 50));
  }

  // 2. Spawn vite dev for the OpenKey web app, pointed at the harness.
  viteProc = Bun.spawn(
    ["bun", "run", "dev"],
    {
      cwd: resolve(OPENKEY_WORKTREE, "apps/web"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        WEB_PORT: String(VITE_PORT),
        API_URL: `http://127.0.0.1:${harnessPort}`,
        VITE_API_URL: `http://127.0.0.1:${harnessPort}`,
      },
    },
  );
  try {
    await waitForPort(
      `http://localhost:${VITE_PORT}`,
      120_000,
      originalFetch,
    );
  } catch (e) {
    // Dump vite stderr to help debugging.
    const errBytes: Uint8Array[] = [];
    const errReader = viteProc.stderr.getReader();
    const errStart = Date.now();
    while (Date.now() - errStart < 500) {
      const { value, done } = await errReader.read();
      if (done) break;
      if (value) errBytes.push(value);
    }
    errReader.releaseLock();
    const errText = new TextDecoder().decode(
      Buffer.concat(errBytes.map((b) => Buffer.from(b))),
    );
    throw new Error(
      `vite dev never became ready on http://localhost:${VITE_PORT}. stderr:\n${errText}\nOriginal error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // 3. Serve a tiny requester page that loads the OpenKey SDK from disk.
  const sdkDistPath = resolve(OPENKEY_WORKTREE, "packages/sdk/dist/index.mjs");
  const coreDistPath = resolve(OPENKEY_WORKTREE, "packages/core/dist/index.js");
  if (!existsSync(sdkDistPath)) {
    throw new Error(
      `Missing ${sdkDistPath} — run \`bun run --cwd packages/sdk build\` in the OpenKey worktree before this test.`,
    );
  }
  if (!existsSync(coreDistPath)) {
    throw new Error(
      `Missing ${coreDistPath} — run \`bun run --cwd packages/core build\` in the OpenKey worktree before this test.`,
    );
  }
  const sdkMjs = readFileSync(sdkDistPath, "utf8");
  const coreJs = readFileSync(coreDistPath, "utf8");
  const requesterHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>OpenKey Vertical Harness Requester</title>
<script type="importmap">
{
  "imports": {
    "@openkey/core": "/openkey-core.js"
  }
}
</script>
</head>
<body>
<h1>OpenKey Vertical Harness Requester</h1>
<div id="status">loading</div>
<script type="module">
  import * as OpenKey from '/openkey-sdk.mjs';
  window.__OpenKey = OpenKey;
  document.getElementById('status').textContent = 'ready';
</script>
</body>
</html>`;

  requesterServer = Bun.serve({
    port: REQUESTER_PORT_HINT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(requesterHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/openkey-sdk.mjs") {
        return new Response(sdkMjs, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      if (url.pathname === "/openkey-core.js") {
        return new Response(coreJs, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  // 4. Launch chromium.
  browser = await chromium.launch({ headless: true });

  // 5. Install fetch stub for tinycloud.test only — harness (127.0.0.1) and
  //    the vite dev / requester server go through the real fetch. The stub
  //    mirrors the crossRepoHono test's rules exactly so the /info + /delegate
  //    activation follow-ups in `signInWithPreparedSession` don't hit the
  //    network.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
      return originalFetch(input, init);
    }
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ activated: ["space"], skipped: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
}, 180_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (browser) {
    try {
      await browser.close();
    } catch { /* ignore */ }
  }
  if (requesterServer) {
    try {
      requesterServer.stop();
    } catch { /* ignore */ }
  }
  if (viteProc) {
    try {
      viteProc.kill("SIGTERM");
    } catch { /* ignore */ }
  }
  if (harnessProc) {
    try {
      harnessProc.kill("SIGTERM");
    } catch { /* ignore */ }
  }
});

test(
  "signInWithOpenKey drives the real widget UI end to end (byte-for-byte proof)",
  async () => {
    if (!browser || !requesterServer || !harnessPort) {
      throw new Error("beforeAll did not initialize the browser/requester/harness");
    }

    const wasm = new NodeWasmBindings();
    const signer = new PrivateKeySigner(PRIVATE_KEY.slice(2));
    const address = await signer.getAddress();

    // The manifest is the SDK's identity in this test. It carries:
    //   - ordinary application storage (`defaults: true` → `tinycloud.kv/*`
    //     and `tinycloud.sql/*` on the applications space, prefixed by
    //     `app_id`), so the widget renders standard-severity permissions.
    //   - one app-scoped secret via the `secrets` field, which
    //     `resolveManifest` in @tinycloud/sdk-core expands into a
    //     `tinycloud.vault/read` entry that lands on the signer's own
    //     secrets space at path `vault/secrets/scoped/<scope>/<NAME>`.
    //     That grant triggers the sensitive-callout branch in the widget.
    // Both surfaces are exercised by the mandatory assertions below.
    const SECRET_NAME = "VERTICAL_TEST_TOKEN";
    const SECRET_SCOPE = "authorization-review";
    const APP_NAME = "Vertical Test App";
    const APP_ID = "vertical-happy-path-test";
    const auth = new NodeUserAuthorization({
      signer,
      wasmBindings: wasm,
      signStrategy: { type: "auto-sign" },
      domain: "localhost",
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      manifest: {
        app_id: APP_ID,
        name: APP_NAME,
        defaults: true,
        secrets: {
          [SECRET_NAME]: {
            scope: SECRET_SCOPE,
            actions: ["read"],
          },
        },
      } as any,
    });

    const page: Page = await browser.newPage();
    // Surface page errors so a failure inside the page is not silent.
    page.on("pageerror", (err) => {
      // eslint-disable-next-line no-console
      console.error("[requester page error]", err);
    });
    page.on("console", (msg) => {
      const t = msg.type();
      // Only bubble up warnings and errors — routine debug logs from vite
      // HMR are noise in a passing test.
      if (t === "error" || t === "warning") {
        // eslint-disable-next-line no-console
        console.warn(`[page ${t}]`, msg.text());
      }
    });

    // Record real preview/finalize responses as they fly by. Playwright
    // observes them WITHOUT intercepting or mutating — every request is
    // fulfilled by the real Hono handler in the harness process. The
    // recorded bodies are compared byte-for-byte against the DOM-visible
    // raw bytes and against the SDK's finalize result below.
    const observed: {
      previewBody: any | null;
      finalizeBody: any | null;
      previewSeen: boolean;
      finalizeSeen: boolean;
      // Promises that resolve when each response body finishes being
      // consumed by our listener. Awaited before the post-flight
      // assertions so the JSON parse is not racing the assertions.
      previewBodyReady?: Promise<void>;
      finalizeBodyReady?: Promise<void>;
    } = {
      previewBody: null,
      finalizeBody: null,
      previewSeen: false,
      finalizeSeen: false,
    };
    let resolvePreviewReady!: () => void;
    let resolveFinalizeReady!: () => void;
    observed.previewBodyReady = new Promise<void>((r) => {
      resolvePreviewReady = r;
    });
    observed.finalizeBodyReady = new Promise<void>((r) => {
      resolveFinalizeReady = r;
    });
    // Classify a Hono route URL into 'preview' | 'finalize' | 'other'.
    // `authorize-sign-prepare` shares the `authorize-sign` prefix but is
    // an entirely different route — we must not conflate it with the
    // final signing route.
    function classify(url: string): "preview" | "finalize" | "other" {
      const path = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })();
      if (path.endsWith("/api/delegate/authorize-sign-preview")) return "preview";
      if (path.endsWith("/api/delegate/authorize-sign")) return "finalize";
      return "other";
    }
    page.on("request", (req: PlaywrightRequest) => {
      if (req.method() !== "POST") return;
      const kind = classify(req.url());
      if (kind === "preview") observed.previewSeen = true;
      else if (kind === "finalize") observed.finalizeSeen = true;
    });
    page.on("response", async (res: PlaywrightResponse) => {
      if (res.request().method() !== "POST") return;
      if (res.status() !== 200) return;
      const kind = classify(res.url());
      if (kind === "other") return;
      try {
        const body = await res.json();
        if (kind === "preview") {
          observed.previewBody = body;
          resolvePreviewReady();
        } else if (kind === "finalize") {
          observed.finalizeBody = body;
          resolveFinalizeReady();
        }
      } catch {
        /* body already consumed; ignore */
      }
    });

    const requesterUrl = `http://localhost:${requesterServer.port}/`;
    await page.goto(requesterUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#status:has-text('ready')", { timeout: 15_000 });

    // Seed the OpenKey instance on the page: point host at the vite dev
    // (widget origin), oauthHost at the harness, and pre-populate `lastAuth`
    // so `authorizeTinyCloud()` routes straight to the managed-key server-
    // signing path (no /api/keys round-trip, no connect flow).
    await page.evaluate(
      (init) => {
        const OpenKeyNs: any = (window as any).__OpenKey;
        const openkey = new OpenKeyNs.OpenKey({
          host: init.widgetHost,
          oauthHost: init.oauthHost,
          appName: init.appName,
          mode: "iframe",
        });
        // Seed the connected key state — bypasses the connect flow and
        // routes authorizeTinyCloud straight to the managed-key path.
        (openkey as any).lastAuth = {
          keyId: "key_harness",
          address: init.address,
          keyType: "MANAGED",
        };
        // Bearer token propagated to the widget in embed context so
        // `isEmbedContext() && !!getSessionToken()` flips embedAuthenticated
        // to true. The harness's session mock accepts any token — the value
        // is opaque here.
        (openkey as any).sessionToken = "token_vertical_harness";
        (window as any).openkey = openkey;
      },
      {
        widgetHost: `http://localhost:${VITE_PORT}`,
        oauthHost: `http://127.0.0.1:${harnessPort}`,
        appName: APP_ID,
        address,
      },
    );

    // Bytes the widget actually renders in the `Approve exact bytes` pane —
    // captured mid-flow (immediately before final approval) and asserted
    // against the finalize `signedMessage` and the intercepted route bodies.
    let displayedRaw: string | null = null;
    // The mandatory manifest-driven UI observations. Captured BEFORE final
    // approval so they represent what the operator actually reviewed.
    let manifestNameRendered: string | null = null;
    let sensitiveCalloutRendered: string | null = null;
    let secretGrantVisible = false;
    let trustBadgeText: string | null = null;

    const authorizeFn = wireOpenKeyAuthorize({
      async authorizeTinyCloud(request) {
        // The request object crosses the JSON boundary into the page — anything
        // non-serializable would silently drop. `presentation.manifests[0].payload`
        // is a plain object so this round-trips cleanly.
        const serializableRequest = JSON.parse(JSON.stringify(request));

        // Start listening for the widget frame BEFORE we kick off the SDK call
        // so we don't miss the navigation event.
        const widgetFrameNavPromise = page.waitForEvent("framenavigated", {
          predicate: (f) => f.url().includes("/widget/embed/sign"),
          timeout: 30_000,
        });

        // Fire the SDK call inside the page — it opens the iframe modal and
        // resolves with the widget's response.
        const authorizeResultPromise = page.evaluate(
          async (req) => {
            const openkey = (window as any).openkey;
            return await openkey.authorizeTinyCloud(req);
          },
          serializableRequest,
        );

        // Wait for the widget iframe to appear.
        await widgetFrameNavPromise;
        const widgetFrame: Frame | undefined = page
          .frames()
          .find((f) => f.url().includes("/widget/embed/sign"));
        if (!widgetFrame) {
          throw new Error("widget frame not found after framenavigated");
        }

        // Wait for the Approve button to render.
        await widgetFrame.waitForSelector("button.approve", { timeout: 30_000 });

        // First click: requestPreview() → server narrows/echoes bytes,
        // previewReady becomes true, button label flips to "Approve exact
        // bytes".
        await widgetFrame.click("button.approve");

        // Poll for the label change. Playwright's built-in `hasText` selector
        // is timing-sensitive here because the button's text is a derived
        // Svelte $state; `waitForFunction` on the button's textContent is the
        // reliable observation.
        try {
          await widgetFrame.waitForFunction(
            () => {
              const btn = document.querySelector("button.approve");
              return btn?.textContent?.trim().includes("Approve exact bytes") ?? false;
            },
            { timeout: 30_000 },
          );
        } catch (e) {
          const diag = await widgetFrame.evaluate(() => ({
            buttonText: document.querySelector("button.approve")?.textContent ?? null,
            buttonDisabled:
              (document.querySelector("button.approve") as HTMLButtonElement | null)
                ?.disabled ?? null,
            errorText: document.querySelector(".error")?.textContent ?? null,
            calloutText:
              document.querySelector("p.sensitive-callout")?.textContent ?? null,
            bodyLen: document.body?.innerText?.length ?? 0,
            bodyPreview: document.body?.innerText?.slice(0, 500) ?? null,
          }));
          // eslint-disable-next-line no-console
          console.error("[widget diagnostics on timeout]", diag);
          throw e;
        }

        // Open the Advanced details disclosure so `pre.raw-bytes` and the
        // manifest identity/trust rows are rendered/visible.
        await widgetFrame.click("details.advanced-details > summary");
        await widgetFrame.waitForSelector("pre.raw-bytes", { timeout: 5_000 });

        // Capture the raw bytes verbatim — `textContent` is what the operator
        // reads on-screen. NO trimming.
        displayedRaw = await widgetFrame.$eval(
          "pre.raw-bytes",
          (el) => el.textContent ?? "",
        );
        if (!displayedRaw || displayedRaw.length === 0) {
          throw new Error("Advanced details raw-bytes was empty");
        }

        // Capture the manifest identity, trust label, and sensitive callout
        // BEFORE final approval — these represent the operator's context at
        // the moment of consent.
        manifestNameRendered = await widgetFrame.$eval(
          '.identity .row:has(span.label:has-text("Manifest name")) span.value',
          (el) => el.textContent?.trim() ?? null,
        ).catch(() => null);
        trustBadgeText = await widgetFrame.$eval(
          '.identity .trust-value',
          (el) => el.textContent?.trim() ?? null,
        ).catch(() => null);
        sensitiveCalloutRendered = await widgetFrame.$eval(
          'p.sensitive-callout',
          (el) => el.textContent?.trim() ?? null,
        ).catch(() => null);
        // The secret vault grant is one of the entries under `.permissions`.
        // Its `grant-path` code element contains the vault path with the
        // secret name; assert visibility by scanning the rendered permissions
        // for the exact secret name.
        secretGrantVisible = await widgetFrame.evaluate(
          (name) => {
            const paths = Array.from(document.querySelectorAll(".grant-path"));
            return paths.some((el) => (el.textContent ?? "").includes(name));
          },
          SECRET_NAME,
        );

        // Second click: final approve. Widget POSTs /authorize-sign and posts
        // the result back to the SDK via the shared transport.
        await widgetFrame.click("button.approve");

        // Await the SDK's finalize result.
        const result = (await authorizeResultPromise) as {
          protocolVersion: 1;
          address: string;
          signature: string;
          signedMessage: string;
          selectedActionKeys: string[];
          permissions: Array<{ service: string; space: string; path: string; actions: string[] }>;
        };

        // Load-bearing byte-for-byte assertions. NO trim / normalize /
        // reconstruction. The operator MUST review exactly the bytes the
        // server signs, and exactly the bytes that flow into the resulting
        // session.
        expect(displayedRaw).toBe(result.signedMessage);

        return result;
      },
    });

    // The manifest hook expands the request into a wider grant plan; the
    // harness accepts the managed-key selection by default.
    const session = await auth.signInWithOpenKey(authorizeFn, {
      openkeyKeyId: "key_harness",
    });

    // ---- Post-flight byte-exact wire assertions ----

    // Ensure the response-body observers have finished consuming JSON
    // BEFORE we assert against them. Without this the assertion racing
    // Playwright's async `res.json()` can see the value as `null` or
    // partially populated.
    await Promise.race([
      Promise.all([observed.previewBodyReady, observed.finalizeBodyReady]),
      new Promise((_r, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Timed out waiting for preview/finalize response bodies to be observed — ` +
                  `previewSeen=${observed.previewSeen} finalizeSeen=${observed.finalizeSeen} ` +
                  `previewBody=${observed.previewBody ? "captured" : "null"} ` +
                  `finalizeBody=${observed.finalizeBody ? "captured" : "null"}`,
              ),
            ),
          15_000,
        ),
      ),
    ]);

    // 1. Both preview and finalize routes were actually traversed on the
    //    real Hono routes (via the vite dev proxy → harness).
    expect(observed.previewSeen).toBe(true);
    expect(observed.finalizeSeen).toBe(true);
    expect(observed.previewBody).not.toBeNull();
    expect(observed.finalizeBody).not.toBeNull();

    // 2. The displayed bytes equal the finalize `signedMessage` (from the
    //    intercepted response body — proves the route ACTUALLY returned
    //    those bytes) exactly.
    expect(observed.finalizeBody!.signedMessage).toBe(displayedRaw);
    // And the preview signed bytes agree with the displayed bytes (the
    // widget's `pre.raw-bytes` is the preview signedMessage under the
    // preview/final approval binding).
    expect(observed.previewBody!.signedMessage).toBe(displayedRaw);

    // 3. The completed session's SIWE bytes equal the displayed bytes.
    expect(session.address.toLowerCase()).toBe(address.toLowerCase());
    expect(session.siwe).toBeDefined();
    expect(session.siwe!).toBe(displayedRaw!);

    // 4. Manifest-driven UI observations are MANDATORY — the operator must
    //    have reviewed the ordinary permission list, the exact app-scoped
    //    secret name, the honest manifest trust label, and the exact
    //    sensitive callout copy from the contract.
    expect(manifestNameRendered).toBe(APP_NAME);
    // `unsigned` is the honest trust state for this test: no https origin
    // is available (localhost) so origin-bound cannot be established, and
    // no signed manifest was published. The contract requires honesty
    // rather than any specific status, but we assert one of the recognized
    // honest labels rather than allowing arbitrary text.
    expect(trustBadgeText).not.toBeNull();
    const RECOGNIZED_TRUST = new Set([
      "Manifest signature verified",
      "Manifest served by verified https origin",
      "No signed manifest",
      "Manifest signature is stale",
      "Manifest signed by an unknown key",
      "Manifest digest does not match declared content",
    ]);
    expect(RECOGNIZED_TRUST.has(trustBadgeText!)).toBe(true);
    // Sensitive callout MUST render — the manifest secret produces a
    // secrets-space grant that satisfies `grantReachesSecretDataOrDecryption`.
    // Copy must match the contract exactly (`N exact grants ...`).
    expect(sensitiveCalloutRendered).not.toBeNull();
    expect(
      /^\d+ exact grants reach secret data or decryption\. You can review them below\.$/.test(
        sensitiveCalloutRendered!,
      ),
    ).toBe(true);
    // The exact secret name from the manifest must appear in the rendered
    // permission list.
    expect(secretGrantVisible).toBe(true);

    await page.close();
  },
  120_000,
);
