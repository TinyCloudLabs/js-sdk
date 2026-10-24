import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ed25519 } from "@noble/curves/ed25519";

import { seal } from "../src/aead.js";
import { fromBase64Url, toBase64Url, utf8Bytes } from "../src/bytes.js";
import { canonicalize } from "../src/jcs.js";
import {
  LINK_SEAL_OVERHEAD_BYTES,
  MAX_LINK_BODY_BYTES,
  LinkError,
  buildFullLink,
  createLink,
  deleteLink,
  parseLink,
  prepareLinkRecord,
  resolveLink,
  signerFromJwk,
  signerFromSeed,
  verifyDelete,
  verifyHeader,
  type LinkDeleteRequestV1,
  type LinkRecord,
  type LinkSigner,
  type LinkType,
} from "../src/links/index.js";

const API = "https://api.tinycloud.xyz";
const SHARE_ORIGIN = "https://share.tinycloud.xyz";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly init: RequestInit;
}

function recorder(respond: (seen: Seen) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const entry: Seen = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === "string" ? init.body : undefined,
      init,
    };
    seen.push(entry);
    return respond(entry);
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, seen };
}

const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function sharePlaintext(signer: LinkSigner, extra: Record<string, unknown> = {}): Promise<Uint8Array> {
  return utf8Bytes(canonicalize({ version: 3, signature: { algorithm: "Ed25519", signerDid: signer.did, value: "TEST ONLY" }, ...extra }));
}

/** A stub service that stores what it is sent and serves it back as the contract's read does. */
function storingService(): { fetch: typeof globalThis.fetch; seen: Seen[]; stored: () => LinkRecord | undefined } {
  let record: LinkRecord | undefined;
  const { fetch: fetchFn, seen } = recorder((request) => {
    if (request.method === "POST" && request.url === `${API}/v1/links`) {
      record = JSON.parse(request.body ?? "") as LinkRecord;
      return json(201, { id: ID, expiresAt: record.header.expiresAt });
    }
    if (record === undefined) return json(404, { error: "not_found" });
    const { body, ...stored } = record;
    return new Response(fromBase64Url(body), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "x-link-record": toBase64Url(utf8Bytes(canonicalize(stored))) },
    });
  });
  return { fetch: fetchFn, seen, stored: () => record };
}

describe("signers", () => {
  it("a signer built from a JWK is the signer built from its seed", () => {
    const seed = signerFromSeed(SEED);
    const jwk = signerFromJwk({ kty: "OKP", crv: "Ed25519", x: toBase64Url(ed25519.getPublicKey(SEED)), d: toBase64Url(SEED) });
    expect(jwk.did).toBe(seed.did);
  });

  it("accepts a caller-held key: a node:crypto signer works end to end", async () => {
    const derived = signerFromSeed(SEED);
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED)]);
    const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const external: LinkSigner = { did: derived.did, sign: async (digest) => new Uint8Array(nodeSign(null, digest, privateKey)) };
    const { fetch: fetchFn, stored } = storingService();
    await createLink({ type: "courier", plaintext: utf8Bytes(canonicalize({ issuer: external.did })), issuerKey: external, apiOrigin: API, linkOrigin: "https://courier.example", expiresAt: new Date(NOW + 3600_000), now: NOW, fetch: fetchFn });
    const record = stored();
    expect(record?.signature).toBeDefined();
    expect(record === undefined ? false : verifyHeader(record.header, record.signature)).toBe(true);
  });

  it("rejects a JWK whose public half is not the public key of its private half", () => {
    const other = signerFromSeed(Uint8Array.from({ length: 32 }, () => 9));
    expect(other.did).not.toBe(signerFromSeed(SEED).did);
    expect(() => signerFromJwk({ kty: "OKP", crv: "Ed25519", x: toBase64Url(new Uint8Array(32)), d: toBase64Url(SEED) })).toThrow(LinkError);
  });

  it("refuses to sign for an issuer other than its own did", async () => {
    const signer = signerFromSeed(SEED);
    const impostor: LinkSigner = { did: signerFromSeed(Uint8Array.from({ length: 32 }, () => 7)).did, sign: signer.sign };
    await expect(
      prepareLinkRecord({ type: "share", plaintext: await sharePlaintext(impostor), issuerKey: impostor, apiOrigin: API, expiresAt: new Date(NOW + 3600_000), now: NOW }),
    ).rejects.toMatchObject({ code: "signer_failed" });
  });
});

