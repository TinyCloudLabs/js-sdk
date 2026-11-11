import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import type { TargetPublishInput } from "@tinycloud/share-sdk";
import type { EmailInviteApprover } from "./invite-approval.js";

const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const events: string[] = [];
const requests: string[] = [];
let holdsDecrypt = false;
const APPROVED_ID = "c3".repeat(16);
const descriptor = ((JSON.parse(await readFile(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url), "utf8")) as {
  vectors: { name: string; descriptor: unknown }[];
}).vectors.find((vector) => vector.name === "email")!.descriptor);

const EXPIRES = new Date(Math.floor((Date.now() + 86_400_000) / 1000) * 1000);
const stop = new Error("stopped after the encryption step");
const node = {
  credentialHolderDid: ownerDid,
  isSessionOnly: true,
  restorableSession: {
    spaceId: "tinycloud:test-space",
    siwe: "share.example wants you to sign in with your Ethereum account:\n0x0000000000000000000000000000000000000001\n\nSign in to TinyCloud\n\nURI: https://share.example\nVersion: 1\nChain ID: 1\nNonce: 12345678\nIssued At: 2025-01-01T00:00:00.000Z\nExpiration Time: 2099-01-01T00:00:00.000Z",
    signature: "signed-proof",
  },
  activeNodeIdentity: async () => ({ origin: "https://node.example", nodeDid: "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2" }),
  publishActiveNodeLocation: async () => { events.push("registry record"); },
  getDefaultEncryptionNetworkId: () => `urn:tinycloud:encryption:${ownerDid}:default`,
  getEncryptionNetworkIdForSpace: () => `urn:tinycloud:encryption:${ownerDid}:default`,
  hasRuntimePermissions: () => holdsDecrypt,
  // The v2 path-bound sender encrypts through the node's named-key service; nothing here ever creates a key.
  keys: { encrypt: async (path: string) => { events.push(`encrypt ${path}`); throw stop; }, createKey: async () => { events.push("createKey"); return { ok: true as const }; } },
};
mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async ({ profile }: { profile: string }) => ({ profile, host: "https://node.example" }), getProfile: async () => ({ authMethod: "openkey" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));

const { createShareAuthorityAdapters } = await import("./adapters.js");

const input: TargetPublishInput = {
  source: new TextEncoder().encode("only me"), filename: "note.md", target: { kind: "email", address: "owner@example.com" },
  credentialDescriptor: descriptor, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
  expiresAt: EXPIRES, origin: "https://share.example", mediaType: "text/markdown",
} as TargetPublishInput;

const adapter = (approveEmailInviteKey?: EmailInviteApprover) =>
  createShareAuthorityAdapters({
    origin: "https://share.example", profileName: async () => "test", ...(approveEmailInviteKey === undefined ? {} : { approveEmailInviteKey }),
    fetchFn: (async (url: string | URL | Request) => {
      requests.push(String(url));
      return Response.json({ version: "tinycloud.share/config-v2", shareOrigin: "https://share.example", registryOrigin: "https://registry.example", credentialsOrigin: "https://credentials.example" });
    }) as unknown as typeof globalThis.fetch,
  }).targetAdapter;

afterEach(() => {
  events.length = 0;
  requests.length = 0;
  holdsDecrypt = false;
});

