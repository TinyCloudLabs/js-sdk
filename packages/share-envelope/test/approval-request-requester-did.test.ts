import { describe, expect, test } from "bun:test";
import { base58btc } from "multiformats/bases/base58";
import { canonicalize } from "../src/jcs.js";
import {
  buildShareInvitationApprovalSpec, buildShortLink, createApprovalRequest, linkIssuerPublicKey, openLinkRecord,
  parseApprovalRequest, parseLink, prepareLinkRecord, resolveApprovalRequest, signerFromSeed,
  type LinkRecord, type OpenKeyApprovalRequestV1,
} from "../src/links/index.js";

const now = Date.parse("2026-10-28T12:00:00.000Z");
const requester = signerFromSeed(new Uint8Array(32).fill(18));
const target = signerFromSeed(new Uint8Array(32).fill(17));
const publicJwk = (did: string) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: Buffer.from(linkIssuerPublicKey(did)!).toString("base64url") });
const resultEncryptionPublicJwk = { kty: "EC" as const, crv: "P-256" as const,
  x: "0OgHreTz-Zdfp0tyUAPyVrMOo0R-wnEsnksE8logVS0", y: "-H5N_BfD1_AVu1JmXf9P-g1Xw7l6Y9SKCnjUuv99nDs" };
const legacy = {
  issuer: target.did, requestVersion: 1 as const, targetDid: target.did, targetPublicJwk: publicJwk(target.did),
  nodeOrigin: "https://node.example", permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }],
  reason: "sync notes", grantLifetimeSeconds: 31_536_000, resultEncryptionPublicJwk,
};
const present = { ...legacy, issuer: requester.did, requesterDid: requester.did };
// Pinned pre-change fixture from approval-request-suggested-lifetime.test.ts.
const OLD_CANONICAL = '{"grantLifetimeSeconds":31536000,"issuer":"did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S","nodeOrigin":"https://node.example","permissions":[{"actions":["tinycloud.kv/list"],"path":"","service":"tinycloud.kv","space":"applications"}],"reason":"sync notes","requestVersion":1,"resultEncryptionPublicJwk":{"crv":"P-256","kty":"EC","x":"0OgHreTz-Zdfp0tyUAPyVrMOo0R-wnEsnksE8logVS0","y":"-H5N_BfD1_AVu1JmXf9P-g1Xw7l6Y9SKCnjUuv99nDs"},"targetDid":"did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S","targetPublicJwk":{"crv":"Ed25519","kty":"OKP","x":"0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc"}}';
const apiOrigin = "https://api.tinycloud.xyz";
const openkeyOrigin = "https://openkey.example";
const id = "abcdefghijklmnopqrstuvwxyz";

