import { describe, expect, it } from "vitest";

import { ENVELOPE_AAD_LABEL, SEALED_BLOB_VERSION, open } from "../src/aead.js";
import { fromBase64Url, utf8Bytes } from "../src/bytes.js";
import { computeCid, verifyCid } from "../src/cid.js";
import { canonicalize } from "../src/jcs.js";
import { encodeShareUrl, parseShareUrl } from "../src/link.js";
import { shareEnvelopeSchema } from "../src/schema.js";
import { ENVELOPE_SIGNATURE_DOMAIN, signEnvelope, verifyEnvelope } from "../src/sign.js";
import vector from "./vectors/end-to-end.json";

/**
 * Frozen golden vectors (see test/vectors/README.md). These are the
 * cross-implementation contract: every derived value below is recomputed
 * from the vector's INPUTS and must equal the frozen OUTPUT byte-for-byte.
 * If any assertion here starts failing, the wire format changed — that is a
 * breaking protocol change, not a test to update casually.
 */

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const unhex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));

describe("frozen end-to-end interop vectors", () => {
  const envelope = shareEnvelopeSchema.parse(vector.envelope);
  const { signature, ...unsigned } = envelope;
  const seed = unhex(vector.ed25519SeedHex);
  const key32 = unhex(vector.key32Hex);
  const nonce = unhex(vector.nonceHex);
  const blob = unhex(vector.sealedBlobHex);

  it("constants match", () => {
    expect(ENVELOPE_AAD_LABEL).toBe(vector.aadLabel);
    expect(SEALED_BLOB_VERSION).toBe(vector.sealedBlobVersion);
  });

  it("JCS signing bytes match", () => {
    expect(hex(utf8Bytes(`${ENVELOPE_SIGNATURE_DOMAIN}${canonicalize(unsigned)}`))).toBe(vector.signingJcsHex);
  });

  it("deterministic ed25519 signature matches (strict RFC 8032 signer)", () => {
    const resigned = signEnvelope(unsigned, seed);
    expect(resigned.signature.signerDid).toBe(vector.expectedSignerDid);
    expect(hex(fromBase64Url(resigned.signature.value))).toBe(vector.signatureHex);
    expect(resigned).toEqual(envelope);
  });

  it("sealed plaintext is the JCS of the signed envelope", () => {
    expect(hex(utf8Bytes(canonicalize(envelope)))).toBe(vector.plaintextJcsHex);
  });

  it("recomputed AES-256-GCM sealed blob matches", async () => {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      key32 as BufferSource,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce as BufferSource,
          additionalData: utf8Bytes(ENVELOPE_AAD_LABEL) as BufferSource,
        },
        aesKey,
        unhex(vector.plaintextJcsHex) as BufferSource,
      ),
    );
    const rebuilt = new Uint8Array(1 + nonce.length + ciphertext.length);
    rebuilt[0] = SEALED_BLOB_VERSION;
    rebuilt.set(nonce, 1);
    rebuilt.set(ciphertext, 1 + nonce.length);
    expect(hex(rebuilt)).toBe(vector.sealedBlobHex);
  });

  it("CID and URL match", async () => {
    expect(await computeCid(blob)).toBe(vector.cid);
    expect(await verifyCid(blob, vector.cid)).toBe(true);
    expect(
      encodeShareUrl({
        origin: "https://share.tinycloud.xyz",
        ciphertextCid: vector.cid,
        key32,
      }),
    ).toBe(vector.url);
  });

  it("the frozen URL + blob decrypt and verify end-to-end", async () => {
    const link = parseShareUrl(vector.url, {
      expectedOrigin: "https://share.tinycloud.xyz",
    });
    expect(link.ciphertextCid).toBe(vector.cid);
    expect(hex(link.key32)).toBe(vector.key32Hex);
    const recovered = await open(blob, link.key32);
    expect(hex(recovered)).toBe(vector.plaintextJcsHex);
    const parsed = shareEnvelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(recovered)),
    );
    expect(
      await verifyEnvelope(parsed, { expectedSignerDid: vector.expectedSignerDid }),
    ).toBe(true);
  });
});
