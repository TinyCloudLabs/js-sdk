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

const stop = new Error("stopped after the encryption step");
const keyNode = {
  keys: { createKey: async (path: string) => { events.push(`key-node createKey ${path}`); return { ok: true as const }; } },
  encryption: { encryptToNetwork: async (_network: string, _bytes: Uint8Array, options?: { keyPath?: string }) => { events.push(`key-node encrypt ${options?.keyPath}`); throw stop; } },
};
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
  keys: { createKey: async () => { events.push("main createKey"); return { ok: true as const }; } },
  encryption: { encryptToNetwork: async (_network: string, _bytes: Uint8Array, options?: { keyPath?: string }) => { events.push(`main encrypt ${options?.keyPath}`); throw stop; } },
};
mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async ({ profile }: { profile: string }) => ({ profile, host: "https://node.example" }), getProfile: async () => ({ authMethod: "openkey" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));

const { createShareAuthorityAdapters } = await import("./adapters.js");

const input: TargetPublishInput = {
  source: new TextEncoder().encode("only me"), filename: "note.md", target: { kind: "email", address: "owner@example.com" },
  credentialDescriptor: descriptor, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"), origin: "https://share.example", mediaType: "text/markdown",
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
  it("asks for the approval with the recipient, file name and expiry before any request, then creates and uses only the approved key", async () => {
    const asked: unknown[] = [];
    const error = await adapter(async (request) => {
      asked.push({ ...request, node: undefined });
      expect(requests).toEqual([]);
      expect(events).toEqual([]);
      return { shareId: APPROVED_ID, keyNode };
    }).publish(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBe(stop);
    expect(asked).toEqual([{ node: undefined, profile: "test", recipientEmail: "owner@example.com", subjectName: "note.md", subjectKind: "file", accessExpiresAt: new Date("2030-01-01T00:00:00.000Z") }]);
    // The approver's key id, and only the key node, create the key and encrypt: the session's own node never encrypts.
    expect(events).toEqual(["registry record", `key-node createKey share/${APPROVED_ID}`, `key-node encrypt share/${APPROVED_ID}`]);
  });

  it("stops with nothing created or requested when the approval is refused", async () => {
    const refusal = new Error("the owner declined");
    const error = await adapter(async () => { throw refusal; }).publish(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBe(refusal);
    expect(requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it("does not ask when the session already holds decrypt for the share key", async () => {
    holdsDecrypt = true;
    let asked = 0;
    const error = await adapter(async () => { asked += 1; return { shareId: APPROVED_ID, keyNode }; }).publish(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBe(stop);
    expect(asked).toBe(0);
    expect(events.at(-1)).toMatch(/^main encrypt share\/[0-9a-f]{32}$/);
  });
});
