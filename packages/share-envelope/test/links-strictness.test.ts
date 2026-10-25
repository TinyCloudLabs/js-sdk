import { CID } from "multiformats/cid";
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url, utf8Bytes } from "../src/bytes.js";
import { computeCid, isCanonicalRawCid } from "../src/cid.js";
import { canonicalize } from "../src/jcs.js";
import {
  LinkError,
  buildFullLink,
  buildShortLink,
  deleteLink,
  openLinkRecord,
  parseLink,
  prepareLinkRecord,
  resolveLink,
  shortShareLinkCid,
  signDelete,
  signerFromSeed,
  validateLinkDeleteRequest,
  validateLinkHeader,
  verifyDelete,
  type LinkDeleteRequestV1,
  type LinkRecord,
} from "../src/links/index.js";

const API = "https://api.tinycloud.xyz";
const SHARE_ORIGIN = "https://share.tinycloud.xyz";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";
const signer = signerFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));

/** The same object with an own `__proto__` member in front, as `JSON.parse` of text that names it builds it. */
function withOwnProto(value: unknown): Record<string, unknown> {
  const parsed: Record<string, unknown> = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(value).slice(1)}`);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  return parsed;
}

async function prepared() {
  const plaintext = utf8Bytes(canonicalize({ pad: "x".repeat(200), signature: { signerDid: signer.did } }));
  return prepareLinkRecord({ type: "share", plaintext, issuerKey: signer, apiOrigin: API, expiresAt: new Date(NOW + 3600_000), now: NOW });
}

/** A fetch that serves `record` the way the read endpoint does, with `header` and `signature` as the stored record. */
function serving(record: LinkRecord, stored: { readonly header?: unknown; readonly signature?: unknown; readonly text?: string } = {}): typeof globalThis.fetch {
  const shown = { header: stored.header ?? record.header, ...("signature" in stored ? { signature: stored.signature } : { signature: record.signature }) };
  return (async () =>
    new Response(fromBase64Url(record.body), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "x-link-record": toBase64Url(utf8Bytes(stored.text ?? canonicalize(shown))) },
    })) as unknown as typeof globalThis.fetch;
}

const resolveOptions = (fetch: typeof globalThis.fetch) => ({ trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch, now: NOW }) as const;

describe("an own __proto__ key", () => {
  it("is refused in a header by validateLinkHeader", async () => {
    const { record } = await prepared();
    let failure: unknown;
    try {
      validateLinkHeader(withOwnProto(record.header), { mode: "signed" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LinkError);
    expect(failure).toMatchObject({ code: "header_fields" });
  });

  it("is refused in the stored header of a short link, though the signature covers the header without it", async () => {
    const { record, key, bodyCid } = await prepared();
    const link = buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: ID, key, bodyCid });
    await expect(resolveLink(link, resolveOptions(serving(record)))).resolves.toMatchObject({ id: ID });
    const failure: unknown = await resolveLink(link, resolveOptions(serving(record, { header: withOwnProto(record.header) }))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinkError);
    expect(failure).toMatchObject({ code: "header_fields" });
  });

  it("is refused in the stored signature of a short link", async () => {
    const { record, key, bodyCid } = await prepared();
    const link = buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: ID, key, bodyCid });
    const failure: unknown = await resolveLink(link, resolveOptions(serving(record, { signature: withOwnProto(record.signature) }))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinkError);
    expect(failure).toMatchObject({ code: "bad_signature" });
  });

  it("is refused in a record, its header and its signature by openLinkRecord", async () => {
    const { record, key } = await prepared();
    expect((await openLinkRecord(record, key, { now: NOW })).type).toBe("share");
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["the record", withOwnProto(record), "record_fields"],
      ["the header", { ...record, header: withOwnProto(record.header) }, "header_fields"],
      ["the signature", { ...record, signature: withOwnProto(record.signature) }, "bad_signature"],
    ];
    for (const [label, value, code] of cases) {
      const failure: unknown = await openLinkRecord(value, key, { now: NOW }).catch((error: unknown) => error);
      expect({ label, isLinkError: failure instanceof LinkError }).toEqual({ label, isLinkError: true });
      expect({ label, code: failure instanceof LinkError ? failure.code : undefined }).toEqual({ label, code });
    }
  });

  it("is refused in a full link's record", async () => {
    const { record, key } = await prepared();
    const text = canonicalize(withOwnProto(record));
    const link = `${SHARE_ORIGIN}/s/full#v=4&k=${toBase64Url(key)}&r=${toBase64Url(utf8Bytes(text))}`;
    const fromGood = buildFullLink({ origin: SHARE_ORIGIN, key, record });
    await expect(resolveLink(fromGood, resolveOptions(serving(record)))).resolves.toMatchObject({ form: "full" });
    const failure: unknown = await Promise.resolve()
      .then(() => resolveLink(link, resolveOptions(serving(record))))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinkError);
  });

  it("is refused in a delete request and in a delete signature", async () => {
    const request: LinkDeleteRequestV1 = { version: 1, op: "delete", id: ID, issuer: signer.did, audience: API, issuedAt: "2026-10-24T12:00:00.000Z", nonce: "CQkJCQkJCQkJCQkJCQkJCQ" };
    const signature = await signDelete(request, signer);
    expect(verifyDelete(request, signature)).toBe(true);
    let failure: unknown;
    try {
      validateLinkDeleteRequest(withOwnProto(request));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LinkError);
    expect(failure).toMatchObject({ code: "request_fields" });
    expect(verifyDelete(withOwnProto(request) as unknown as LinkDeleteRequestV1, signature)).toBe(false);
    expect(verifyDelete(request, withOwnProto(signature))).toBe(false);
  });
});

