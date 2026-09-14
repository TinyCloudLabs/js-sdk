import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url, utf8Bytes } from "../src/bytes.js";
import { canonicalize } from "../src/jcs.js";
import { encodePublicInlineShareUrl, parseInlineShareUrl } from "../src/link.js";
import vector from "./vectors/addressed-link-canonicalization.json";

describe("TS/Rust addressed-link canonicalization vector", () => {
  it("rebuilds the exact public envelope, CID, payload, and URL", async () => {
    const envelopeBytes = utf8Bytes(canonicalize(vector.envelope));
    expect(new TextDecoder().decode(envelopeBytes)).toBe(vector.envelopeCanonical);
    expect(toBase64Url(envelopeBytes)).toBe(vector.envelopeBase64Url);

    const url = await encodePublicInlineShareUrl({
      origin: "https://share.tinycloud.xyz",
      plaintext: envelopeBytes,
    });
    expect(url).toBe(vector.shareUrl);
    expect(new URL(url).searchParams.get("tc2")).toBe(vector.payloadBase64Url);
    expect(new TextDecoder().decode(fromBase64Url(vector.payloadBase64Url))).toBe(vector.payloadCanonical);

    const parsed = parseInlineShareUrl(url, { expectedOrigin: "https://share.tinycloud.xyz" });
    expect(parsed.ciphertextCid).toBe(vector.shareCid);
    expect(parsed.ciphertext).toEqual(envelopeBytes);
    expect(parsed.key32).toBeUndefined();
  });
});
