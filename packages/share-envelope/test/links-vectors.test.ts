import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url, utf8Bytes } from "../src/bytes.js";
import { computeCid } from "../src/cid.js";
import { canonicalize } from "../src/jcs.js";
import {
  LINK_DELETE_DOMAIN,
  LINK_HEADER_DOMAIN,
  LINK_WINDOW_SECONDS,
  LinkError,
  checkLinkBody,
  checkLinkRecord,
  checkLinkHeaderLife,
  normalizeLinkId,
  openLinkRecord,
  parseLink,
  resolveLink,
  signDelete,
  signHeader,
  signerFromSeed,
  linkSigningBytes,
  linkSigningDigest,
  validateLinkDeleteRequest,
  validateLinkHeader,
  verifyDelete,
  verifyEd25519Strict,
  verifyHeader,
  type LinkDeleteRequestV1,
  type LinkHeaderV1,
  type LinkType,
} from "../src/links/index.js";
import { buildShortLink } from "../src/links/index.js";

const VECTOR_PATH = new URL("./links-api-vectors.json", import.meta.url);

type Outcome = { readonly status: number; readonly error?: string; readonly reason?: string; readonly type?: string };

interface Synthesized {
  readonly length: number;
  readonly fillByte: number;
}

/** A body of `length` bytes of `fillByte` whose first byte is the sealed-blob version byte. */
function synthesizedBody(descriptor: Synthesized): Uint8Array {
  const body = new Uint8Array(descriptor.length).fill(descriptor.fillByte);
  body[0] = 1;
  return body;
}

interface RecordShape {
  readonly header: LinkHeaderV1;
  readonly signature?: { readonly algorithm: string; readonly value: string };
  readonly body: string;
}

interface Vectors {
  readonly meta: { readonly now: string; readonly audience: string; readonly trustedOrigins: readonly string[] };
  readonly constants: {
    readonly domains: { readonly header: string; readonly delete: string };
    readonly windowSeconds: number;
    readonly minLifeSeconds: number;
    readonly minBodyBytes: number;
    readonly maxLinkBodyBytes: number;
    readonly types: Readonly<Record<LinkType, { readonly maxLifeS: number; readonly defaultLifeS: number; readonly path: string; readonly readOnce: boolean }>>;
  };
  readonly identities: readonly { readonly name: string; readonly seedHex?: string; readonly did: string }[];
  readonly ids: readonly { readonly name: string; readonly id: string; readonly expect: { readonly valid: boolean; readonly normalized?: string } }[];
  readonly bodyHash: readonly { readonly name: string; readonly bodyB64u: string; readonly expect: { readonly size: number; readonly cid: string } }[];
  readonly signatures: readonly {
    readonly name: string;
    readonly object: LinkHeaderV1 | LinkDeleteRequestV1;
    readonly jcs: string;
    readonly domain: string;
    readonly preimageHex: string;
    readonly digestHex: string;
    readonly signature: unknown;
    readonly expect: { readonly valid: boolean };
  }[];
  readonly ed25519Strict: readonly { readonly name: string; readonly publicKeyHex: string; readonly messageHex: string; readonly signatureHex: string; readonly expect: { readonly valid: boolean } }[];
  readonly headers: readonly { readonly name: string; readonly mode: "signed" | "service"; readonly header: unknown; readonly expect: Outcome }[];
  readonly create: readonly {
    readonly name: string;
    readonly authorization?: string;
    readonly state: { readonly origin?: string };
    readonly request: { readonly header: unknown; readonly signature?: unknown; readonly body?: string };
    readonly bodySynthesized?: Synthesized;
    readonly expect: Outcome;
  }[];
  readonly delete: readonly { readonly name: string; readonly urlId: string; readonly authorization?: string; readonly request: { readonly request: unknown; readonly signature?: unknown }; readonly expect: Outcome }[];
  readonly records: readonly { readonly name: string; readonly now: string; readonly contentKeyB64u: string | null; readonly record: Record<string, unknown>; readonly bodySynthesized?: Synthesized; readonly expect: Outcome }[];
  readonly resolve: readonly { readonly name: string; readonly now: string; readonly link: string; readonly serverRecord: RecordShape | null; readonly expect: Outcome }[];
  readonly links: readonly { readonly name: string; readonly href: string; readonly expect: Record<string, unknown> }[];
  readonly read: readonly { readonly type: LinkType; readonly sequence: readonly string[]; readonly expect: readonly number[] }[];
}

const vectors = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as Vectors;
const NOW = Date.parse(vectors.meta.now);

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function bytesHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Run `action`; return its outcome in the vector's shape (`reason` is the LinkError code). */
async function outcomeOf(action: () => Promise<{ readonly type?: string } | void> | { readonly type?: string } | void): Promise<Outcome> {
  try {
    const result = await action();
    return { status: 200, ...(result !== undefined && result.type !== undefined ? { type: result.type } : {}) };
  } catch (error) {
    if (error instanceof LinkError) return { status: -1, reason: error.code };
    throw error;
  }
}

