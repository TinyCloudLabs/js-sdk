import { describe, expect, it } from "vitest";

import { generateKey, open, seal } from "../src/aead.js";
import { utf8Bytes } from "../src/bytes.js";
import { verifyCid } from "../src/cid.js";
import { didKeyFromEd25519PublicKey } from "../src/didkey.js";
import { canonicalize } from "../src/jcs.js";
import { encodeShareUrl, parseShareUrl } from "../src/link.js";
import { shareEnvelopeSchema } from "../src/schema.js";
import { signEnvelope, verifyEnvelope } from "../src/sign.js";
import { TEST_PRIV_KEY, TEST_PUB_KEY, makeUnsignedEnvelope } from "./fixtures.js";

const ORIGIN = "https://share.tinycloud.xyz";

describe("end-to-end share flow (URL-recoverable material only)", () => {
  it("sender packages; recipient recovers everything from the URL + CID-fetched blob", async () => {
    // --- Sender side ---
    const signed = signEnvelope(makeUnsignedEnvelope(), TEST_PRIV_KEY);
    const plaintext = utf8Bytes(canonicalize(signed));
    const key32 = generateKey();
    const { blob, cid } = await seal(plaintext, key32);
    const url = encodeShareUrl({ origin: ORIGIN, ciphertextCid: cid, key32 });

    // --- Recipient side: has ONLY the URL, and fetches the blob by its CID ---
    const link = parseShareUrl(url, { expectedOrigin: ORIGIN });
    expect(link.ciphertextCid).toBe(cid);
    // Integrity: the fetched blob must hash to the link's CID (nonce included).
    expect(await verifyCid(blob, link.ciphertextCid)).toBe(true);
    // Decrypt with nothing but blob + fragment key — the nonce comes from the blob.
    const recovered = await open(blob, link.key32);
    const envelope = shareEnvelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(recovered)),
    );
    // Trust binding: the sender's DID is known out-of-band (later: delegation issuer).
    const expectedSignerDid = didKeyFromEd25519PublicKey(TEST_PUB_KEY);
    expect(await verifyEnvelope(envelope, { expectedSignerDid })).toBe(true);
    expect(envelope).toEqual(signed);
  });
});