describe("a body CID", () => {
  const bodyCid = "bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u";
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const header = (cid: string) => ({
    version: 1, type: "share", issuer: signer.did, audience: API, issuedAt: "2026-10-24T12:00:00.000Z", expiresAt: "2026-10-25T12:00:00.000Z", size: 245, bodyCid: cid, nonce: "CQkJCQkJCQkJCQkJCQkJCQ",
  });
  const accepted = (check: (cid: string) => unknown): string[] =>
    [...alphabet].filter((last) => {
      try {
        check(`${bodyCid.slice(0, -1)}${last}`);
        return true;
      } catch {
        return false;
      }
    });

  it("is accepted in every path only in its one canonical spelling, whatever its last character", () => {
    const paths: readonly (readonly [string, (cid: string) => unknown])[] = [
      ["a header", (cid) => validateLinkHeader(header(cid), { mode: "signed" })],
      ["a short link", (cid) => parseLink(`${SHARE_ORIGIN}/s/${ID}#v=4&k=${toBase64Url(new Uint8Array(32))}&c=${cid}`, { trustedOrigins: [SHARE_ORIGIN] })],
      ["buildShortLink", (cid) => buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: ID, key: new Uint8Array(32), bodyCid: cid })],
      ["shortShareLinkCid", (cid) => {
        if (shortShareLinkCid(`${SHARE_ORIGIN}/s/${ID}#v=4&k=${toBase64Url(new Uint8Array(32))}&c=${cid}`, { trustedOrigins: [SHARE_ORIGIN] }) === undefined) throw new Error("refused");
      }],
    ];
    for (const [label, check] of paths) {
      const passing = accepted(check);
      // A CID's last base32 character carries 3 bits of the digest and 2 padding bits: the 8 characters whose padding
      // is zero are the canonical CIDs of 8 different digests, and every other character is refused.
      expect({ label, passing }).toEqual({ label, passing: ["a", "e", "i", "m", "q", "u", "y", "4"] });
      for (const last of passing) {
        const cid = `${bodyCid.slice(0, -1)}${last}`;
        expect(CID.parse(cid).toString()).toBe(cid);
        if (last !== bodyCid.slice(-1)) expect(CID.parse(cid).multihash.digest).not.toEqual(CID.parse(bodyCid).multihash.digest);
      }
    }
  });
});