/** The reason an `expect` names, or `undefined` for a success. */
function reasonOf(expected: Outcome): string | undefined {
  return expected.reason;
}


describe("vectors: ids", () => {
  for (const vector of vectors.ids) {
    it(vector.name, () => {
      expect(normalizeLinkId(vector.id)).toBe(vector.expect.valid ? (vector.expect.normalized ?? null) : null);
    });
  }
});

describe("vectors: bodyHash", () => {
  for (const vector of vectors.bodyHash) {
    it(vector.name, async () => {
      const body = fromBase64Url(vector.bodyB64u);
      expect(body.length).toBe(vector.expect.size);
      expect(await computeCid(body)).toBe(vector.expect.cid);
    });
  }
});

describe("vectors: signatures", () => {
  const issuerA = vectors.identities.find((identity) => identity.name === "issuerA");

  for (const vector of vectors.signatures) {
    it(vector.name, () => {
      const isDelete = "op" in vector.object;
      const domain = isDelete ? LINK_DELETE_DOMAIN : LINK_HEADER_DOMAIN;
      expect(canonicalize(vector.object)).toBe(vector.jcs);
      expect(bytesHex(linkSigningBytes(domain, vector.object))).toBe(vector.preimageHex);
      expect(bytesHex(linkSigningDigest(domain, vector.object))).toBe(vector.digestHex);
      const verified = "op" in vector.object ? verifyDelete(vector.object, vector.signature) : verifyHeader(vector.object, vector.signature);
      expect(verified).toBe(vector.expect.valid);
    });
  }

  it("signHeader and signDelete reproduce the vectors' valid signatures", async () => {
    const signer = signerFromSeed(hexBytes(issuerA?.seedHex ?? ""));
    expect(signer.did).toBe(issuerA?.did);
    const header = vectors.signatures[0];
    const request = vectors.signatures.find((vector) => "op" in vector.object);
    if (header === undefined || request === undefined) throw new Error("vector file lacks the valid signature rows");
    expect(await signHeader(header.object as LinkHeaderV1, signer)).toEqual(header.signature);
    expect(await signDelete(request.object as LinkDeleteRequestV1, signer)).toEqual(request.signature);
  });
});

describe("vectors: ed25519Strict", () => {
  for (const vector of vectors.ed25519Strict) {
    it(vector.name, () => {
      expect(verifyEd25519Strict(hexBytes(vector.publicKeyHex), hexBytes(vector.messageHex), hexBytes(vector.signatureHex))).toBe(vector.expect.valid);
    });
  }
});

describe("vectors: headers", () => {
  for (const vector of vectors.headers) {
    it(vector.name, async () => {
      const outcome = await outcomeOf(() => {
        const header = validateLinkHeader(vector.header, { mode: vector.mode, audience: vectors.meta.audience });
        checkLinkHeaderLife(header, NOW);
      });
      expect(reasonOf(outcome)).toBe(reasonOf(vector.expect));
    });
  }
});

/** Header-level reasons the service and the module decide the same way, from the request alone. */
const CLIENT_CHECKED_CREATE_REASONS: Record<string, true> = {
  header_fields: true,
  header_shape: true,
  header_version: true,
  unknown_type: true,
  issuer_method_not_allowed: true,
  issuer_format: true,
  issuer_key_type: true,
  issuer_key_noncanonical: true,
  issuer_key_invalid: true,
  issuer_weak_key: true,
  audience_format: true,
  audience_mismatch: true,
  timestamp_format: true,
  nonce_format: true,
  size_format: true,
  body_cid_format: true,
  body_encoding: true,
  size_mismatch: true,
  body_over_cap: true,
  body_too_small: true,
  body_hash_mismatch: true,
  issued_at_window: true,
  expires_before_issued: true,
  life_too_short: true,
  life_too_long: true,
  already_expired: true,
  bad_signature: true,
};

