import { describe, expect, mock, test } from "bun:test";
import type { EmailPublishV3Input } from "./email-publish-v3.js";

// TC-2254 A2.5 (C8.3 (6)): a share can be addressed to a ticket (did:key) email credential only. `validateCredentialFlowDescriptor` is shape-only
// and now also accepts the held descriptor (S7), so `publishEmailShareV3` refuses an account_is_subject descriptor itself, before publishing.
const publishCalls: unknown[][] = [];
const realShareSdk = await import("@tinycloud/share-sdk");
mock.module("@tinycloud/share-sdk", () => ({
  ...realShareSdk,
  publishAddressedShare: async (...args: unknown[]) => { publishCalls.push(args); throw new Error("spy: published"); },
}));
const { publishEmailShareV3 } = await import("./email-publish-v3.js");

const vectors = await Bun.file(new URL("../../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const goldens = (await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json()) as { vectors: { name: string; descriptor: unknown }[] };
const ticket = goldens.vectors.find((vector) => vector.name === "email")!.descriptor as { issuer: { did: string; kid: string } };
const input = (credentialDescriptor: unknown): EmailPublishV3Input => ({
  shareId: "s1", resource: { kind: "exact", path: "shares/s1/note.txt" },
  contentSource: { encryptionKeyPath: "share/s1", encryptionNetwork: "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default" },
  target: { kind: "email", address: "person@example.com" },
  credentialDescriptor, issuerDid: ticket.issuer.did, issuerKid: ticket.issuer.kid,
}) as unknown as EmailPublishV3Input;

describe("email share publish refuses a held credential descriptor", () => {
  test("a held descriptor is refused with the ticket-only error and publishAddressedShare is not called", async () => {
    publishCalls.length = 0;
    await expect(publishEmailShareV3(input(vectors.descriptor.held))).rejects.toThrow("email credential descriptor is not a ticket (did:key) descriptor");
    expect(publishCalls).toHaveLength(0);
  });

  test("control: a ticket descriptor passes that check and reaches publishAddressedShare", async () => {
    publishCalls.length = 0;
    const error = await publishEmailShareV3(input(ticket)).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain("spy: published");
    expect(publishCalls).toHaveLength(1);
  });
});