describe("createLink", () => {
  it("never puts the content key in a request, and returns the link that carries it", async () => {
    const signer = signerFromSeed(SEED);
    const key = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);
    const sealed = await seal(await sharePlaintext(signer, { note: "SENTINEL-PLAINTEXT" }), key);
    const service = storingService();
    const created = await createLink({ type: "share", sealed: { blob: sealed.blob, key }, issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), now: NOW, fetch: service.fetch });

    expect(service.seen).toHaveLength(1);
    const [request] = service.seen;
    const keyText = toBase64Url(key);
    const everything = JSON.stringify(request);
    expect(everything).not.toContain(keyText);
    expect(everything).not.toContain("SENTINEL-PLAINTEXT");
    expect(request?.url).toBe(`${API}/v1/links`);
    expect(Object.keys(JSON.parse(request?.body ?? "{}") as object).sort()).toEqual(["body", "header", "signature"]);
    expect(request?.init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(created.link).toBe(`${SHARE_ORIGIN}/s/${ID}#v=4&k=${keyText}&c=${sealed.cid}`);
    expect(created.id).toBe(ID);
  });

  it("seals a plaintext under a fresh key that opens the stored body", async () => {
    const signer = signerFromSeed(SEED);
    const service = storingService();
    const plaintext = await sharePlaintext(signer);
    const { link } = await createLink({ type: "share", plaintext, issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), now: NOW, fetch: service.fetch });
    const resolved = await resolveLink(link, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch: service.fetch, now: NOW });
    expect(resolved.plaintext).toEqual(plaintext);
    expect(resolved.id).toBe(ID);
  });

  it("checks life, window and caps before it sends anything", async () => {
    const signer = signerFromSeed(SEED);
    const service = storingService();
    const base = { issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, now: NOW, fetch: service.fetch } as const;
    const plaintext = await sharePlaintext(signer);
    await expect(createLink({ ...base, type: "share", plaintext, expiresAt: new Date(NOW + 2_592_001_000) })).rejects.toMatchObject({ code: "life_too_long" });
    await expect(createLink({ ...base, type: "share", plaintext, expiresAt: new Date(NOW + 119_000) })).rejects.toMatchObject({ code: "life_too_short" });
    await expect(createLink({ ...base, type: "openkey-login", plaintext, expiresAt: new Date(NOW + 601_000) })).rejects.toMatchObject({ code: "life_too_long" });
    await expect(createLink({ ...base, type: "courier", plaintext: new Uint8Array(MAX_LINK_BODY_BYTES), expiresAt: new Date(NOW + 3600_000) })).rejects.toMatchObject({ code: "body_over_cap" });
    await expect(createLink({ ...base, type: "share", plaintext: new Uint8Array(MAX_LINK_BODY_BYTES), expiresAt: new Date(NOW + 3600_000) })).rejects.toMatchObject({ code: "body_over_cap" });
    expect(service.seen).toEqual([]);
  });

  it("reports a refusal with the service's status and error code and nothing else", async () => {
    const signer = signerFromSeed(SEED);
    const { fetch: fetchFn } = recorder(() => json(429, { error: "rate_limited", detail: "SENTINEL" }));
    const failure = await createLink({ type: "share", plaintext: await sharePlaintext(signer), issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), now: NOW, fetch: fetchFn }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinkError);
    expect(failure).toMatchObject({ code: "service_refused", status: 429, serviceError: "rate_limited" });
    expect(failure instanceof LinkError ? failure.message : "").not.toContain("SENTINEL");
  });

  it("refuses an id that is not 26 lowercase base32 characters, and a mismatched expiry", async () => {
    const signer = signerFromSeed(SEED);
    const input = { type: "share", issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), now: NOW } as const;
    const plaintext = await sharePlaintext(signer);
    const badId = recorder((request) => json(201, { id: "SHORT", expiresAt: JSON.parse(request.body ?? "").header.expiresAt }));
    await expect(createLink({ ...input, plaintext, fetch: badId.fetch })).rejects.toMatchObject({ code: "invalid_response" });
    const badExpiry = recorder(() => json(201, { id: ID, expiresAt: "2026-10-24T12:00:00.000Z" }));
    await expect(createLink({ ...input, plaintext, fetch: badExpiry.fetch })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports an unreachable service as service_unavailable", async () => {
    const signer = signerFromSeed(SEED);
    const down = recorder(() => {
      throw new TypeError("connection refused");
    }).fetch;
    await expect(
      createLink({ type: "share", plaintext: await sharePlaintext(signer), issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), now: NOW, fetch: down }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });
});

