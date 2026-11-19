import { describe, expect, it } from "bun:test";
import { generateKey, seal } from "@tinycloud/share-envelope";
import { buildFullLink, buildShortLink, prepareLinkRecord, signerFromSeed } from "@tinycloud/share-envelope/links";
import {
  CredentialInvitationError,
  deliverCredentialInvitation,
} from "../src/index.js";

const LINK_ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";

async function fixture() {
  const key32 = generateKey();
  const sealed = await seal(new TextEncoder().encode("signed envelope"), key32);
  const shareUrl = buildShortLink({ origin: "https://share.example", type: "share", id: LINK_ID, key: key32, bodyCid: sealed.cid });
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

  it("accepts only the short share link: a full link, an upper-case id, a removed version and an over-long link are refused before any request", async () => {
    const { shareUrl, receipt } = await fixture();
    const signer = signerFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const key32 = generateKey();
    const sealed = await seal(new TextEncoder().encode(JSON.stringify({ signature: { signerDid: signer.did } })), key32);
    const { record } = await prepareLinkRecord({
      type: "share",
      sealed: { blob: sealed.blob, key: key32 },
      issuerKey: signer,
      apiOrigin: "https://api.tinycloud.xyz",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const fullLink = buildFullLink({ origin: "https://share.example", key: key32, record });
    const refused = [
      fullLink,
      shareUrl.replace(LINK_ID, LINK_ID.toUpperCase()),
      shareUrl.replace("#v=4", "#v=3"),
      shareUrl.replace("/s/", "/c/"),
      `${shareUrl}&x=${"a".repeat(512)}`,
    ];
    const noFetch = async () => {
      throw new Error("must not fetch");
    };
    for (const link of refused) {
      await expect(
        deliverCredentialInvitation({
          credentialsOrigin: "https://witness.credentials.org",
          receipt: { ...receipt, request: { ...receipt.request, returnLink: link } },
          shareUrl: link,
          fetchFn: noFetch,
        }),
      ).rejects.toMatchObject({ code: "invalid-receipt" } satisfies Partial<CredentialInvitationError>);
    }
  });
});
