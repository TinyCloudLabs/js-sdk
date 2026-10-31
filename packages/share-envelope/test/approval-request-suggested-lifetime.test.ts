import { describe, expect, test } from "bun:test";
import { canonicalize } from "../src/jcs.js";
import { createApprovalRequest, LinkError, linkIssuerPublicKey, openLinkRecord, parseApprovalRequest, parseLink, signerFromSeed, type OpenKeyApprovalRequestV1 } from "../src/links/index.js";

// TC-2272 step 1: an approval request may carry an optional `suggestedLifetimeSeconds` (an integer >= 1 that is at most `grantLifetimeSeconds`; absent means
// the maximum). Only the schema and the type change here. The signed request is `canonicalize(parse(request))` sealed into a signed link record, and
// OpenKey opens it and parses it with the same schema, so these tests pin (a) what parses, (b) what is refused, (c) that an old request, with no
// field, is byte-for-byte what it was before, and (d) where the new field lands in the canonical bytes.
const signer = signerFromSeed(new Uint8Array(32).fill(17));
const ONE_YEAR = 31_536_000;
const RECIPIENT = { kty: "EC" as const, crv: "P-256" as const, x: "0OgHreTz-Zdfp0tyUAPyVrMOo0R-wnEsnksE8logVS0", y: "-H5N_BfD1_AVu1JmXf9P-g1Xw7l6Y9SKCnjUuv99nDs" };
const base = {
  issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
  targetPublicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: Buffer.from(linkIssuerPublicKey(signer.did)!).toString("base64url") },
  nodeOrigin: "https://node.example",
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }],
  reason: "sync notes", grantLifetimeSeconds: ONE_YEAR, resultEncryptionPublicJwk: RECIPIENT,
};
const parse = (value: unknown) => parseApprovalRequest(value, { issuer: signer.did });
const refusal = (value: unknown): unknown => { try { parse(value); } catch (error) { return error; } return undefined; };

/** `canonicalize(parseApprovalRequest(base))` as computed by the code BEFORE the field existed. Pinned literally: an old request must not change by a byte. */
const OLD_CANONICAL = '{"grantLifetimeSeconds":31536000,"issuer":"did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S","nodeOrigin":"https://node.example","permissions":[{"actions":["tinycloud.kv/list"],"path":"","service":"tinycloud.kv","space":"applications"}],"reason":"sync notes","requestVersion":1,"resultEncryptionPublicJwk":{"crv":"P-256","kty":"EC","x":"0OgHreTz-Zdfp0tyUAPyVrMOo0R-wnEsnksE8logVS0","y":"-H5N_BfD1_AVu1JmXf9P-g1Xw7l6Y9SKCnjUuv99nDs"},"targetDid":"did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S","targetPublicJwk":{"crv":"Ed25519","kty":"OKP","x":"0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc"}}';

describe("accepted", () => {
  test("a request without the field parses exactly as before, and the field stays absent (not undefined, not defaulted)", () => {
    const parsed = parse(base);
    expect(parsed).toEqual(base);
    expect("suggestedLifetimeSeconds" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(base).sort());
  });

  for (const [name, suggested, grant] of [
    ["a week under a one-year maximum", 604_800, ONE_YEAR],
    ["equal to the maximum", ONE_YEAR, ONE_YEAR],
    ["one second", 1, ONE_YEAR],
    ["one second under a short maximum", 3599, 3600],
    ["equal to a short maximum", 3600, 3600],
    ["a maximum above one year (the field has no upper bound of its own)", 2 * ONE_YEAR, 2 * ONE_YEAR],
  ] as const) {
    test(name, () => {
      const request = { ...base, grantLifetimeSeconds: grant, suggestedLifetimeSeconds: suggested };
      const parsed: OpenKeyApprovalRequestV1 = parse(request);
      expect(parsed.suggestedLifetimeSeconds).toBe(suggested);
      expect(parsed).toEqual(request);
    });
  }
});

