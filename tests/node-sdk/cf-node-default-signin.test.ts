import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";

import { checkServerHealth, SERVER_URL, TEST_KEY } from "./setup";

/**
 * TC-482 regression gate: a DEFAULT full-permission sign-in (no `manifest`
 * passed at all) against cf-node.
 *
 * cf-node-kv-delegation.test.ts (the other committed cf-node acceptance
 * gate) - and every other cf-node harness in this repo - always passes a
 * narrow, KV-only manifest. That is deliberate for THAT test (it pins exact
 * wire-level KV/delegation behavior), but it means the SDK's actual default
 * codepath - `new TinyCloudNode({ host, privateKey })` with no `manifest`
 * field, which falls back to `NodeUserAuthorization.defaultActions`
 * (kv+sql+duckdb+capabilities+hooks, all unrestricted, PLUS a raw
 * `urn:tinycloud:encryption:...` NetworkId capability every no-manifest
 * sign-in requests - see `resolveSignInCapabilities` in
 * NodeUserAuthorization.ts) - had never been exercised against cf-node by
 * any committed test. That gap hid TC-482: cf-node's WASM verifier rejected
 * the encryption NetworkId resource with `Decode: Incorrect Structure` (a
 * resource shape the Rust node accepts), and cf-node's own error mapping
 * then turned that structured rejection into an opaque 500
 * `"[object Object]"` instead of a typed 4xx.
 *
 * This is the single most common client shape - the SDK's own default - so
 * it must never again regress invisibly.
 *
 * Validate against prod first (the oracle - this exact default shape MUST
 * succeed there, since it's the shape prod already serves in production):
 *   TC_TEST_SERVER=https://node.tinycloud.xyz \
 *   TC_TEST_PRIVATE_KEY=<disposable 64-hex key> \
 *   bun test tests/node-sdk/cf-node-default-signin.test.ts
 *
 * Then against cf-node (preview or production):
 *   TC_TEST_SERVER=https://tc-cf-node-preview.skgbafa.workers.dev \
 *   TC_TEST_PRIVATE_KEY=<disposable 64-hex key> \
 *   bun test tests/node-sdk/cf-node-default-signin.test.ts
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SPACE_NAME = "default";
const SMOKE_KEY = `cf-node-default-signin-test/${RUN_ID}/round-trip.bin`;
const SMOKE_BYTES = new TextEncoder().encode(
  "cf-node default sign-in acceptance payload",
);

// Live network round-trips against a real remote node can exceed bun's
// default 5s per-test budget (see cf-node-kv-delegation.test.ts).
const TEST_TIMEOUT = 30000;

const originalFetch = globalThis.fetch.bind(globalThis);
let lastDelegateStatus: number | undefined;
let lastDelegateBody: string | undefined;

function installFetchCapture(): void {
  lastDelegateStatus = undefined;
  lastDelegateBody = undefined;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ? input.clone() : new Request(input, init);
    const response = await originalFetch(request.clone());
    if (new URL(request.url).pathname === "/delegate") {
      lastDelegateStatus = response.status;
      lastDelegateBody = await response.clone().text();
    }
    return response;
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("CF-Node Default (No-Manifest) Sign-In Acceptance", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    installFetchCapture();
    await checkServerHealth();
  });

  afterAll(() => {
    restoreFetch();
  });

  test("Default full-permission sign-in (no manifest) succeeds against cf-node", async () => {
    // No `manifest` field: this is the plain SDK default, which requests
    // kv+sql+duckdb+capabilities+hooks (all unrestricted) plus a raw
    // encryption NetworkId capability - the exact shape TC-482 covers.
    alice = new TinyCloudNode({
      host: SERVER_URL,
      privateKey: TEST_KEY,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
    });

    await alice.signIn();
    console.log("[Alice] Signed in (default, no manifest), DID:", alice.did);
    expect(alice.did.startsWith("did:pkh:")).toBe(true);

    // signIn() itself calls POST /delegate (ensureSpaceExists ->
    // activateSessionWithHost). This is the request that 500'd on
    // cf-node before TC-482's fix.
    expect(lastDelegateStatus).toBeDefined();
    expect(lastDelegateStatus).toBeLessThan(300);
    if (lastDelegateStatus !== undefined && lastDelegateStatus >= 300) {
      console.error("[Alice] /delegate failed body:", lastDelegateBody);
    }
  }, TEST_TIMEOUT);

  test("Hosting the owned space succeeds (POST /delegate with the full default recap)", async () => {
    const spaceId = await alice.hostOwnedSpace(SPACE_NAME);
    console.log("[Alice] Hosted space:", spaceId);
    expect(spaceId.endsWith(`:${SPACE_NAME}`)).toBe(true);
    expect(lastDelegateStatus).toBeDefined();
    expect(lastDelegateStatus).toBeLessThan(300);
  }, TEST_TIMEOUT);

  test("The resulting session can actually read/write KV in the default space", async () => {
    // Proves the session isn't just "not 500" but genuinely authorized:
    // defaultActions grants unrestricted kv on the default space (path "").
    const put = await alice.space(SPACE_NAME).kv.put(SMOKE_KEY, SMOKE_BYTES, {
      contentType: "application/octet-stream",
    });
    expect(put.ok).toBe(true);

    const get = await alice.space(SPACE_NAME).kv.get<Uint8Array>(SMOKE_KEY, {
      binary: true,
    });
    expect(get.ok).toBe(true);
    if (!get.ok) throw new Error("unreachable");
    expect(Buffer.from(get.data.data).equals(Buffer.from(SMOKE_BYTES))).toBe(
      true,
    );

    await alice.space(SPACE_NAME).kv.delete(SMOKE_KEY);
  }, TEST_TIMEOUT);
});