describe("deleteLink", () => {
  it("posts a signed delete that verifies, reports deleted and absent, and carries no key", async () => {
    const signer = signerFromSeed(SEED);
    const gone = recorder(() => new Response(null, { status: 204 }));
    await expect(deleteLink({ id: ID.toUpperCase(), issuerKey: signer, apiOrigin: API, now: NOW, fetch: gone.fetch })).resolves.toBe("deleted");
    const [request] = gone.seen;
    expect(request?.url).toBe(`${API}/v1/links/${ID}/delete`);
    const body = JSON.parse(request?.body ?? "") as { request: LinkDeleteRequestV1; signature: unknown };
    expect(Object.keys(body).sort()).toEqual(["request", "signature"]);
    expect(body.request).toMatchObject({ id: ID, op: "delete", issuer: signer.did, audience: API });
    expect(verifyDelete(body.request, body.signature)).toBe(true);

    const absent = recorder(() => json(404, { error: "not_found" }));
    await expect(deleteLink({ id: ID, issuerKey: signer, apiOrigin: API, now: NOW, fetch: absent.fetch })).resolves.toBe("absent");
    const refused = recorder(() => json(401, { error: "invalid_signature" }));
    await expect(deleteLink({ id: ID, issuerKey: signer, apiOrigin: API, now: NOW, fetch: refused.fetch })).rejects.toMatchObject({ code: "service_refused", status: 401, serviceError: "invalid_signature" });
  });

  it("refuses a malformed id before any request", async () => {
    const signer = signerFromSeed(SEED);
    const service = recorder(() => new Response(null, { status: 204 }));
    await expect(deleteLink({ id: "short", issuerKey: signer, apiOrigin: API, fetch: service.fetch })).rejects.toMatchObject({ code: "id_grammar" });
    expect(service.seen).toEqual([]);
  });
});