describe("refused with LinkError body_validation_failed 'invalid approval request'", () => {
  const cases: [string, unknown][] = [
    ["0", 0],
    ["-1", -1],
    ["a non-integer", 1.5],
    ["a string", "3600"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["true", true],
    ["an array", [3600]],
    ["one second more than grantLifetimeSeconds", ONE_YEAR + 1],
    ["far more than grantLifetimeSeconds", ONE_YEAR * 10],
  ];
  for (const [name, suggested] of cases) {
    test(name, () => {
      const error = refusal({ ...base, suggestedLifetimeSeconds: suggested });
      expect(error).toBeInstanceOf(LinkError);
      expect([(error as LinkError).code, (error as LinkError).message]).toEqual(["body_validation_failed", "invalid approval request"]);
    });
  }

  test("above a SHORT grantLifetimeSeconds by one second (the bound follows the request's own maximum)", () => {
    expect(refusal({ ...base, grantLifetimeSeconds: 3600, suggestedLifetimeSeconds: 3601 })).toBeInstanceOf(LinkError);
    expect(refusal({ ...base, grantLifetimeSeconds: 3600, suggestedLifetimeSeconds: 3600 })).toBeUndefined();
  });

  test("an unknown extra field is still refused (strict kept), with or without the new field", () => {
    for (const request of [{ ...base, extra: 1 }, { ...base, suggestedLifetimeSeconds: 3600, extra: 1 }, { ...base, suggestedTtlSeconds: 3600 }]) {
      const error = refusal(request);
      expect([(error as LinkError).code, (error as LinkError).message]).toEqual(["body_validation_failed", "invalid approval request"]);
    }
  });

  test("requestVersion stays the literal 1", () => {
    expect(refusal({ ...base, requestVersion: 2, suggestedLifetimeSeconds: 3600 })).toBeInstanceOf(LinkError);
  });

  test("the field is optional, not required: a request that omits it is not refused", () => {
    expect(refusal(base)).toBeUndefined();
  });
});

describe("the signed request: where it is serialized, and the bytes OpenKey opens", () => {
  test("the canonical bytes of an old request (no field) are exactly what they were before the field existed", () => {
    expect(canonicalize(parse(base))).toBe(OLD_CANONICAL);
  });

  test("a new request canonicalizes with the field at its sorted position (after resultEncryptionPublicJwk, before targetDid), and nothing else moves", () => {
    const canonical = canonicalize(parse({ ...base, suggestedLifetimeSeconds: 604_800 }));
    const expected = OLD_CANONICAL.replace('},"targetDid"', '},"suggestedLifetimeSeconds":604800,"targetDid"');
    expect(expected).not.toBe(OLD_CANONICAL);
    expect(canonical).toBe(expected);
  });

  test("the canonical bytes do not depend on the key order the caller used", () => {
    const { suggestedLifetimeSeconds: _unused, ...rest } = { ...base, suggestedLifetimeSeconds: 604_800 };
    const first = { suggestedLifetimeSeconds: 604_800, ...rest };
    const reversed = Object.fromEntries(Object.entries({ ...rest, suggestedLifetimeSeconds: 604_800 }).reverse());
    expect(canonicalize(parse(first))).toBe(canonicalize(parse(reversed)));
    expect(canonicalize(parse(first))).toBe(canonicalize(parse({ ...base, suggestedLifetimeSeconds: 604_800 })));
  });

  test("createApprovalRequest seals canonicalize(request) into the signed record: an old request opens to the old bytes, a new one to the new bytes", async () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    const created: unknown[] = [];
    const run = async (request: unknown) => {
      const fetchStub = Object.assign(async (_url: unknown, init?: RequestInit) => {
        const record = JSON.parse(String(init?.body));
        created.push(record);
        return new Response(JSON.stringify({ id: "abcdefghijklmnopqrstuvwxyz", expiresAt: record.header.expiresAt }), { status: 201, headers: { "content-type": "application/json" } });
      }, { preconnect: () => {} }) as typeof globalThis.fetch;
      const made = await createApprovalRequest({ request: request as OpenKeyApprovalRequestV1, issuerKey: signer, apiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example", now, fetch: fetchStub });
      const parsedLink = parseLink(made.link, { trustedOrigins: ["https://openkey.example"] });
      expect(parsedLink.form).toBe("short");
      const opened = await openLinkRecord(made.record, (parsedLink as { key: Uint8Array }).key, { now });
      return { text: new TextDecoder().decode(opened.plaintext), header: made.record.header };
    };
    const old = await run(base);
    expect(old.text).toBe(OLD_CANONICAL);
    const next = await run({ ...base, suggestedLifetimeSeconds: 604_800 });
    expect(next.text).toBe(OLD_CANONICAL.replace('},"targetDid"', '},"suggestedLifetimeSeconds":604800,"targetDid"'));
    // The header that the issuer signs carries only the body's CID: OpenKey verifies the signed header, then opens the body and parses it with this schema.
    expect(next.header.bodyCid).not.toBe(old.header.bodyCid);
    expect(created).toHaveLength(2);
  });

  test("createApprovalRequest refuses a bad suggestedLifetimeSeconds before anything is sent", async () => {
    let sent = 0;
    const fetchStub = Object.assign(async () => { sent += 1; return new Response("{}", { status: 201 }); }, { preconnect: () => {} }) as typeof globalThis.fetch;
    await expect(createApprovalRequest({ request: { ...base, suggestedLifetimeSeconds: ONE_YEAR + 1 } as OpenKeyApprovalRequestV1, issuerKey: signer, apiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example", fetch: fetchStub })).rejects.toMatchObject({ code: "body_validation_failed" });
    expect(sent).toBe(0);
  });
});
