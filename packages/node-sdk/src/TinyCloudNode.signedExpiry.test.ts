// TC-2276: when the user changes the expiry in the OpenKey approval, everything the node derives from the session
// uses the SIGNED expiry, not the configured session lifetime. Simulated OpenKey: a popup-shaped authorize function
// that regenerates the SIWE with a new Expiration Time and signs it with a local key. Nothing reaches OpenKey.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import type { CapabilityKeyRegistry } from "@tinycloud/sdk-core";
import { richResultFor, withExpiration } from "./test-support/openkey-result";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PRIVATE_KEY = "1".padStart(64, "0");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeNode(sessionExpirationMs: number) {
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const node = new TinyCloudNode({
    signer,
    wasmBindings: new NodeWasmBindings(),
    host: "https://tinycloud.test",
    sessionExpirationMs,
    autoCreateSpace: false,
  } as ConstructorParameters<typeof TinyCloudNode>[0]);
  return { node, signer };
}

function rootExpiries(node: TinyCloudNode): number[] {
  const internals = node as unknown as {
    _capabilityRegistry: CapabilityKeyRegistry;
    auth: { tinyCloudSession: { sessionKey: string } };
  };
  return internals._capabilityRegistry
    .getDelegationsForKey(internals.auth.tinyCloudSession.sessionKey)
    .map((d) => d.expiry.getTime());
}

describe("signed expiry reaches the registry root", () => {
  for (const [label, configMs, signedMs] of [
    ["a signed expiry later than the configured lifetime", HOUR_MS, 10 * DAY_MS],
    ["a signed expiry earlier than the configured lifetime", 30 * DAY_MS, 2 * HOUR_MS],
  ] as const) {
    test(label, async () => {
      const { node, signer } = makeNode(configMs);
      const signedExpiry = new Date(Date.now() + signedMs).toISOString();
      await node.signInWithOpenKey(
        async (request) => richResultFor(signer, withExpiration(request.siwe, signedExpiry)),
        { expiryChangeable: true },
      );

      const signedAt = new Date(signedExpiry).getTime();
      const expiries = rootExpiries(node);
      expect(expiries.length).toBeGreaterThan(0);
      // Every registered root expires when the signed session does, not now + the configured lifetime.
      expect(expiries.every((e) => e === signedAt)).toBe(true);
    });
  }

  test("delegateTo cannot outlive the signed expiry", async () => {
    const { node, signer } = makeNode(30 * DAY_MS);
    const signedExpiry = new Date(Date.now() + 2 * HOUR_MS).toISOString();
    await node.signInWithOpenKey(
      async (request) => richResultFor(signer, withExpiration(request.siwe, signedExpiry)),
      { expiryChangeable: true },
    );
    const recipient = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    const { delegation } = await node.delegateTo(
      recipient,
      [{ service: "tinycloud.kv", space: "default", path: "items/", actions: ["get"] }],
      { expiry: "30d" },
    );
    expect(delegation.expiry.getTime()).toBeLessThanOrEqual(new Date(signedExpiry).getTime());
  });
});

describe("without the opt-in", () => {
  test("a changed expiry is still refused and no session is created", async () => {
    const { node, signer } = makeNode(HOUR_MS);
    await expect(
      node.signInWithOpenKey(async (request) =>
        richResultFor(signer, withExpiration(request.siwe, new Date(Date.now() + 10 * DAY_MS).toISOString())),
      ),
    ).rejects.toThrow("OpenKey signedMessage altered immutable SIWE fields: expirationTime");
  });
});

describe("prepared sign-in", () => {
  test("prepareOpenKeySignIn({expiryChangeable}) sends the flag and the prepared completion accepts the signed expiry", async () => {
    const { node, signer } = makeNode(HOUR_MS);
    const pending = await node.prepareOpenKeySignIn({ expiryChangeable: true });
    expect(pending.request.expiryChangeable).toBe(true);
    const signedExpiry = new Date(Date.now() + 10 * DAY_MS).toISOString();
    await node.signInWithPreparedOpenKey(pending, async (request) =>
      richResultFor(signer, withExpiration(request.siwe, signedExpiry)),
    );
    expect(rootExpiries(node).every((e) => e === new Date(signedExpiry).getTime())).toBe(true);
  });
});

