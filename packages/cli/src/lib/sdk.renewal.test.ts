import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A CLI command restores a stored owner session whose original grant has ended; only its saved lease can keep it.
const home = mkdtempSync(join(tmpdir(), "tc2904-sdk-renewal-"));
process.env.TC_HOME = join(home, "tc");
let session: Record<string, unknown> | null = null;
const key = { kty: "OKP", crv: "Ed25519", x: "public", d: "private" };
const profile = { name: "renewal", posture: "owner-openkey", authMethod: "openkey", did: "did:key:zAgent", sessionDid: "did:key:zAgent", host: "https://node.example" };

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    getProfile: async () => profile,
    getSession: async () => session,
    getKey: async () => key,
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
  },
}));

const calls: string[] = [];
let renewalOutcome: () => Promise<void> = async () => {};
const realNodeSdk = await import("@tinycloud/node-sdk");
mock.module("@tinycloud/node-sdk", () => ({
  ...realNodeSdk,
  TinyCloudNode: class {
    async restoreSession() { calls.push("restore"); throw Object.assign(new Error("expired"), { code: "AUTH_EXPIRED" }); }
    async restoreSessionWithRenewal(_data: unknown, lease: string) { calls.push(`renew:${lease}`); await renewalOutcome(); }
  },
}));

const { restoreProfileSessionNode } = await import("./sdk.js");
const ctx = { profile: "renewal", host: "https://node.example" };
const stored = (leaseEnd: string) => ({
  delegationHeader: { Authorization: "Bearer original" }, delegationCid: "bafyoriginal", spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
  verificationMethod: "did:key:zAgent", address: "0xowner", chainId: 1, siwe: "Expiration Time: 2026-01-01T00:00:00.000Z", signature: "0xsigned",
  expiresAt: "2026-01-01T00:00:00.000Z", renewal: { receipt: { leaseAuthorization: "saved-lease", leaseExpiresAt: leaseEnd } },
});

beforeEach(() => { calls.length = 0; renewalOutcome = async () => {}; });
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

test("past its original grant, a stored session restores through its saved lease", async () => {
  session = stored(new Date(Date.now() + 86_400_000).toISOString());
  expect(await restoreProfileSessionNode(ctx)).toHaveProperty("node");
  expect(calls).toEqual(["restore", "renew:saved-lease"]);
});

test("a lease the node reports as ended reads as an expired session", async () => {
  session = stored(new Date(Date.now() + 86_400_000).toISOString());
  renewalOutcome = async () => { throw Object.assign(new Error("ended"), { code: "RENEWAL_LEASE_EXPIRED" }); };
  expect(await restoreProfileSessionNode(ctx)).toEqual({ unavailable: "session_expired" });
});

test("a lease whose signed end has passed is not tried at all", async () => {
  session = stored(new Date(Date.now() - 1000).toISOString());
  expect(await restoreProfileSessionNode(ctx)).toEqual({ unavailable: "session_expired" });
  expect(calls).toEqual([]);
});