describe("resolveLink", () => {
  async function published(type: LinkType = "share") {
    const signer = signerFromSeed(SEED);
    const service = storingService();
    const plaintext = type === "share" ? await sharePlaintext(signer) : utf8Bytes(canonicalize({ issuer: signer.did, kind: type }));
    const { link } = await createLink({ type, plaintext, issuerKey: signer, apiOrigin: API, linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), now: NOW, fetch: service.fetch });
    return { signer, service, link };
  }

  it("sends no part of the fragment in its request", async () => {
    const { service, link } = await published();
    const before = service.seen.length;
    const fragment = new URL(link).hash.slice(1);
    await resolveLink(link, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch: service.fetch, now: NOW });
    const requests = service.seen.slice(before);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${API}/v1/links/${ID}`);
    for (const part of fragment.split("&")) expect(JSON.stringify(requests[0])).not.toContain(part.slice(2));
  });

  it("runs the caller's validator after every contract check, with the type and the parsed plaintext", async () => {
    const { service, link } = await published();
    const calls: { type: string; value: unknown }[] = [];
    const resolved = await resolveLink(link, {
      trustedOrigins: [SHARE_ORIGIN],
      apiOrigin: API,
      fetch: service.fetch,
      now: NOW,
      validateBody: (type, value) => {
        calls.push({ type, value });
      },
    });
    expect(calls).toEqual([{ type: "share", value: resolved.value }]);
  });

  it("returns nothing when the validator throws, and wraps its error in a LinkError that keeps the cause", async () => {
    const { service, link } = await published();
    const cause = new Error("schema says no");
    const failure = await resolveLink(link, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch: service.fetch, now: NOW, validateBody: () => { throw cause; } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinkError);
    expect(failure).toMatchObject({ code: "body_validation_failed", cause });
  });

  it("does not call the validator when a contract check fails", async () => {
    const { service, link } = await published("courier");
    const swapped = link.replace("/c/", "/s/");
    let called = false;
    await expect(
      resolveLink(swapped, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch: service.fetch, now: NOW, validateBody: () => { called = true; } }),
    ).rejects.toMatchObject({ code: "type_path_mismatch" });
    expect(called).toBe(false);
  });

  it("refuses a response over the type cap, a wrong content type and an oversized record header", async () => {
    const { link } = await published();
    const trusted = { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, now: NOW } as const;
    const wellFormedHeader = toBase64Url(utf8Bytes('{"header":{}}'));
    const big = recorder(() => new Response(new Uint8Array(131_073), { status: 200, headers: { "content-type": "application/octet-stream", "x-link-record": wellFormedHeader } }));
    await expect(resolveLink(link, { ...trusted, fetch: big.fetch })).rejects.toMatchObject({ code: "response_too_large" });
    const html = recorder(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html", "x-link-record": "AA" } }));
    await expect(resolveLink(link, { ...trusted, fetch: html.fetch })).rejects.toMatchObject({ code: "invalid_response" });
    const longHeader = recorder(() => new Response(new Uint8Array(40), { status: 200, headers: { "content-type": "application/octet-stream", "x-link-record": "A".repeat(2049) } }));
    await expect(resolveLink(link, { ...trusted, fetch: longHeader.fetch })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports an unknown link as gone", async () => {
    const { link } = await published();
    const empty = recorder(() => json(404, { error: "not_found" }));
    await expect(resolveLink(link, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch: empty.fetch, now: NOW })).rejects.toMatchObject({ code: "gone" });
  });
});

describe("full links", () => {
  it("round-trips a share whose life is over the service cap, without a request", async () => {
    const signer = signerFromSeed(SEED);
    const plaintext = await sharePlaintext(signer);
    const expiresAt = new Date(NOW + 90 * 86_400_000);
    await expect(prepareLinkRecord({ type: "share", plaintext, issuerKey: signer, apiOrigin: API, expiresAt, now: NOW })).rejects.toMatchObject({ code: "life_too_long" });
    const { record, key } = await prepareLinkRecord({ type: "share", plaintext, issuerKey: signer, apiOrigin: API, expiresAt, now: NOW, enforceServiceLife: false });
    const link = buildFullLink({ origin: SHARE_ORIGIN, key, record });
    expect(parseLink(link, { trustedOrigins: [SHARE_ORIGIN] }).form).toBe("full");
    const neverCalled = recorder(() => json(500, {}));
    const resolved = await resolveLink(link, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, fetch: neverCalled.fetch, now: NOW });
    expect(resolved.plaintext).toEqual(plaintext);
    expect(resolved.form).toBe("full");
    expect(neverCalled.seen).toEqual([]);
  });

  it("refuses to build a full link for a type other than share", async () => {
    const signer = signerFromSeed(SEED);
    const { record, key } = await prepareLinkRecord({ type: "courier", plaintext: utf8Bytes(canonicalize({ issuer: signer.did })), issuerKey: signer, apiOrigin: API, expiresAt: new Date(NOW + 3600_000), now: NOW });
    expect(() => buildFullLink({ origin: SHARE_ORIGIN, key, record })).toThrow(LinkError);
  });

  it("accepts a body of exactly the limit and refuses one byte more, for a short and a full link, before signing", async () => {
    const base = signerFromSeed(SEED);
    let signatures = 0;
    const signer: LinkSigner = {
      did: base.did,
      sign: (digest) => {
        signatures += 1;
        return base.sign(digest);
      },
    };
    // sealed body = plaintext + LINK_SEAL_OVERHEAD_BYTES (version byte, nonce, tag)
    const plaintextOfSealedSize = (sealedBytes: number): Uint8Array => {
      const frame = canonicalize({ pad: "", signature: { signerDid: signer.did } });
      return utf8Bytes(canonicalize({ pad: "x".repeat(sealedBytes - LINK_SEAL_OVERHEAD_BYTES - frame.length), signature: { signerDid: signer.did } }));
    };
    const input = { type: "share", issuerKey: signer, apiOrigin: API, expiresAt: new Date(NOW + 90 * 86_400_000), now: NOW, enforceServiceLife: false } as const;

    const atLimit = await prepareLinkRecord({ ...input, plaintext: plaintextOfSealedSize(MAX_LINK_BODY_BYTES) });
    expect(fromBase64Url(atLimit.record.body).length).toBe(MAX_LINK_BODY_BYTES);
    const link = buildFullLink({ origin: SHARE_ORIGIN, key: atLimit.key, record: atLimit.record });
    const resolved = await resolveLink(link, { trustedOrigins: [SHARE_ORIGIN], apiOrigin: API, now: NOW });
    expect(resolved.body.length).toBe(MAX_LINK_BODY_BYTES);

    const signedBefore = signatures;
    await expect(prepareLinkRecord({ ...input, plaintext: plaintextOfSealedSize(MAX_LINK_BODY_BYTES + 1) })).rejects.toMatchObject({ code: "body_over_cap" });
    const service = storingService();
    await expect(
      createLink({ ...input, plaintext: plaintextOfSealedSize(MAX_LINK_BODY_BYTES + 1), linkOrigin: SHARE_ORIGIN, expiresAt: new Date(NOW + 3600_000), fetch: service.fetch }),
    ).rejects.toMatchObject({ code: "body_over_cap" });
    expect(signatures).toBe(signedBefore);
    expect(service.seen).toEqual([]);

    const oversized = { ...atLimit.record, body: toBase64Url(new Uint8Array(MAX_LINK_BODY_BYTES + 1)) };
    let failure: unknown;
    try {
      buildFullLink({ origin: SHARE_ORIGIN, key: atLimit.key, record: oversized });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "body_over_cap" });
  });
});