describe("a restored session", () => {
  test("keeps the signed expiry: the registry root and delegateTo use it, not the configured lifetime", async () => {
    const { node, signer } = makeNode(30 * DAY_MS);
    const signedExpiry = new Date(Date.now() + 2 * HOUR_MS).toISOString();
    await node.signInWithOpenKey(
      async (request) => richResultFor(signer, withExpiration(request.siwe, signedExpiry)),
      { expiryChangeable: true },
    );
    const persisted = node.restorableSession!;
    expect(/Expiration Time: (.+)/.exec(persisted.siwe)?.[1]).toBe(signedExpiry);

    // A new process: same signer, a 30 day configured lifetime, only the persisted record to go on.
    const restored = new TinyCloudNode({
      signer: new PrivateKeySigner(PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      host: "https://tinycloud.test",
      sessionExpirationMs: 30 * DAY_MS,
      autoCreateSpace: false,
    } as ConstructorParameters<typeof TinyCloudNode>[0]);
    await restored.restoreSession(persisted);

    const expiries = rootExpiries(restored);
    expect(expiries.length).toBeGreaterThan(0);
    expect(expiries.every((e) => e === new Date(signedExpiry).getTime())).toBe(true);
    const { delegation } = await restored.delegateTo(
      "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      [{ service: "tinycloud.kv", space: "default", path: "items/", actions: ["get"] }],
      { expiry: "30d" },
    );
    expect(delegation.expiry.getTime()).toBeLessThanOrEqual(new Date(signedExpiry).getTime());
  });
});

// The configured lifetime replaces the signed expiry only when the SIWE cannot be parsed (or has no Expiration Time
// line). Every expiry that parses is used as signed, even one that is far away or already past.
describe("getSignedSessionExpiry fallback", () => {
  const CONFIG_MS = HOUR_MS;

  async function signedSiwe(): Promise<string> {
    const { node, signer } = makeNode(CONFIG_MS);
    await node.signInWithOpenKey(
      async (request) => richResultFor(signer, withExpiration(request.siwe, new Date(Date.now() + 2 * DAY_MS).toISOString())),
      { expiryChangeable: true },
    );
    return (node as unknown as { auth: { tinyCloudSession: { siwe: string } } }).auth.tinyCloudSession.siwe;
  }

  function expiryFor(siwe: string): number {
    const { node } = makeNode(CONFIG_MS);
    (node as unknown as { auth: unknown }).auth = { tinyCloudSession: { siwe } };
    return (node as unknown as { getSignedSessionExpiry(): Date }).getSignedSessionExpiry().getTime();
  }

  test("a SIWE that parses to any expiry is used as signed, not replaced by the configured lifetime", async () => {
    const siwe = await signedSiwe();
    for (const iso of [
      new Date(Date.now() + 9 * 365 * DAY_MS).toISOString(),
      new Date(Date.now() + 5 * 60_000).toISOString(),
      new Date(Date.now() - DAY_MS).toISOString(),
    ]) {
      expect(expiryFor(withExpiration(siwe, iso))).toBe(new Date(iso).getTime());
    }
  });

  test("an unparseable SIWE falls back to the configured lifetime", async () => {
    const before = Date.now();
    const fallback = expiryFor("not a siwe message");
    expect(fallback).toBeGreaterThanOrEqual(before + CONFIG_MS);
    expect(fallback).toBeLessThanOrEqual(Date.now() + CONFIG_MS);
  });

  test("a valid SIWE without an Expiration Time line falls back to the configured lifetime", async () => {
    const noExpiry = (await signedSiwe()).replace(/^Expiration Time: .*\n/m, "");
    const before = Date.now();
    const fallback = expiryFor(noExpiry);
    expect(fallback).toBeGreaterThanOrEqual(before + CONFIG_MS);
    expect(fallback).toBeLessThanOrEqual(Date.now() + CONFIG_MS);
  });
});