describe("vectors: create (the checks a client makes before it sends)", () => {
  const applicable = vectors.create.filter(
    (vector) => vector.authorization === undefined && vector.state.origin === undefined && (vector.expect.status === 201 ? "signature" in vector.request : CLIENT_CHECKED_CREATE_REASONS[vector.expect.reason ?? ""] === true),
  );

  it("covers the create vectors whose outcome the request alone decides", () => {
    expect(applicable.length).toBe(38);
  });

  for (const vector of applicable) {
    it(vector.name, async () => {
      const outcome = await outcomeOf(async () => {
        const header = validateLinkHeader(vector.request.header, { mode: "signed", audience: vectors.meta.audience });
        const synthesized = vector.bodySynthesized;
        let body: Uint8Array | null;
        if (synthesized !== undefined) {
          body = synthesizedBody(synthesized);
        } else {
          try {
            body = fromBase64Url(vector.request.body ?? "");
          } catch {
            throw new LinkError("body_encoding");
          }
        }
        checkLinkBody(header, body, await computeCid(body));
        checkLinkHeaderLife(header, NOW);
        if (!verifyHeader(header, vector.request.signature)) throw new LinkError("bad_signature");
      });
      expect(reasonOf(outcome)).toBe(reasonOf(vector.expect));
    });
  }
});

describe("vectors: delete (the checks a client makes before it sends)", () => {
  const applicable = vectors.delete.filter((vector) => vector.authorization === undefined && "signature" in vector.request && [undefined, "issuer_weak_key", "audience_mismatch", "bad_signature", "request_fields", "request_version", "issued_at_window"].includes(vector.expect.reason));

  it("covers the delete vectors whose outcome the request alone decides", () => {
    expect(applicable.length).toBe(12);
  });

  for (const vector of applicable) {
    it(vector.name, async () => {
      const outcome = await outcomeOf(() => {
        const request = validateLinkDeleteRequest(vector.request.request, { audience: vectors.meta.audience });
        if (Math.abs(Date.parse(request.issuedAt) - NOW) > LINK_WINDOW_SECONDS * 1000) throw new LinkError("issued_at_window");
        if (!verifyDelete(request, vector.request.signature)) throw new LinkError("bad_signature");
      });
      expect(reasonOf(outcome)).toBe(reasonOf(vector.expect));
    });
  }
});

describe("vectors: records", () => {
  for (const vector of vectors.records) {
    it(vector.name, async () => {
      const nowMs = Date.parse(vector.now);
      const synthesized = vector.bodySynthesized;
      const record = synthesized === undefined ? vector.record : { ...vector.record, body: toBase64Url(synthesizedBody(synthesized)) };
      // A vector without a content key stops before the body is opened.
      const outcome = await outcomeOf(async () => {
        if (vector.contentKeyB64u === null) await checkLinkRecord(record, nowMs);
        else await openLinkRecord(record, fromBase64Url(vector.contentKeyB64u), { now: nowMs });
      });
      expect(reasonOf(outcome)).toBe(reasonOf(vector.expect));
      if (vector.expect.status === 200) expect(outcome.status).toBe(200);
    });
  }
});

function serviceReturning(record: RecordShape | null, calls: { method: string; url: string }[] = []): typeof globalThis.fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    if (record === null) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    const { body, ...stored } = record;
    return new Response(fromBase64Url(body), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "x-link-record": toBase64Url(utf8Bytes(canonicalize(stored))) },
    });
  }) as typeof globalThis.fetch;
}

describe("vectors: resolve", () => {
  for (const vector of vectors.resolve) {
    it(vector.name, async () => {
      const calls: { method: string; url: string }[] = [];
      const outcome = await outcomeOf(async () => {
        const resolved = await resolveLink(vector.link, {
          trustedOrigins: vectors.meta.trustedOrigins,
          apiOrigin: vectors.meta.audience,
          fetch: serviceReturning(vector.serverRecord, calls),
          now: Date.parse(vector.now),
        });
        return { type: resolved.type };
      });
      expect(reasonOf(outcome)).toBe(reasonOf(vector.expect));
      if (vector.expect.status === 200) expect(outcome.type).toBe(vector.expect.type);
      if (vector.expect.reason === "removed_version") expect(calls).toEqual([]);
    });
  }
});

describe("vectors: links", () => {
  for (const vector of vectors.links) {
    it(vector.name, async () => {
      const expected = vector.expect;
      if ("recordJcs" in expected) {
        const parsed = parseLink(vector.href, { trustedOrigins: vectors.meta.trustedOrigins });
        if (parsed.form !== "full") throw new Error("expected a full link");
        expect(canonicalize(parsed.record)).toBe(expected.recordJcs);
        expect(utf8Bytes(canonicalize(parsed.record)).length).toBe(expected.recordBytes);
        expect(vector.href.length).toBe(expected.linkChars);
        return;
      }
      const outcome = await outcomeOf(() => {
        const parsed = parseLink(vector.href, { trustedOrigins: vectors.meta.trustedOrigins });
        if (parsed.form === "short") expect({ valid: true, form: "short", pathType: parsed.pathType, id: parsed.id, k: parsed.k, c: parsed.c }).toEqual(expected);
        else expect({ valid: true, form: "full", k: parsed.k }).toEqual(expected);
      });
      if (expected.valid === true) expect(outcome.status).toBe(200);
      else expect(outcome.reason).toBe(expected.reason);
    });
  }
});