describe("per-invitation approval for a session-only email share", () => {
  it("asks for the approval with the recipient, file name and expiry before any request, then encrypts under only the approved key and never creates one", async () => {
    const asked: unknown[] = [];
    const error = await adapter(async (request) => {
      asked.push({ ...request, node: undefined, contentSha256: undefined });
      // Everything that needs no owner action has passed first: the one request so far is the share service's config check.
      expect(requests).toHaveLength(1);
      expect(events).toEqual([]);
      return { shareId: APPROVED_ID, accessExpiresAt: input.expiresAt.toISOString(), resumed: false };
    }).publish(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBe(stop);
    expect(asked).toEqual([{ node: undefined, profile: "test", recipientEmail: "owner@example.com", subjectName: "note.md", subjectKind: "file", accessExpiresAt: EXPIRES, contentSha256: undefined }]);
    expect(events).toEqual(["registry record", `encrypt share/${APPROVED_ID}`]);
  });

  it("refuses a file that would stay readable longer than the 31-day policy root limit before any request or approval, and accepts 31 days minus 30 seconds", async () => {
    let asked = 0;
    const approver = async (request: { accessExpiresAt: Date }) => { asked += 1; return { shareId: APPROVED_ID, accessExpiresAt: request.accessExpiresAt.toISOString(), resumed: false }; };
    const past = { ...input, expiresAt: new Date(Date.now() + 35 * 86_400_000) } as TargetPublishInput;
    const refused = await adapter(approver as never).publish(past).then(() => undefined, (caught: unknown) => caught) as { failure?: { kind: string; requestedDays: number; limitDays: number } };
    expect(refused?.failure).toEqual({ kind: "invite-access-too-long", requestedDays: 35, limitDays: 31 });
    expect(asked).toBe(0);
    expect(requests).toEqual([]);
    expect(events).toEqual([]);
    const within = { ...input, expiresAt: new Date(Date.now() + 31 * 86_400_000 - 30_000) } as TargetPublishInput;
    expect(await adapter(approver as never).publish(within).then(() => undefined, (caught: unknown) => caught)).toBe(stop);
    expect(asked).toBe(1);
  });

  it("checks the share origin before asking for any approval", async () => {
    let asked = 0;
    const wrongOrigin = { ...input, origin: "https://other.example" } as TargetPublishInput;
    await expect(adapter((async () => { asked += 1; return { shareId: APPROVED_ID, accessExpiresAt: "", resumed: false }; }) as never).publish(wrongOrigin)).rejects.toThrow("origin-mismatch");
    expect(asked).toBe(0);
  });

  it("issues a resumed approval's own earlier absolute date, never a recomputed or later one, and refuses any other difference", async () => {
    const earlier = new Date(EXPIRES.getTime() - 40_000).toISOString();
    const resumedApprover = (async () => ({ shareId: APPROVED_ID, accessExpiresAt: earlier, resumed: true })) as never;
    expect(await adapter(resumedApprover).publish(input).then(() => undefined, (caught: unknown) => caught)).toBe(stop);
    const later = new Date(EXPIRES.getTime() + 40_000).toISOString();
    await expect(adapter((async () => ({ shareId: APPROVED_ID, accessExpiresAt: later, resumed: true })) as never).publish(input)).rejects.toThrow("invalid-request");
    await expect(adapter((async () => ({ shareId: APPROVED_ID, accessExpiresAt: earlier, resumed: false })) as never).publish(input)).rejects.toThrow("invalid-request");
  });

  it("refuses an approval whose signed access date is not the expiry the share is issued with, before anything is requested or encrypted", async () => {
    for (const accessExpiresAt of [new Date(EXPIRES.getTime() - 1000).toISOString(), new Date(EXPIRES.getTime() + 1000).toISOString()]) {
      requests.length = 0;
      const error = await adapter(async () => ({ shareId: APPROVED_ID, accessExpiresAt, resumed: false })).publish(input).then(() => undefined, (caught: unknown) => caught);
      expect(String(error)).toContain("invalid-request");
      expect(requests).toHaveLength(1); // the share service config check only
      expect(events).toEqual([]);
    }
  });

  it("stops with nothing created or requested when the approval is refused", async () => {
    const refusal = new Error("the owner declined");
    const error = await adapter(async () => { throw refusal; }).publish(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBe(refusal);
    expect(requests).toHaveLength(1); // the share service config check only
    expect(events).toEqual([]);
  });

  it("does not ask when the session already holds decrypt for the share key, and is refused as before without an approver", async () => {
    holdsDecrypt = true;
    let asked = 0;
    const error = await adapter(async () => { asked += 1; return { shareId: APPROVED_ID, accessExpiresAt: input.expiresAt.toISOString(), resumed: false }; }).publish(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBe(stop);
    expect(asked).toBe(0);
    expect(events.at(-1)).toMatch(/^encrypt share\/[0-9a-f]{32}$/);
    holdsDecrypt = false;
    await expect(adapter().publish(input)).rejects.toThrow("decrypt-not-held");
  });
});
