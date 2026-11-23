import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prepareExactAppKeyRequest } from "@tinycloud/node-sdk/encryption-keys";
import { startPreparedOpenKeyHandoff } from "./prepared-openkey.js";

const OWNER = "did:pkh:eip155:1:0xe8c2ab8468210C4b507C0563A10da60990eaa792";
const KEY = "apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/seal-v1";

const realError = console.error;
const realFetch = globalThis.fetch;
let printed: string[];
beforeEach(() => {
  printed = [];
  console.error = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  globalThis.fetch = (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch;
});
afterEach(() => {
  console.error = realError;
  globalThis.fetch = realFetch;
});

function payloadOf(url: string): { request: Record<string, unknown>; delivery: Record<string, unknown> } {
  return JSON.parse(Buffer.from(url.split("#tv2=")[1]!, "base64url").toString("utf8"));
}

describe("app-key hand-off request", () => {
  test("carries the exact key and the unchanged SIWE, and no private key", async () => {
    const built = prepareExactAppKeyRequest(KEY, OWNER, 3_600_000);
    const sessionDid = /^URI: (.+)$/m.exec(built.prepared.siwe)![1]!;
    const handoff = await startPreparedOpenKeyHandoff({
      prepared: { siwe: built.prepared.siwe, jwk: built.request.sessionKey as never, host: "https://node.example", verificationMethod: sessionDid },
      openKeyHost: "https://openkey.example",
      appKey: built.appKey,
      paste: true,
    });
    handoff.result.catch(() => undefined);
    try {
      const { request, delivery } = payloadOf(handoff.url);
      expect(Object.keys(request)).toEqual(["protocolVersion", "siwe", "jwk", "host", "sessionDid", "appKey"]);
      expect(request.siwe).toBe(built.request.requestedSiwe);
      expect(request.appKey).toEqual({ appId: "xyz.tinycloud.share", key: "xyz.tinycloud.tinyapps.contacts/seal-v1" });
      expect(request.sessionDid).toBe(sessionDid);
      expect(JSON.stringify(request.jwk)).not.toContain('"d"');
      expect(Object.keys(delivery).sort()).toEqual(["cancelSecret", "handoffId", "state"]);
      expect(printed.join("\n")).toContain(handoff.url);
    } finally {
      await handoff.complete(false);
    }
  });

  test("an ordinary hand-off has no app-key field", async () => {
    const built = prepareExactAppKeyRequest(KEY, OWNER, 3_600_000);
    const sessionDid = /^URI: (.+)$/m.exec(built.prepared.siwe)![1]!;
    const handoff = await startPreparedOpenKeyHandoff({
      prepared: { siwe: built.prepared.siwe, jwk: built.request.sessionKey as never, host: "https://node.example", verificationMethod: sessionDid },
      openKeyHost: "https://openkey.example",
      paste: true,
    });
    handoff.result.catch(() => undefined);
    try {
      expect(Object.keys(payloadOf(handoff.url).request)).toEqual(["protocolVersion", "siwe", "jwk", "host", "sessionDid"]);
    } finally {
      await handoff.complete(false);
    }
  });
});
