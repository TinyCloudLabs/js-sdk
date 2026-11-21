import { expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  handleAccountSetupRequired,
  isOutsideAppSetupThrottled,
  rememberOutsideAppSetupAttempt,
  throttleStorageKey,
  OUTSIDE_APP_SETUP_THROTTLE_MS,
  type OpenKeySetupClient,
  type OutsideAppThrottleStorage,
  type TinyCloudSetupResultV1,
} from "./handle-account-setup-required";

const SUBJECT = "did:pkh:eip155:1:0xAbCd00000000000000000000000000000000AbCd";

// The handler reads `globalThis.location.origin` to key the throttle. Supply a stable one for the
// test suite — without it the "no OpenKey" short-circuit and the throttle-key tests can't be
// written deterministically.
const ORIGIN = "https://outside-app.example";
(globalThis as { location?: { origin: string } }).location = { origin: ORIGIN };

function memoryThrottleStorage(): OutsideAppThrottleStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem(key) { return raw.has(key) ? raw.get(key)! : null; },
    setItem(key, value) { raw.set(key, value); },
  };
}

const STUB_NODE = { did: SUBJECT } as unknown as TinyCloudNode;
const STUB_ERROR = { setupUrl: "https://home.tinycloud.xyz/?finish-setup=registry" };

function makeOpenKeyClient(result: TinyCloudSetupResultV1 | Error): OpenKeySetupClient {
  return {
    authorizeTinyCloudSetup: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// --- throttle helper tests --------------------------------------------------

test("throttle key is lowercased per owner + per outside-app origin", () => {
  expect(throttleStorageKey(SUBJECT, ORIGIN)).toBe(`tcw.tc3657.throttle.${SUBJECT.toLowerCase()}.${ORIGIN.toLowerCase()}`);
  expect(throttleStorageKey(SUBJECT.toUpperCase(), ORIGIN.toUpperCase())).toBe(throttleStorageKey(SUBJECT, ORIGIN));
});

test("fresh storage reports not throttled; write+read within 24h round-trips true", () => {
  const storage = memoryThrottleStorage();
  const now = 1_000_000;
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage, now)).toBe(false);
  rememberOutsideAppSetupAttempt(SUBJECT, ORIGIN, storage, now);
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage, now)).toBe(true);
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage, now + OUTSIDE_APP_SETUP_THROTTLE_MS - 1)).toBe(true);
  // Exactly at the window boundary the throttle releases.
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage, now + OUTSIDE_APP_SETUP_THROTTLE_MS)).toBe(false);
});

test("throttle is per-owner-per-origin: another origin for the same owner is independent", () => {
  const storage = memoryThrottleStorage();
  rememberOutsideAppSetupAttempt(SUBJECT, ORIGIN, storage);
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage)).toBe(true);
  expect(isOutsideAppSetupThrottled(SUBJECT, "https://other-app.example", storage)).toBe(false);
  expect(isOutsideAppSetupThrottled("did:pkh:eip155:1:0x1111111111111111111111111111111111111111", ORIGIN, storage)).toBe(false);
});

test("fail-open on missing storage and unparseable values", () => {
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, undefined)).toBe(false);
  rememberOutsideAppSetupAttempt(SUBJECT, ORIGIN, undefined); // must not throw
  const storage = memoryThrottleStorage();
  storage.raw.set(throttleStorageKey(SUBJECT, ORIGIN), "not-json");
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage)).toBe(false);
  storage.raw.set(throttleStorageKey(SUBJECT, ORIGIN), JSON.stringify({ at: "nonsense" }));
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, storage)).toBe(false);
});

// --- handler flow tests -----------------------------------------------------

test("no OpenKey client → 'no-openkey', no throttle write", async () => {
  const throttleStorage = memoryThrottleStorage();
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE, openkey: undefined, throttleStorage,
  });
  expect(outcome).toBe("no-openkey");
  expect(throttleStorage.raw.size).toBe(0);
});

test("OpenKey client without authorizeTinyCloudSetup method → 'no-openkey'", async () => {
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE, openkey: {} as OpenKeySetupClient,
    throttleStorage: memoryThrottleStorage(),
  });
  expect(outcome).toBe("no-openkey");
});

test("throttle active → 'throttled', OpenKey not called", async () => {
  const throttleStorage = memoryThrottleStorage();
  rememberOutsideAppSetupAttempt(SUBJECT, ORIGIN, throttleStorage);
  let openkeyCalls = 0;
  const openkey: OpenKeySetupClient = {
    authorizeTinyCloudSetup: async () => { openkeyCalls++; return { status: "declined" }; },
  };
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE, openkey, throttleStorage,
  });
  expect(outcome).toBe("throttled");
  expect(openkeyCalls).toBe(0);
});

