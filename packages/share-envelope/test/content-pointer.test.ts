/**
 * Stage-4 `content` pointer: schema strictness + SIGNATURE COVERAGE. The
 * pointer references the sealed content blob (cid) and carries its AEAD key;
 * both must be covered by the sender signature so a tampered pointer can
 * never survive to a fetch.
 */
import { describe, expect, it } from "vitest";

import { computeCid } from "../src/cid.js";
import { generateKey, seal } from "../src/aead.js";
import {
  contentPointerSchema,
  shareEnvelopeSchema,
  unsignedShareEnvelopeSchema,
  type ShareEnvelope,
} from "../src/schema.js";
import { signEnvelope, verifyEnvelope } from "../src/sign.js";
import { toBase64Url } from "../src/bytes.js";
import { BEARER_TARGET, TEST_PRIV_KEY, makeUnsignedEnvelope } from "./fixtures.js";

/** A real sealed blob so the pointer's CID is canonical by construction. */
async function makeContentPointer(): Promise<{ cid: string; key: string }> {
  const key = generateKey();
  const sealed = await seal(Uint8Array.of(35, 32, 104, 105), key); // "# hi"
  return { cid: sealed.cid, key: toBase64Url(key) };
}

describe("contentPointerSchema", () => {
  it("accepts a canonical raw CID + 32-byte base64url key", async () => {
    const pointer = await makeContentPointer();
    expect(contentPointerSchema.parse(pointer)).toEqual(pointer);
  });

  it("rejects a non-canonical or non-raw CID", async () => {
    const { key } = await makeContentPointer();
    for (const cid of [
      "not-a-cid",
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", // CIDv0
      "BAFKREIG36S2HZ442YQCNKCTPKGTJEV5PYJNGZYMYIPK3KOYWG4D7RQMU5U", // uppercase
      "",
    ]) {
      expect(contentPointerSchema.safeParse({ cid, key }).success).toBe(false);
    }
  });

  it("rejects keys that are not exactly 32 base64url bytes", async () => {
    const { cid } = await makeContentPointer();
    for (const key of [
      "",
      "short",
      toBase64Url(new Uint8Array(31)),
      toBase64Url(new Uint8Array(33)),
      `${toBase64Url(new Uint8Array(32))}=`, // padded / non-canonical
    ]) {
      expect(contentPointerSchema.safeParse({ cid, key }).success).toBe(false);
    }
  });

  it("rejects unknown fields (strict)", async () => {
    const pointer = await makeContentPointer();
    expect(
      contentPointerSchema.safeParse({ ...pointer, url: "https://evil.example" })
        .success,
    ).toBe(false);
  });

  it("envelope schema: content is optional but must validate when present", async () => {
    const withoutContent = makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET });
    expect(unsignedShareEnvelopeSchema.parse(withoutContent).content).toBeUndefined();
    const pointer = await makeContentPointer();
    const withContent = makeUnsignedEnvelope({
      authorizationTarget: BEARER_TARGET,
      content: pointer,
    });
    expect(unsignedShareEnvelopeSchema.parse(withContent).content).toEqual(pointer);
    expect(
      unsignedShareEnvelopeSchema.safeParse(
        makeUnsignedEnvelope({
          authorizationTarget: BEARER_TARGET,
          content: { cid: "junk", key: pointer.key },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("signature coverage of the content pointer", () => {
  async function signedWithContent(): Promise<ShareEnvelope> {
    return signEnvelope(
      makeUnsignedEnvelope({
        authorizationTarget: BEARER_TARGET,
        content: await makeContentPointer(),
      }),
      TEST_PRIV_KEY,
    );
  }

  function expectVerifies(envelope: ShareEnvelope): Promise<boolean> {
    return verifyEnvelope(envelope, {
      expectedSignerDid: envelope.signature.signerDid,
    });
  }

  it("an envelope signed WITH a content pointer verifies", async () => {
    const envelope = await signedWithContent();
    expect(shareEnvelopeSchema.parse(envelope).content).toBeDefined();
    await expect(expectVerifies(envelope)).resolves.toBe(true);
  });

  it("tampering with content.cid after signing breaks the signature", async () => {
    const envelope = await signedWithContent();
    const otherCid = await computeCid(Uint8Array.of(1, 2, 3));
    const tampered: ShareEnvelope = {
      ...envelope,
      content: { ...envelope.content!, cid: otherCid },
    };
    await expect(expectVerifies(tampered)).resolves.toBe(false);
  });

  it("tampering with content.key after signing breaks the signature", async () => {
    const envelope = await signedWithContent();
    const tampered: ShareEnvelope = {
      ...envelope,
      content: { ...envelope.content!, key: toBase64Url(generateKey()) },
    };
    await expect(expectVerifies(tampered)).resolves.toBe(false);
  });

  it("adding a content pointer to an envelope signed without one breaks the signature", async () => {
    const envelope = signEnvelope(
      makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET }),
      TEST_PRIV_KEY,
    );
    const tampered: ShareEnvelope = { ...envelope, content: await makeContentPointer() };
    await expect(expectVerifies(tampered)).resolves.toBe(false);
  });

  it("removing the signed content pointer breaks the signature", async () => {
    const envelope = await signedWithContent();
    const { content: _dropped, ...rest } = envelope;
    await expect(expectVerifies(rest as ShareEnvelope)).resolves.toBe(false);
  });

  it("signing bytes are identical for absent and explicitly-undefined content", () => {
    const absent = signEnvelope(
      makeUnsignedEnvelope({ authorizationTarget: BEARER_TARGET }),
      TEST_PRIV_KEY,
    );
    const explicit = signEnvelope(
      makeUnsignedEnvelope({
        authorizationTarget: BEARER_TARGET,
        content: undefined,
      }),
      TEST_PRIV_KEY,
    );
    expect(explicit.signature.value).toBe(absent.signature.value);
  });
});
