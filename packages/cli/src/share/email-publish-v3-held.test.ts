import { describe, expect, test } from "bun:test";
import { publishEmailShareV3, type EmailPublishV3Input } from "./email-publish-v3.js";

// TC-2254 (C8.3 (1)): a share can be addressed to a ticket (did:key) email credential only. The credential descriptor validator now also
// accepts the held shape (S7), so the publish path must refuse it itself, as it did before S7, before building any requirement.
const vectors = await Bun.file(new URL("../../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const goldens = (await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json()) as { vectors: { name: string; descriptor: unknown }[] };
const ticket = goldens.vectors.find((vector) => vector.name === "email")!.descriptor;
const input = (credentialDescriptor: unknown): EmailPublishV3Input => ({
  shareId: "s1", resource: { kind: "exact", path: "shares/s1/note.txt" },
  contentSource: { encryptionKeyPath: "share/s1", encryptionNetwork: "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default" },
  target: { kind: "email", address: "person@example.com" },
  credentialDescriptor, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
}) as unknown as EmailPublishV3Input;

describe("email share publish refuses a held credential descriptor", () => {
  test("a held descriptor is refused with the ticket-only error, before any requirement is built", async () => {
    await expect(publishEmailShareV3(input(vectors.descriptor.held))).rejects.toThrow("email credential descriptor is not a ticket (did:key) descriptor");
  });
  test("a ticket descriptor is not refused by that check (it fails later, on the rest of the incomplete input)", async () => {
    const error = await publishEmailShareV3(input(ticket)).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("not a ticket");
  });
});
