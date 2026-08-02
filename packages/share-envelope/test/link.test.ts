import { describe, expect, it } from "vitest";

import { generateKey } from "../src/aead.js";
import { computeCid } from "../src/cid.js";
import { encodeInlineShareUrl, encodeShareUrl, parseCompactOrInlineShareUrl, parseShareUrl } from "../src/link.js";
import { utf8Bytes } from "../src/bytes.js";

const ORIGIN = "https://share.tinycloud.xyz";

describe("share link codec", () => {
  it("round-trips encode → parse", async () => {
    const key32 = generateKey();
    const ciphertextCid = await computeCid(utf8Bytes("ciphertext bytes"));
    const url = encodeShareUrl({ origin: ORIGIN, ciphertextCid, key32 });
    expect(url).toBe(`${ORIGIN}/s/${ciphertextCid}#k=`.concat(url.split("#k=")[1]!));
    expect(url.startsWith(`${ORIGIN}/s/bafkr`)).toBe(true);
    const parsed = parseShareUrl(url);
    expect(parsed.ciphertextCid).toBe(ciphertextCid);
    expect(parsed.key32).toEqual(key32);
  });

  it("keeps the key only in the fragment (never sent to servers)", async () => {
    const key32 = generateKey();
    const ciphertextCid = await computeCid(utf8Bytes("x"));
    const url = new URL(encodeShareUrl({ origin: ORIGIN, ciphertextCid, key32 }));
    expect(url.pathname).toBe(`/s/${ciphertextCid}`);
    expect(url.search).toBe("");
    expect(url.hash.startsWith("#k=")).toBe(true);
  });

  it("rejects malformed URLs", async () => {
    const key32 = generateKey();
    const cid = await computeCid(utf8Bytes("x"));
    const good = encodeShareUrl({ origin: ORIGIN, ciphertextCid: cid, key32 });
    expect(() => parseShareUrl(`${ORIGIN}/share/${cid}#k=abc`)).toThrow(TypeError);
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}`)).toThrow(TypeError); // no fragment
    expect(() => parseShareUrl(`${ORIGIN}/s/not-a-cid#k=${good.split("#k=")[1]!}`)).toThrow();
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}#k=dG9vc2hvcnQ`)).toThrow(TypeError); // short key
  });

  it("rejects non-CIDv1-raw and non-canonical CIDs on encode", () => {
    const key32 = generateKey();
    expect(() =>
      encodeShareUrl({
        origin: ORIGIN,
        ciphertextCid: "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn",
        key32,
      }),
    ).toThrow(TypeError);
  });

  it("rejects origins that are not canonical https origins", async () => {
    const key32 = generateKey();
    const cid = await computeCid(utf8Bytes("x"));
    for (const origin of [
      `${ORIGIN}/app`,
      `${ORIGIN}/`,
      "http://share.tinycloud.xyz",
      "https://share.tinycloud.xyz:443",
      "javascript:alert(1)",
    ]) {
      expect(() => encodeShareUrl({ origin, ciphertextCid: cid, key32 })).toThrow(TypeError);
    }
  });

  it("rejects any non-empty query string (no key material toward servers)", async () => {
    const key32 = generateKey();
    const cid = await computeCid(utf8Bytes("x"));
    const keyPart = encodeShareUrl({ origin: ORIGIN, ciphertextCid: cid, key32 }).split("#k=")[1]!;
    // ?k= duplicate of the fragment key — the classic downgrade.
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}?k=${keyPart}#k=${keyPart}`)).toThrow(TypeError);
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}?foo=1#k=${keyPart}`)).toThrow(TypeError);
  });

  it("rejects non-https schemes and userinfo", async () => {
    const key32 = generateKey();
    const cid = await computeCid(utf8Bytes("x"));
    const keyPart = encodeShareUrl({ origin: ORIGIN, ciphertextCid: cid, key32 }).split("#k=")[1]!;
    expect(() => parseShareUrl(`http://share.tinycloud.xyz/s/${cid}#k=${keyPart}`)).toThrow(
      TypeError,
    );
    expect(() => parseShareUrl(`https://user:pw@share.tinycloud.xyz/s/${cid}#k=${keyPart}`)).toThrow(
      TypeError,
    );
  });

  it("enforces expectedOrigin when given", async () => {
    const key32 = generateKey();
    const cid = await computeCid(utf8Bytes("x"));
    const url = encodeShareUrl({ origin: ORIGIN, ciphertextCid: cid, key32 });
    expect(parseShareUrl(url, { expectedOrigin: ORIGIN }).ciphertextCid).toBe(cid);
    expect(() => parseShareUrl(url, { expectedOrigin: "https://evil.example.com" })).toThrow(
      TypeError,
    );
    // A non-canonical expectedOrigin is a caller bug — reject loudly.
    expect(() => parseShareUrl(url, { expectedOrigin: `${ORIGIN}/` })).toThrow(TypeError);
  });

  it("requires strict base64url for the fragment key, not just the alphabet", async () => {
    const cid = await computeCid(utf8Bytes("x"));
    const zeroKey43 = "A".repeat(43); // canonical encoding of 32 zero bytes
    expect(parseShareUrl(`${ORIGIN}/s/${cid}#k=${zeroKey43}`).key32).toEqual(new Uint8Array(32));
    // Padded form of the same key.
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}#k=${zeroKey43}=`)).toThrow();
    // Non-canonical: same length, non-zero trailing bits in the last char.
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}#k=${"A".repeat(42)}B`)).toThrow();
    // Impossible base64url length.
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}#k=${"A".repeat(44)}`)).toThrow();
  });

  it("rejects percent-encoded separator smuggling in the path", async () => {
    const key32 = generateKey();
    const cid = await computeCid(utf8Bytes("x"));
    const keyPart = encodeShareUrl({ origin: ORIGIN, ciphertextCid: cid, key32 }).split("#k=")[1]!;
    expect(() => parseShareUrl(`${ORIGIN}/s%2F${cid}#k=${keyPart}`)).toThrow(TypeError);
    expect(() => parseShareUrl(`${ORIGIN}/s/${cid}%3Fq%3D1#k=${keyPart}`)).toThrow(TypeError);
  });

  it("rejects a raw CID built on sha2-512 at the link layer (multihash must be sha2-256)", async () => {
    const { CID } = await import("multiformats/cid");
    const raw = await import("multiformats/codecs/raw");
    const { sha512 } = await import("multiformats/hashes/sha2");
    const key32 = generateKey();
    const sha512Cid = CID.create(1, raw.code, await sha512.digest(utf8Bytes("x"))).toString();
    expect(() =>
      encodeShareUrl({ origin: ORIGIN, ciphertextCid: sha512Cid, key32 }),
    ).toThrow(TypeError);
    const goodKeyPart = encodeShareUrl({
      origin: ORIGIN,
      ciphertextCid: await computeCid(utf8Bytes("x")),
      key32,
    }).split("#k=")[1]!;
    expect(() => parseShareUrl(`${ORIGIN}/s/${sha512Cid}#k=${goodKeyPart}`)).toThrow(TypeError);
  });

  it("round-trips the explicit v2 inline fragment without a query string", async () => {
    const key32 = generateKey();
    const ciphertext = utf8Bytes("sealed envelope bytes");
    const url = await encodeInlineShareUrl({ origin: ORIGIN, ciphertext, key32 });
    const parsed = parseCompactOrInlineShareUrl(url);
    expect(parsed.kind).toBe("inline");
    if (parsed.kind !== "inline") throw new Error("expected inline");
    expect(parsed.ciphertext).toEqual(ciphertext);
    expect(parsed.key32).toEqual(key32);
    expect(new URL(url).search).toBe("");
  });

  it("rejects inline payload tampering and untrusted origins", async () => {
    const url = await encodeInlineShareUrl({ origin: ORIGIN, ciphertext: utf8Bytes("x"), key32: generateKey() });
    expect(() => parseCompactOrInlineShareUrl(url.replace("share.tinycloud.xyz", "evil.example"), { expectedOrigin: ORIGIN })).toThrow(TypeError);
    expect(() => parseCompactOrInlineShareUrl(url.replace(/p=./, "p=!"))).toThrow(TypeError);
  });
});