describe("a timestamp that is not a real UTC time", () => {
  const request = { version: 1, op: "delete", id: ID, issuer: signer.did, audience: API, issuedAt: "2026-10-24T12:00:00.000Z", nonce: "CQkJCQkJCQkJCQkJCQkJCQ" };
  const header = { version: 1, type: "share", issuer: signer.did, audience: API, issuedAt: "2026-10-24T12:00:00.000Z", expiresAt: "2026-10-25T12:00:00.000Z", size: 245, bodyCid: "bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u", nonce: "CQkJCQkJCQkJCQkJCQkJCQ" };
  const spellings = ["2026-13-01T00:00:00.000Z", "2026-10-32T00:00:00.000Z", "2026-10-24T24:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-10-24T12:60:00.000Z", "2026-10-24T12:00:60.000Z"];

  it("is refused as timestamp_format in a header and in a delete request, never thrown as another error", () => {
    for (const text of spellings) {
      for (const field of ["issuedAt", "expiresAt"] as const) {
        let failure: unknown;
        try {
          validateLinkHeader({ ...header, [field]: text }, { mode: "signed" });
        } catch (error) {
          failure = error;
        }
        expect({ text, field, code: failure instanceof LinkError ? failure.code : String(failure) }).toEqual({ text, field, code: "timestamp_format" });
      }
      let failure: unknown;
      try {
        validateLinkDeleteRequest({ ...request, issuedAt: text });
      } catch (error) {
        failure = error;
      }
      expect({ text, code: failure instanceof LinkError ? failure.code : String(failure) }).toEqual({ text, code: "timestamp_format" });
    }
  });

  it("is refused as a LinkError when it is a caller's date or clock", async () => {
    const invalid = [new Date("2026-13-01T00:00:00.000Z"), new Date("2026-10-32T00:00:00.000Z"), Number.NaN, 8.64e15 + 1];
    const down = (async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    for (const now of invalid) {
      const failure: unknown = await deleteLink({ id: ID, issuerKey: signer, apiOrigin: API, now, fetch: down }).catch((error: unknown) => error);
      expect({ now: String(now), isLinkError: failure instanceof LinkError }).toEqual({ now: String(now), isLinkError: true });
      const { record, key } = await prepared();
      const opened: unknown = await openLinkRecord(record, key, { now }).catch((error: unknown) => error);
      expect({ now: String(now), isLinkError: opened instanceof LinkError }).toEqual({ now: String(now), isLinkError: true });
      const plaintext = utf8Bytes(canonicalize({ pad: "x".repeat(200), signature: { signerDid: signer.did } }));
      const made: unknown = await prepareLinkRecord({ type: "share", plaintext, issuerKey: signer, apiOrigin: API, expiresAt: new Date(NOW + 3600_000), now }).catch((error: unknown) => error);
      expect({ now: String(now), isLinkError: made instanceof LinkError }).toEqual({ now: String(now), isLinkError: true });
    }
  });
});

describe("isCanonicalRawCid", () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

  it("accepts a CID only in the string that is its own canonical encoding", async () => {
    const cid = await computeCid(utf8Bytes("x"));
    expect(isCanonicalRawCid(cid)).toBe(true);
    // Padding characters, white space and another case are not part of the canonical string.
    for (const spelling of [`${cid}=`, `${cid}==`, `${cid} `, ` ${cid}`, cid.toUpperCase(), `B${cid.slice(1)}`]) {
      expect({ spelling: spelling.slice(-6), canonical: isCanonicalRawCid(spelling) }).toEqual({ spelling: spelling.slice(-6), canonical: false });
    }
  });

  it("refuses a spelling whose padding bits are set and accepts the other last characters only as CIDs of other digests", async () => {
    const cid = await computeCid(utf8Bytes("x"));
    const digest = CID.parse(cid).multihash.digest;
    const accepted = [...alphabet].map((last) => `${cid.slice(0, -1)}${last}`).filter(isCanonicalRawCid);
    // The last base32 character holds 3 digest bits and 2 padding bits: 8 characters have clear padding, and each is the
    // canonical CID of a different digest; the 24 others set a padding bit and are refused.
    expect(accepted).toHaveLength(8);
    for (const spelling of accepted) {
      expect(CID.parse(spelling).toString()).toBe(spelling);
      expect(spelling === cid || !Buffer.from(CID.parse(spelling).multihash.digest).equals(Buffer.from(digest))).toBe(true);
    }
  });

  it("is the check buildShortLink makes of a body CID", async () => {
    const cid = await computeCid(utf8Bytes("x"));
    const build = (bodyCid: string) => buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: ID, key: new Uint8Array(32), bodyCid });
    expect(build(cid)).toContain(`&c=${cid}`);
    for (const spelling of [`${cid}=`, `${cid}==`]) {
      let failure: unknown;
      try {
        build(spelling);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "body_cid_format" });
    }
  });
});