function transport(stored?: LinkRecord) {
  let record: LinkRecord | undefined = stored;
  let posts = 0;
  const fetchStub = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${apiOrigin}/v1/links` && init?.method === "POST") {
      posts++;
      record = JSON.parse(String(init.body)) as LinkRecord;
      return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
    }
    if (url === `${apiOrigin}/v1/links/${id}` && (init?.method ?? "GET") === "GET" && record) {
      return new Response(Buffer.from(record.body, "base64url"), { headers: {
        "Content-Type": "application/octet-stream",
        "X-Link-Record": Buffer.from(canonicalize({ header: record.header, signature: record.signature })).toString("base64url"),
      } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  return { fetchStub, get record() { return record; }, get posts() { return posts; } };
}

async function createAndOpen(request: OpenKeyApprovalRequestV1, signer: typeof target, fetchStub: typeof fetch) {
  const created = await createApprovalRequest({ request, issuerKey: signer, apiOrigin, openkeyOrigin, now, fetch: fetchStub });
  const parsed = parseLink(created.link, { trustedOrigins: [openkeyOrigin] });
  expect(parsed.form).toBe("short");
  const opened = await openLinkRecord(created.record, parsed.key, { now });
  const resolved = await resolveApprovalRequest(created.link, { trustedOrigins: [openkeyOrigin], apiOrigin, now, fetch: fetchStub });
  return { opened, resolved };
}

test("legacy absent requesterDid parses and opens with identical pre-change canonical bytes", async () => {
  expect(canonicalize(parseApprovalRequest(legacy, { issuer: target.did }))).toBe(OLD_CANONICAL);
  const server = transport();
  const { opened, resolved } = await createAndOpen(legacy, target, server.fetchStub);
  expect(new TextDecoder().decode(opened.plaintext)).toBe(OLD_CANONICAL);
  expect(resolved.request).toEqual(legacy);
  expect("requesterDid" in resolved.request).toBe(false);
});

test("a distinct requester signs and opens its request for the target key", async () => {
  expect(parseApprovalRequest(present, { issuer: requester.did })).toEqual(present);
  const server = transport();
  const { opened, resolved } = await createAndOpen(present, requester, server.fetchStub);
  expect(opened.header.issuer).toBe(requester.did);
  expect(resolved.request).toEqual(present);
  expect(canonicalize(resolved.request)).toContain(`"requesterDid":"${requester.did}"`);
});

const nonEdDid = `did:key:${base58btc.encode(Uint8Array.of(0x80, 0x24, ...linkIssuerPublicKey(requester.did)!))}`;
const malformed: Array<[string, unknown, string, string]> = [
  ["different from body issuer", { ...present, requesterDid: target.did }, requester.did, "issuer_binding_mismatch"],
  ["different from signed header issuer", present, target.did, "issuer_binding_mismatch"],
  ["equal to target DID", { ...legacy, requesterDid: target.did }, target.did, "issuer_binding_mismatch"],
  ["noncanonical base58 DID", { ...present, issuer: `did:key:z1${requester.did.slice("did:key:z".length)}`, requesterDid: `did:key:z1${requester.did.slice("did:key:z".length)}` }, `did:key:z1${requester.did.slice("did:key:z".length)}`, "issuer_binding_mismatch"],
  ["non-Ed25519 DID", { ...present, issuer: nonEdDid, requesterDid: nonEdDid }, nonEdDid, "issuer_binding_mismatch"],
  ["garbage DID", { ...present, issuer: "not-a-did", requesterDid: "not-a-did" }, "not-a-did", "issuer_binding_mismatch"],
  ["non-string field", { ...present, requesterDid: 42 }, requester.did, "body_validation_failed"],
  ["mismatched target JWK without field", { ...legacy, targetPublicJwk: publicJwk(requester.did) }, target.did, "issuer_binding_mismatch"],
  ["mismatched target JWK with field", { ...present, targetPublicJwk: publicJwk(requester.did) }, requester.did, "issuer_binding_mismatch"],
];

describe("invalid requests", () => {
  for (const [name, request, issuer, code] of malformed) {
    test(`${name} is refused by parsing and before create sends a link`, async () => {
      expect(() => parseApprovalRequest(request, { issuer })).toThrow(expect.objectContaining({ code }));
      const server = transport();
      const signer = issuer === target.did ? target : requester;
      await expect(createApprovalRequest({ request: request as OpenKeyApprovalRequestV1, issuerKey: signer, apiOrigin, openkeyOrigin, now, fetch: server.fetchStub })).rejects.toMatchObject({ code });
      expect(server.posts).toBe(0);
    });
  }
});

test("a present requester requires explicit signed-header issuer binding", () => {
  expect(() => parseApprovalRequest(present)).toThrow(expect.objectContaining({ code: "issuer_binding_mismatch" }));
});

test("a request claiming someone else's DID refuses to open when signed by a different key", async () => {
  const impersonated = present;
  const prepared = await prepareLinkRecord({ type: "openkey-approval-request", plaintext: new TextEncoder().encode(canonicalize(impersonated)),
    issuerKey: target, apiOrigin, now, expiresAt: new Date(now + 3600_000) });
  await expect(openLinkRecord(prepared.record, prepared.key, { now })).rejects.toMatchObject({ code: "issuer_binding_mismatch" });
  expect(() => parseApprovalRequest(impersonated, { issuer: prepared.record.header.issuer })).toThrow(expect.objectContaining({ code: "issuer_binding_mismatch" }));
});

test.each([
  ["without", { ...legacy, targetPublicJwk: publicJwk(requester.did) }, target],
  ["with", { ...present, targetPublicJwk: publicJwk(requester.did) }, requester],
] as const)("a signed request %s requesterDid refuses a mismatched target on open", async (_name, request, signer) => {
  const prepared = await prepareLinkRecord({ type: "openkey-approval-request", plaintext: new TextEncoder().encode(canonicalize(request)),
    issuerKey: signer, apiOrigin, now, expiresAt: new Date(now + 3600_000) });
  const server = transport(prepared.record);
  const link = buildShortLink({ origin: openkeyOrigin, type: "openkey-approval-request", id, key: prepared.key, bodyCid: prepared.bodyCid });
  await expect(resolveApprovalRequest(link, { trustedOrigins: [openkeyOrigin], apiOrigin, now, fetch: server.fetchStub }))
    .rejects.toMatchObject({ code: "issuer_binding_mismatch" });
});

test("share invitation spec preserves absent shape and binds optional distinct requester", () => {
  const context = { kind: "share-invitation" as const, version: 1 as const, invitationId: "01HZX3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3",
    recipientEmail: "reader@example.com", subjectKind: "session" as const, subjectName: "plan",
    acceptanceExpiresAt: new Date(now + 3_600_000).toISOString(), accessExpiresAt: new Date(now + 3_600_000).toISOString() };
  const input = { targetDid: target.did, targetPublicJwk: publicJwk(target.did), nodeOrigin: "https://node.example", context, now };
  const absent = buildShareInvitationApprovalSpec(input);
  expect(absent.issuer).toBe(target.did);
  expect("requesterDid" in absent).toBe(false);
  expect(parseApprovalRequest({ ...absent, resultEncryptionPublicJwk }, { issuer: target.did }).context).toEqual(context);
  const distinct = buildShareInvitationApprovalSpec({ ...input, requesterDid: requester.did });
  expect(distinct.issuer).toBe(requester.did);
  expect(distinct.requesterDid).toBe(requester.did);
  expect(parseApprovalRequest({ ...distinct, resultEncryptionPublicJwk }, { issuer: requester.did }).targetDid).toBe(target.did);
});
