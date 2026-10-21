import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { fromBase64Url, toBase64Url } from "../src/bytes.js";
import { computeCid } from "../src/cid.js";
import { encodeSealedInlineShareUrl, parseShortShareUrl, rebuildInlineFromShort, splitInlineToShort } from "../src/link.js";

interface Vector {
  readonly inline: string;
  readonly id: string;
  readonly ciphertextB64Url: string;
  readonly cid: string;
  readonly k: string;
  readonly short: string;
}

// The one vector file the Share web codec is tested against too (TC-1737).
const vectors = JSON.parse(readFileSync(new URL("./shortlink-vectors.json", import.meta.url), "utf8")) as Vector[];
const ORIGIN = "https://share.tinycloud.xyz";

describe("short share links", () => {
  it("matches the shared vectors in both directions", async () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      expect(await splitInlineToShort(vector.inline, vector.id)).toBe(vector.short);
      expect(await rebuildInlineFromShort(vector.short, vector.ciphertextB64Url)).toEqual({ v: 2, c: vector.ciphertextB64Url, cid: vector.cid, k: vector.k });
      // The rebuilt payload is exactly the inline link's payload.
      const inline = await encodeSealedInlineShareUrl({ origin: ORIGIN, ciphertext: fromBase64Url(vector.ciphertextB64Url), key32: fromBase64Url(vector.k) });
      expect(inline).toBe(vector.inline);
    }
  });

  it("refuses bytes that do not hash to the link's CID", async () => {
    const vector = vectors[0]!;
    const tampered = fromBase64Url(vector.ciphertextB64Url);
    tampered[0] = tampered[0]! ^ 1;
    await expect(rebuildInlineFromShort(vector.short, toBase64Url(tampered))).rejects.toThrow(TypeError);
    // Another share's bytes under this link are refused as well.
    if (vectors.length > 1) await expect(rebuildInlineFromShort(vector.short, vectors[1]!.ciphertextB64Url)).rejects.toThrow(TypeError);
  });

  it("refuses ids outside the 26-character lowercase base32 alphabet", async () => {
    const inline = vectors[0]!.inline;
    for (const id of ["", "abc", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxy1", "abcdefghijklmnopqrstuvwxyza"]) {
      await expect(splitInlineToShort(inline, id)).rejects.toThrow(TypeError);
    }
  });

  it("accepts only the canonical short form", () => {
    const { short, id, cid, k } = vectors[0]!;
    expect(parseShortShareUrl(short, { expectedOrigin: ORIGIN })).toMatchObject({ kind: "short", origin: ORIGIN, id, k, ciphertextCid: cid });
    const fragment = short.slice(short.indexOf("#"));
    for (const alias of [
      `${ORIGIN}/s/${id.toUpperCase()}${fragment}`,
      `${ORIGIN}/s/${id}/${fragment}`,
      `${ORIGIN}/s/${id}?x=1${fragment}`,
      `http://share.tinycloud.xyz/s/${id}${fragment}`,
      `https://user@share.tinycloud.xyz/s/${id}${fragment}`,
      `HTTPS://share.tinycloud.xyz/s/${id}${fragment}`,
      `${ORIGIN}/s/${id}#v=3&c=${cid}&k=${k}`,
      `${ORIGIN}/s/${id}#v=2&k=${k}&c=${cid}`,
      `${ORIGIN}/s/${id}#v=3&k=${k}&c=${cid}&x=1`,
      `${ORIGIN}/s/${id}#v=3&k=${k}=&c=${cid}`,
      `${ORIGIN}/s/${id}#v=3&k=${k}&c=${cid.toUpperCase()}`,
      `${ORIGIN}/s/${id}`,
    ]) {
      expect(() => parseShortShareUrl(alias)).toThrow(TypeError);
    }
    expect(() => parseShortShareUrl(short, { expectedOrigin: "https://evil.example" })).toThrow(TypeError);
  });

  it("refuses a non-canonical key encoding", async () => {
    const { short, k } = vectors[0]!;
    // The last base64url character of a 32-byte key carries 2 padding bits; setting them is a second spelling of the same key.
    const last = k.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alias = `${k.slice(0, -1)}${alphabet[(alphabet.indexOf(last) & ~3) + 1]}`;
    expect(() => parseShortShareUrl(short.replace(`k=${k}`, `k=${alias}`))).toThrow(TypeError);
  });

  it("keeps the key and bytes out of everything but the fragment", async () => {
    for (const vector of vectors) {
      const url = new URL(vector.short);
      expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(vector.k);
      expect(url.pathname).toBe(`/s/${vector.id}`);
      expect(vector.short).not.toContain(vector.ciphertextB64Url);
      expect(await computeCid(fromBase64Url(vector.ciphertextB64Url))).toBe(vector.cid);
    }
  });
});