describe("the X-Link-Record text of a short link", () => {
  async function resolving(text: (record: LinkRecord) => string): Promise<unknown> {
    const { record, key, bodyCid } = await prepared();
    const link = buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: ID, key, bodyCid });
    return resolveLink(link, resolveOptions(serving(record, { text: text(record) }))).catch((error: unknown) => error);
  }
  const stored = (record: LinkRecord) => ({ header: record.header, signature: record.signature });

  it("is accepted when it is exactly the JCS text of its parsed value", async () => {
    expect(await resolving((record) => canonicalize(stored(record)))).toMatchObject({ id: ID, form: "short" });
  });

  it("is refused when a header key is repeated, though the last value is the right one", async () => {
    let parsedAudience: unknown;
    const outcome = await resolving((record) => {
      const text = canonicalize(stored(record)).replace(`{"header":{"audience":"${API}"`, `{"header":{"audience":"https://other.example","audience":"${API}"`);
      expect(text).toContain("https://other.example");
      const parsed: { header: { audience: unknown } } = JSON.parse(text);
      parsedAudience = parsed.header.audience;
      return text;
    });
    expect(parsedAudience).toBe(API);
    expect(outcome).toBeInstanceOf(LinkError);
    expect(outcome).toMatchObject({ code: "record_not_canonical" });
  });

  it("is refused with white space, another key order, or an escaped lone surrogate", async () => {
    const spellings: readonly (readonly [string, (record: LinkRecord) => string])[] = [
      ["white space", (record) => JSON.stringify(stored(record), null, 1)],
      ["another key order", (record) => JSON.stringify({ signature: record.signature, header: record.header })],
      ["a lone surrogate", (record) => canonicalize(stored(record)).replace(`"audience":"${API}"`, `"audience":"${API}\\ud800"`)],
    ];
    for (const [label, text] of spellings) {
      const outcome = await resolving(text);
      expect({ label, isLinkError: outcome instanceof LinkError }).toEqual({ label, isLinkError: true });
      expect({ label, code: outcome instanceof LinkError ? outcome.code : undefined }).toEqual({ label, code: "record_not_canonical" });
    }
  });

  it("is refused when its object has a key besides header and signature, though the text is JCS", async () => {
    const outcome = await resolving((record) => {
      const text = canonicalize({ extra: 1, ...stored(record) });
      expect(text.startsWith('{"extra":1,"header":')).toBe(true);
      return text;
    });
    expect(outcome).toBeInstanceOf(LinkError);
    expect(outcome).toMatchObject({ code: "invalid_response" });
  });
});