describe("vectors: read", () => {
  for (const vector of vectors.read) {
    it(`${vector.type}: a program that resolves the link reads it as the contract says`, async () => {
      const share = vectors.resolve.find((entry) => entry.name === `valid ${vector.type} short link`);
      if (share === undefined || share.serverRecord === null) throw new Error("vector file lacks the valid short link rows");
      const calls: { method: string; url: string }[] = [];
      let consumed = false;
      const base = serviceReturning(share.serverRecord);
      const readOnce = vector.type === "openkey-login";
      const service = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: String(input) });
        if (readOnce ? method === "GET" || consumed : method !== "GET") return serviceReturning(null)(input, init);
        consumed = true;
        return base(input, init);
      }) as typeof globalThis.fetch;
      const results: number[] = [];
      for (let i = 0; i < 2; i += 1) {
        const outcome = await outcomeOf(async () => {
          await resolveLink(share.link, { trustedOrigins: vectors.meta.trustedOrigins, apiOrigin: vectors.meta.audience, fetch: service, now: Date.parse(share.now) });
        });
        results.push(outcome.status === 200 ? 200 : 404);
      }
      // A repeat-read type serves both times; a read-once type serves the first `take` only.
      const gets = vector.expect.filter((_, index) => vector.sequence[index] === "GET");
      expect(results).toEqual(readOnce ? [200, 404] : [gets[0], gets[0]]);
      expect(calls.map((call) => call.method)).toEqual(readOnce ? ["POST", "POST"] : ["GET", "GET"]);
      if (readOnce) expect(calls.every((call) => call.url.endsWith("/take"))).toBe(true);
    });
  }
});

describe("vectors: a short link of a given sealed body, end to end", () => {
  const { bodies } = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as {
    bodies: readonly { readonly name: string; readonly plaintext: string; readonly keyB64u: string; readonly blobB64u: string; readonly cid: string }[];
  };
  const ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";
  const bodyNamed = (name: string) => {
    const found = bodies.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`vector file lacks the ${name} body`);
    return found;
  };
  const validShare = () => {
    const found = vectors.resolve.find((entry) => entry.name === "valid share short link");
    if (found === undefined || found.serverRecord === null) throw new Error("vector file lacks the valid share short link");
    return { ...found, serverRecord: found.serverRecord };
  };
  const resolveWith = (record: RecordShape, link: string, now: string) =>
    resolveLink(link, { trustedOrigins: vectors.meta.trustedOrigins, apiOrigin: vectors.meta.audience, fetch: serviceReturning(record), now: Date.parse(now) });

  it("derives the vector's short link from the sealed body and its key, and opens it again", async () => {
    const share = bodyNamed("share");
    const blob = fromBase64Url(share.blobB64u);
    const bodyCid = await computeCid(blob);
    expect(bodyCid).toBe(share.cid);
    const href = buildShortLink({ origin: vectors.meta.trustedOrigins[0] ?? "", type: "share", id: ID, key: fromBase64Url(share.keyB64u), bodyCid });
    const vector = validShare();
    expect(href).toBe(vector.link);
    const resolved = await resolveWith(vector.serverRecord, href, vector.now);
    expect(new TextDecoder().decode(resolved.plaintext)).toBe(share.plaintext);
    expect(resolved.header.bodyCid).toBe(share.cid);
  });

  it("refuses bytes that do not hash to the link's CID: a flipped byte, another share's bytes, and the same length of other bytes", async () => {
    const vector = validShare();
    const blob = fromBase64Url(bodyNamed("share").blobB64u);
    const flippedLast = Uint8Array.from(blob, (byte, index) => (index === blob.length - 1 ? byte ^ 1 : byte));
    const flippedFirst = Uint8Array.from(blob, (byte, index) => (index === 0 ? byte ^ 1 : byte));
    const other = fromBase64Url(bodyNamed("share-other-signer").blobB64u);
    const otherPadded = new Uint8Array(blob.length);
    otherPadded.set(other);
    const cases: readonly { readonly bytes: Uint8Array; readonly code: string }[] = [
      { bytes: flippedLast, code: "body_hash_mismatch" },
      { bytes: flippedFirst, code: "body_hash_mismatch" },
      { bytes: other, code: "size_mismatch" },
      { bytes: otherPadded, code: "body_hash_mismatch" },
    ];
    expect(other.length).not.toBe(blob.length);
    for (const { bytes, code } of cases) {
      let failure: unknown;
      try {
        await resolveWith({ ...vector.serverRecord, body: toBase64Url(bytes) }, vector.link, vector.now);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LinkError);
      expect(failure).toMatchObject({ code });
    }
  });
});