test("OpenKey returns 'published' → outcome 'published', throttle written, retrySignIn called", async () => {
  const throttleStorage = memoryThrottleStorage();
  let retries = 0;
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE,
    openkey: makeOpenKeyClient({ status: "published", subject: SUBJECT }),
    throttleStorage,
    retrySignIn: async () => { retries++; },
  });
  expect(outcome).toBe("published");
  expect(retries).toBe(1);
  // Throttle persists so a retry loop can't re-prompt for 24h.
  expect(throttleStorage.raw.size).toBe(1);
  expect(isOutsideAppSetupThrottled(SUBJECT, ORIGIN, throttleStorage)).toBe(true);
});

test("OpenKey returns 'already-current' → outcome 'already-current', retrySignIn still called", async () => {
  const throttleStorage = memoryThrottleStorage();
  let retries = 0;
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE,
    openkey: makeOpenKeyClient({ status: "already-current", subject: SUBJECT }),
    throttleStorage,
    retrySignIn: async () => { retries++; },
  });
  expect(outcome).toBe("already-current");
  expect(retries).toBe(1);
});

test("OpenKey returns 'declined' → 'declined', throttle STILL written (Naomi: once-per-day regardless)", async () => {
  const throttleStorage = memoryThrottleStorage();
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE,
    openkey: makeOpenKeyClient({ status: "declined" }),
    throttleStorage,
    retrySignIn: async () => { throw new Error("retry must not be called on decline"); },
  });
  expect(outcome).toBe("declined");
  expect(throttleStorage.raw.size).toBe(1);
});

test("OpenKey returns 'unavailable' → outcome 'unavailable', throttle written, retry NOT called", async () => {
  const throttleStorage = memoryThrottleStorage();
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE,
    openkey: makeOpenKeyClient({ status: "unavailable", reason: "rate-limited" }),
    throttleStorage,
    retrySignIn: async () => { throw new Error("retry must not be called when OpenKey returned unavailable"); },
  });
  expect(outcome).toBe("unavailable");
  expect(throttleStorage.raw.size).toBe(1);
});

test("OpenKey call throws → outcome 'unavailable', onError observed, throttle written, no retry", async () => {
  const throttleStorage = memoryThrottleStorage();
  const errors: unknown[] = [];
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE,
    openkey: makeOpenKeyClient(new Error("OpenKey offline")),
    throttleStorage,
    onError: (error) => errors.push(error),
    retrySignIn: async () => { throw new Error("retry must not be called when the OpenKey call threw"); },
  });
  expect(outcome).toBe("unavailable");
  expect(errors.length).toBe(1);
  expect(throttleStorage.raw.size).toBe(1);
});

test("Bobbie C3 guard: a caller-supplied `origin` field is NEVER forwarded to OpenKey", async () => {
  let seenRequest: unknown;
  const openkey: OpenKeySetupClient = {
    authorizeTinyCloudSetup: async (request) => { seenRequest = request; return { status: "declined" }; },
  };
  await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE, openkey,
    throttleStorage: memoryThrottleStorage(),
    // Even though the public type doesn't admit `origin`, exercise the runtime guard against a
    // misbehaving caller that bypasses TypeScript (e.g. JS consumer, or a hostile host).
    requestingApp: { name: "Gene Keys", manifest: { id: "gk" }, origin: "https://attacker.example" } as unknown as { name: string },
  });
  const forwarded = seenRequest as { requestingApp?: Record<string, unknown> };
  expect(forwarded.requestingApp?.name).toBe("Gene Keys");
  expect(forwarded.requestingApp?.manifest).toEqual({ id: "gk" });
  // The handler must not forward an `origin` field; OpenKey derives it from the browser (C3).
  expect("origin" in (forwarded.requestingApp ?? {})).toBe(false);
});

test("retrySignIn throws → outcome stays 'published', onError observes the throw (record exists; next sign-in succeeds on its own)", async () => {
  const throttleStorage = memoryThrottleStorage();
  const errors: unknown[] = [];
  const outcome = await handleAccountSetupRequired({
    error: STUB_ERROR, subject: SUBJECT, node: STUB_NODE,
    openkey: makeOpenKeyClient({ status: "published", subject: SUBJECT }),
    throttleStorage,
    onError: (error) => errors.push(error),
    retrySignIn: async () => { throw new Error("retry failed for unrelated reasons"); },
  });
  expect(outcome).toBe("published");
  expect(errors.length).toBe(1);
});
