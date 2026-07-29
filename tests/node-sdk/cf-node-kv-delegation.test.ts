import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode, type DelegatedAccess } from "@tinycloud/node-sdk";

import { checkServerHealth, SERVER_URL, TEST_KEY } from "./setup";

/**
 * Committed acceptance gate for the cf-node (TC-257 Chunk 2).
 *
 * Exercises exactly the surface cf-node v0 advertises (`kv` + `delegation`)
 * with a KV-only manifest (no account-registry perms, no SQL/DuckDB/
 * encryption/hooks/secrets). Runs as one serial flow: Alice signs in, hosts
 * her space via the real /peer/generate + /delegate endpoints (no seeded
 * state), round-trips a KV entry, delegates read-only access to Bob,
 * confirms Bob's write is rejected, deletes the key, and replays a captured
 * /invoke request to confirm duplicate-invocation rejection.
 *
 * Raw fetch requests/responses are captured for /peer/generate, /delegate,
 * and /invoke because the SDK layer normalizes away details (exact status
 * codes, ETag header, x-tinycloud-truncated, 404-vs-empty-list) that this
 * gate must assert precisely. See scripts/cf-node-smoke.ts in tc-bench-cfnode
 * for the reference wire-level behavior this test mirrors.
 *
 * Validate against prod first:
 *   TC_TEST_SERVER=https://node.tinycloud.xyz \
 *   TC_TEST_PRIVATE_KEY=<disposable 64-hex key> \
 *   bun test tests/node-sdk/cf-node-kv-delegation.test.ts
 *
 * Prod advertises [kv, delegation, ...], so a correctly written KV+delegation
 * test MUST pass there. A prod failure means the harness/client is wrong,
 * not that cf-node has a gap.
 */

type CapturedInvoke = {
  pathname: string;
  request: Request;
  response: Response;
};

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SPACE_NAME = "default";
const SMOKE_PREFIX = `cf-node-kv-delegation-test/${RUN_ID}/`;
const SMOKE_RELATIVE_KEY = "round-trip.bin";
const SMOKE_KEY = `${SMOKE_PREFIX}${SMOKE_RELATIVE_KEY}`;
const SMOKE_BYTES = new TextEncoder().encode(
  "cf-node kv delegation acceptance payload",
);
const SMOKE_CONTENT_TYPE = "application/octet-stream";

// Live network round-trips (put/get, delegation reads, delete+miss) can exceed
// bun's default 5s per-test budget against a real remote node. Match the repo
// convention (see duckdb-concurrency.test.ts) with an explicit generous timeout.
const TEST_TIMEOUT = 30000;

const originalFetch = globalThis.fetch.bind(globalThis);
let capturedInvocations: CapturedInvoke[] = [];

