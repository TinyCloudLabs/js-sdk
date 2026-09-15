import { describe, expect, it } from "bun:test";
import {
  encodeSealedInlineShareUrl,
  generateKey,
  seal,
} from "@tinycloud/share-envelope";
import {
  CredentialInvitationError,
  deliverCredentialInvitation,
} from "../src/index.js";

async function fixture() {
  const key32 = generateKey();
  const sealed = await seal(new TextEncoder().encode("signed envelope"), key32);
  const shareUrl = await encodeSealedInlineShareUrl({
    origin: "https://share.example",
    ciphertext: sealed.blob,
    key32,
  });
  return {
    shareUrl,
    receipt: {
      request: {
        returnLink: shareUrl,
        schema: "xyz.tinycloud.credentials/invitation-request/v1",
      },
      admission: { schema: "xyz.tinycloud.policy/delivery-admission/v0" },
      proof: { alg: "EdDSA" },
    },
  };
}

describe("credential invitation client", () => {
  it("posts only the exact signed receipt to the generic credentials endpoint", async () => {
    const { shareUrl, receipt } = await fixture();
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    await expect(
      deliverCredentialInvitation({
        credentialsOrigin: "https://witness.credentials.org",
        receipt,
        shareUrl,
        fetchFn: async (url, init) => {
          calls.push({ url: String(url), init });
          return Response.json({ status: "accepted" }, { status: 202 });
        },
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://witness.credentials.org/v1/credential-invitations",
      init: {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(receipt);
  });

  it("fails closed for a plaintext query link, response drift, and rejected delivery", async () => {
    const { shareUrl, receipt } = await fixture();
    const noFetch = async () => {
      throw new Error("must not fetch");
    };
    await expect(
      deliverCredentialInvitation({
        credentialsOrigin: "https://witness.credentials.org",
        receipt: {
          ...receipt,
          request: {
            ...receipt.request,
            returnLink:
              "https://share.example/viewer?tc2=recipient@example.com",
          },
        },
        shareUrl: "https://share.example/viewer?tc2=recipient@example.com",
        fetchFn: noFetch,
      }),
    ).rejects.toMatchObject({
      code: "invalid-receipt",
    } satisfies Partial<CredentialInvitationError>);
    await expect(
      deliverCredentialInvitation({
        credentialsOrigin: "https://witness.credentials.org",
        receipt,
        shareUrl,
        fetchFn: async () =>
          Response.json({ status: "accepted", extra: true }, { status: 202 }),
      }),
    ).rejects.toMatchObject({
      code: "invalid-response",
    } satisfies Partial<CredentialInvitationError>);
    await expect(
      deliverCredentialInvitation({
        credentialsOrigin: "https://witness.credentials.org",
        receipt,
        shareUrl,
        fetchFn: async () =>
          Response.json({ error: "invitation_not_accepted" }, { status: 400 }),
      }),
    ).rejects.toMatchObject({
      code: "rejected",
    } satisfies Partial<CredentialInvitationError>);
  });
});