function installFetchCapture(): void {
  capturedInvocations = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ? input.clone() : new Request(input, init);
    const response = await originalFetch(request.clone());
    const pathname = new URL(request.url).pathname;
    if (
      pathname === "/delegate" ||
      pathname === "/invoke" ||
      pathname.startsWith("/peer/generate")
    ) {
      capturedInvocations.push({
        pathname,
        request: request.clone(),
        response: response.clone(),
      });
    }
    return response;
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function lastCapture(
  pathname: string,
  after: number,
): CapturedInvoke | undefined {
  for (let index = capturedInvocations.length - 1; index >= after; index -= 1) {
    const capture = capturedInvocations[index];
    if (capture && capture.pathname === pathname) {
      return capture;
    }
  }
  return undefined;
}

function countCaptures(
  matcher: (pathname: string) => boolean,
  from: number,
): number {
  return capturedInvocations
    .slice(from)
    .filter((capture) => matcher(capture.pathname)).length;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe("CF-Node KV + Delegation Acceptance", () => {
  let alice: TinyCloudNode;
  let bob: TinyCloudNode;
  let bobAccess: DelegatedAccess;
  let bobDid: string;
  let putEtag: string;
  let capturedPutInvoke: CapturedInvoke;

  beforeAll(async () => {
    installFetchCapture();
    await checkServerHealth();
  });

  afterAll(() => {
    restoreFetch();
  });

  // PART 1: Sign-in with a KV-only manifest
  test("Alice signs in with a KV-only manifest (defaults:false, no account-registry perms)", async () => {
    alice = new TinyCloudNode({
      host: SERVER_URL,
      privateKey: TEST_KEY,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "cf-node-kv-delegation-test",
        name: "CF Node KV Delegation Acceptance Test",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: SPACE_NAME,
        permissions: [
          {
            service: "tinycloud.kv",
            space: SPACE_NAME,
            path: SMOKE_PREFIX,
            actions: ["get", "put", "list", "del"],
          },
        ],
      },
    });

    await alice.signIn();
    console.log("[Alice] Signed in, DID:", alice.did);
    expect(alice.did.startsWith("did:pkh:")).toBe(true);
  }, TEST_TIMEOUT);

  // PART 2: Real space hosting, no seeded state
  test("Alice hosts her space via real /peer/generate + /delegate (no seeded state)", async () => {
    const captureStart = capturedInvocations.length;

    const spaceId = await alice.hostOwnedSpace(SPACE_NAME);
    console.log("[Alice] Hosted space:", spaceId);
    expect(spaceId.endsWith(`:${SPACE_NAME}`)).toBe(true);

    const peerGenerateCalls = countCaptures(
      (pathname) => pathname.startsWith("/peer/generate"),
      captureStart,
    );
    expect(peerGenerateCalls).toBeGreaterThanOrEqual(1);

    const delegateCapture = lastCapture("/delegate", captureStart);
    expect(delegateCapture).toBeDefined();
    const delegateBody = (await delegateCapture!.response.clone().json()) as {
      cid: string;
      activated: string[];
      skipped: string[];
    };
    expect(typeof delegateBody.cid).toBe("string");
    expect(delegateBody.cid.length).toBeGreaterThan(0);
    expect(Array.isArray(delegateBody.activated)).toBe(true);
    expect(Array.isArray(delegateBody.skipped)).toBe(true);
    expect(delegateBody.skipped.includes(spaceId)).toBe(false);
  }, TEST_TIMEOUT);

  // PART 3: KV put/get round-trip preserving raw bytes, content type, ETag
  test("KV put/get round-trip preserves raw bytes, content type, and exact ETag", async () => {
    const putCaptureIndex = capturedInvocations.length;
    const put = await alice.space(SPACE_NAME).kv.put(SMOKE_KEY, SMOKE_BYTES, {
      contentType: SMOKE_CONTENT_TYPE,
    });
    expect(put.ok).toBe(true);
    if (!put.ok) throw new Error("unreachable");
    expect(put.data.headers.etag).toBeDefined();
    putEtag = put.data.headers.etag!;

    const putCapture = lastCapture("/invoke", putCaptureIndex);
    expect(putCapture).toBeDefined();
    capturedPutInvoke = putCapture!;
    expect(await putCapture!.response.clone().text()).toBe("");
    expect(putCapture!.response.headers.get("etag")).toBe(putEtag);

    const getCaptureIndex = capturedInvocations.length;
    const get = await alice.space(SPACE_NAME).kv.get<Uint8Array>(SMOKE_KEY, {
      binary: true,
    });
    expect(get.ok).toBe(true);
    if (!get.ok) throw new Error("unreachable");
    expect(get.data.data instanceof Uint8Array).toBe(true);
    expect(bytesEqual(get.data.data, SMOKE_BYTES)).toBe(true);
    expect(get.data.headers.etag).toBe(putEtag);
    expect(get.data.headers.contentType).toBe(SMOKE_CONTENT_TYPE);

    const getCapture = lastCapture("/invoke", getCaptureIndex);
    expect(getCapture).toBeDefined();
    expect(getCapture!.response.headers.get("etag")).toBe(putEtag);
    expect(getCapture!.response.headers.get("content-type")).toBe(
      SMOKE_CONTENT_TYPE,
    );
    const rawGetBytes = new Uint8Array(
      await getCapture!.response.clone().arrayBuffer(),
    );
    expect(bytesEqual(rawGetBytes, SMOKE_BYTES)).toBe(true);
  }, TEST_TIMEOUT);

  // PART 4: KV list returns the inserted key
  test("KV list returns the inserted key with x-tinycloud-truncated:false", async () => {
    const listCaptureIndex = capturedInvocations.length;
    const list = await alice
      .space(SPACE_NAME)
      .kv.list({ prefix: SMOKE_PREFIX });
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error("unreachable");
    expect(list.data.keys).toEqual([SMOKE_KEY]);

    const listCapture = lastCapture("/invoke", listCaptureIndex);
    expect(listCapture).toBeDefined();
    expect(listCapture!.response.headers.get("x-tinycloud-truncated")).toBe(
      "false",
    );
    const rawBody = (await listCapture!.response.clone().json()) as string[];
    expect(rawBody).toEqual([SMOKE_KEY]);
  }, TEST_TIMEOUT);

  // PART 5: Alice delegates ONLY tinycloud.kv/get to Bob
  test("Alice delegates only tinycloud.kv/get for the smoke prefix to Bob", async () => {
    bob = new TinyCloudNode({
      host: SERVER_URL,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
    });
    bobDid = bob.did.split("#", 1)[0]!;
    console.log("[Bob] Session-key DID:", bobDid);

    const delegated = await alice.delegateTo(bobDid, [
      {
        service: "tinycloud.kv",
        space: SPACE_NAME,
        path: SMOKE_PREFIX,
        actions: ["get"],
      },
    ]);
    expect(delegated.prompted).toBe(false);
    expect(typeof delegated.delegation.cid).toBe("string");
    expect(delegated.delegation.cid.length).toBeGreaterThan(0);

    bobAccess = await bob.useDelegation(delegated.delegation);
  }, TEST_TIMEOUT);

  // PART 6: Bob reads OK; Bob's write is rejected
  test("Bob reads via delegation OK; Bob's write is REJECTED", async () => {
    const read = await bobAccess.kv.get<Uint8Array>(SMOKE_RELATIVE_KEY, {
      binary: true,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(bytesEqual(read.data.data, SMOKE_BYTES)).toBe(true);
    expect(read.data.headers.etag).toBe(putEtag);

    const writeCaptureIndex = capturedInvocations.length;
    const write = await bobAccess.kv.put(SMOKE_RELATIVE_KEY, SMOKE_BYTES);
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error("unreachable");
    console.log(
      "[Bob] write rejected:",
      write.error.code,
      write.error.message,
    );

    const writeCapture = lastCapture("/invoke", writeCaptureIndex);
    expect(writeCapture).toBeDefined();
    console.log("[Bob] raw write status:", writeCapture!.response.status);
    expect(writeCapture!.response.ok).toBe(false);
    expect(write.error.code).toBe("AUTH_UNAUTHORIZED");
  }, TEST_TIMEOUT);

  // PART 7: Delete + subsequent read returns SDK KV_NOT_FOUND backed by raw 404
  test("Delete + subsequent read returns KV_NOT_FOUND backed by raw 404", async () => {
    const deleteCaptureIndex = capturedInvocations.length;
    const del = await alice.space(SPACE_NAME).kv.delete(SMOKE_KEY);
    expect(del.ok).toBe(true);

    const deleteCapture = lastCapture("/invoke", deleteCaptureIndex);
    expect(deleteCapture).toBeDefined();
    expect(await deleteCapture!.response.clone().text()).toBe("");

    const missingCaptureIndex = capturedInvocations.length;
    const missing = await bobAccess.kv.get<Uint8Array>(SMOKE_RELATIVE_KEY, {
      binary: true,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error.code).toBe("KV_NOT_FOUND");
    expect(missing.error.message).toContain("Key not found");

    // "Backed by raw 404": assert the wire status is 404. The raw body text is
    // deliberately NOT asserted here — it is server-implementation-specific
    // (prod/Rocket serves a generic HTML 404 page; cf-node serves plain
    // "Key not found"). The portable contract is the 404 status plus the SDK's
    // synthesized KV_NOT_FOUND / "Key not found: <key>" error above, which
    // KVService.classifyNotFound produces from the status, not the body.
    const missingCapture = lastCapture("/invoke", missingCaptureIndex);
    expect(missingCapture).toBeDefined();
    expect(missingCapture!.response.status).toBe(404);
  }, TEST_TIMEOUT);

  // PART 8: Replaying the exact captured /invoke request is rejected as a duplicate
  test("Replaying the exact captured put invocation returns 409 with 'duplicate'", async () => {
    expect(capturedPutInvoke).toBeDefined();
    const replay = await originalFetch(capturedPutInvoke.request.clone());
    expect(replay.status).toBe(409);
    const body = await replay.text();
    expect(body.toLowerCase()).toContain("duplicate");
  }, TEST_TIMEOUT);
});
