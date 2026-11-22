import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { base58btc } from "multiformats/bases/base58";
import { canonicalize } from "../src/jcs.js";
import { didKeyFromEd25519PublicKey } from "../src/didkey.js";
import {
  ackApprovalResult,
  ApprovalClientError,
  approvalRequestRequester,
  approvalSessionProof,
  buildShareInvitationApprovalSpec,
  buildShortLink,
  checkApprovalResultBinding,
  collectApprovalResult,
  createApprovalRequest,
  discoverApprovalResult,
  fetchApprovalResult,
  generateRelayKey,
  isApprovalRequestV2,
  LinkError,
  linkIssuerPublicKey,
  openLinkRecord,
  parseApprovalRequest,
  parseLink,
  prepareLinkRecord,
  resolveApprovalRequest,
  resolveLink,
  signerFromSeed,
  validateLinkHeader,
  verifyHeader,
  type ApprovalRequesterState,
  type Ed25519PrivateJwk,
  type LinkRecord,
  type OpenKeyApprovalRequest,
  type OpenKeyApprovalRequestV1,
  type OpenKeyApprovalRequestV2,
} from "../src/links/index.js";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const API_ORIGIN = "https://api.tinycloud.xyz";
const OPENKEY_ORIGIN = "https://openkey.example";
const OPENKEY_API_ORIGIN = "https://api.openkey.example";
const LINK_ID = "abcdefghijklmnopqrstuvwxyz";

const requesterSeed = new Uint8Array(32).fill(41);
const targetSeed = new Uint8Array(32).fill(42);
const thirdSeed = new Uint8Array(32).fill(43);

const requesterSigner = signerFromSeed(requesterSeed);
const targetSigner = signerFromSeed(targetSeed);
const thirdSigner = signerFromSeed(thirdSeed);

const jwkOf = (did: string) => ({
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  x: Buffer.from(linkIssuerPublicKey(did)!).toString("base64url"),
});

const privateJwkOf = (seed: Uint8Array, did: string): Ed25519PrivateJwk => ({
  ...jwkOf(did),
  d: Buffer.from(seed).toString("base64url"),
});

const relay = generateRelayKey();
const targetPublicJwk = jwkOf(targetSigner.did);
const targetPrivateJwk = privateJwkOf(targetSeed, targetSigner.did);
const requesterPublicJwk = jwkOf(requesterSigner.did);
const requesterPrivateJwk = privateJwkOf(requesterSeed, requesterSigner.did);
const thirdPrivateJwk = privateJwkOf(thirdSeed, thirdSigner.did);

const v1Request: OpenKeyApprovalRequestV1 = {
  issuer: targetSigner.did,
  requestVersion: 1,
  targetDid: targetSigner.did,
  targetPublicJwk,
  nodeOrigin: "https://node.example",
  permissions: [
    { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/DEMO_KEY", actions: ["tinycloud.kv/get"] },
  ],
  reason: "Read DEMO_KEY",
  grantLifetimeSeconds: 604_800,
  suggestedLifetimeSeconds: 3600,
  resultEncryptionPublicJwk: relay.publicJwk,
};

const v2Request: OpenKeyApprovalRequestV2 = {
  issuer: requesterSigner.did,
  requestVersion: 2,
  requester: requesterSigner.did,
  targetDid: targetSigner.did,
  targetPublicJwk,
  nodeOrigin: "https://node.example",
  permissions: v1Request.permissions,
  reason: v1Request.reason,
  grantLifetimeSeconds: 604_800,
  suggestedLifetimeSeconds: 3600,
  resultEncryptionPublicJwk: relay.publicJwk,
};

function refusalOf(fn: () => unknown): LinkError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkError);
    return error as LinkError;
  }
  throw new Error("expected a LinkError");
}

async function asyncRefusalOf(fn: () => Promise<unknown>): Promise<LinkError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkError);
    return error as LinkError;
  }
  throw new Error("expected a LinkError");
}

async function clientRefusalOf(fn: () => Promise<unknown>): Promise<ApprovalClientError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalClientError);
    return error as ApprovalClientError;
  }
  throw new Error("expected an ApprovalClientError");
}

function makeLinkTransport() {
  let stored: LinkRecord | undefined;
  let posts = 0;
  const fetchFn = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url === `${API_ORIGIN}/v1/links`) {
        posts += 1;
        stored = JSON.parse(String(init?.body)) as LinkRecord;
        return Response.json({ id: LINK_ID, expiresAt: stored.header.expiresAt }, { status: 201 });
      }
      if (method === "GET" && url === `${API_ORIGIN}/v1/links/${LINK_ID}` && stored) {
        return new Response(Buffer.from(stored.body, "base64url"), {
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Link-Record": Buffer.from(canonicalize({ header: stored.header, signature: stored.signature })).toString("base64url"),
          },
        });
      }
      throw new Error(`unexpected link transport call: ${method} ${url}`);
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch;
  return {
    fetch: fetchFn,
    getStored: () => stored,
    getPosts: () => posts,
    setStored: (record: LinkRecord) => { stored = record; },
  };
}

/**
 * Independent verifier for an `OpenKey-Session-Proof` JWT using `node:crypto` against one explicit Ed25519 JWK.
 */
function verifySessionProof(
  proof: string | undefined,
  expectedJwk: { kty: "OKP"; crv: "Ed25519"; x: string },
  expected: {
    action: "discover" | "fetch" | "ack";
    requestId: string;
    bodyCid: string;
    resultRef: string;
    ackId: string;
    url: string;
    codeBinding?: readonly [string, string];
  },
): boolean {
  if (!proof) return false;
  const parts = proof.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  try {
    const parsedHeader = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
    const jkt = createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: expectedJwk.x })).digest("base64url");
    const credHash = createHash("sha256")
      .update(JSON.stringify([expected.action, expected.requestId, expected.bodyCid, expected.resultRef, expected.ackId, ...(expected.codeBinding ?? [])]))
      .digest("base64url");
    return (
      verify(
        null,
        Buffer.from(`${headerPart}.${payloadPart}`),
        createPublicKey({ key: expectedJwk, format: "jwk" }),
        Buffer.from(sigPart, "base64url"),
      ) &&
      parsedHeader.alg === "EdDSA" &&
      parsedHeader.typ === "openkey-session-proof+jwt" &&
      parsedHeader.kid === jkt &&
      claims.client_id === "openkey-approval-result-v1" &&
      claims.htm === "POST" &&
      claims.htu === expected.url &&
      claims.cred_hash === credHash
    );
  } catch {
    return false;
  }
}

/**
 * Models OpenKey's two-phase approval lifecycle under the PROPOSED OpenKey v2 contract:
 * - Pre-load `discover`: OpenKey has no stored record yet and verifies the proof against `header.issuer`.
 * - Browser `/load` + approve: OpenKey resolves the link and stores `{ issuer, request, resultRef, ... }`.
 * - Post-load `discover`: models the PROPOSED OpenKey contract — for v2 (`isApprovalRequestV2(record.request)`)
 *   when `approvalCode` is absent, OpenKey verifies against `record.issuer` (`header.issuer`); for code-claim
 *   `discover` (`approvalCode` + `OpenKey-Delegation-Claim`) and for v1, OpenKey verifies against
 *   `record.request.targetPublicJwk`. Current deployed OpenKey verifies all post-load `discover` calls against
 *   the target key (`targetPublicJwk`).
 * - `fetch` and `ack`: OpenKey always verifies against `record.request.targetPublicJwk`.
 */
function makePhasedOpenKey(options: {
  readonly link: string;
  readonly linkTransport: ReturnType<typeof makeLinkTransport>;
  readonly requestId: string;
  readonly resultRef: string;
  readonly resultExpiresAt: string;
  readonly loadAfterPreLoadPolls: number;
}) {
  let loaded: { issuer: string; bodyCid: string; request: OpenKeyApprovalRequest } | null = null;
  let approved = false;
  let preLoadPolls = 0;
  const phases: Array<{ phase: string; verifiedBy: "header-issuer" | "target"; status: number }> = [];

  const fetchFn = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = init?.headers as Record<string, string>;
      const proof = headers["OpenKey-Session-Proof"];

      if (url === `${OPENKEY_API_ORIGIN}/api/approval-requests/${options.requestId}/result`) {
        if (!loaded) {
          if (body.approvalCode !== undefined) return Response.json({ code: "not_found" }, { status: 404 });
          // Pre-load discover: OpenKey verifies only the signed header and checks proof against header.issuer.
          const header = validateLinkHeader(body.header, { mode: "signed", audience: API_ORIGIN });
          const issuerKeyBytes = linkIssuerPublicKey(header.issuer);
          if (!issuerKeyBytes || !verifyHeader(header, body.signature) || header.type !== "openkey-approval-request" || header.bodyCid !== body.bodyCid) {
            return Response.json({ code: "invalid_request" }, { status: 400 });
          }
          const headerIssuerJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: Buffer.from(issuerKeyBytes).toString("base64url") };
          const ok = verifySessionProof(proof, headerIssuerJwk, {
            action: "discover", requestId: options.requestId, bodyCid: header.bodyCid, resultRef: "", ackId: "", url,
          });
          phases.push({ phase: "discover-preload", verifiedBy: "header-issuer", status: ok ? 202 : 401 });
          if (!ok) return Response.json({ code: "invalid_proof" }, { status: 401 });
          preLoadPolls += 1;
          if (preLoadPolls >= options.loadAfterPreLoadPolls) {
            const resolved = await resolveApprovalRequest(options.link, {
              trustedOrigins: [OPENKEY_ORIGIN], apiOrigin: API_ORIGIN, now: NOW, fetch: options.linkTransport.fetch,
            });
            loaded = { issuer: resolved.header.issuer, bodyCid: resolved.header.bodyCid, request: resolved.request };
            approved = true;
          }
          return new Response(null, { status: 202 });
        }

        // Post-load discover: select key strictly by isApprovalRequestV2 and mode (never accept either key).
        const hasCode = body.approvalCode !== undefined;
        const useHeaderIssuer = isApprovalRequestV2(loaded.request) && !hasCode;
        const discoverKey = useHeaderIssuer ? jwkOf(loaded.issuer) : loaded.request.targetPublicJwk;
        const claim = headers["OpenKey-Delegation-Claim"];
        if (hasCode && !claim) return Response.json({ code: "invalid_claim" }, { status: 400 });
        const codeBinding: readonly [string, string] | undefined = hasCode
          ? [
              createHash("sha256").update(String(body.approvalCode).trim().toLowerCase()).digest("base64url"),
              createHash("sha256").update(claim!).digest("base64url"),
            ]
          : undefined;
        const ok = verifySessionProof(proof, discoverKey, {
          action: "discover", requestId: options.requestId, bodyCid: loaded.bodyCid, resultRef: "", ackId: "", url,
          ...(codeBinding === undefined ? {} : { codeBinding }),
        });
        phases.push({
          phase: hasCode ? "discover-code-claim" : "discover-postload",
          verifiedBy: useHeaderIssuer ? "header-issuer" : "target",
          status: ok ? (approved ? 200 : 202) : 401,
        });
        if (!ok) return Response.json({ code: "invalid_proof" }, { status: 401 });
        if (!approved) return new Response(null, { status: 202 });
        return Response.json({ resultRef: options.resultRef, expiresAt: options.resultExpiresAt });
      }

      if (url === `${OPENKEY_API_ORIGIN}/api/approval-results/${options.resultRef}/fetch`) {
        if (!loaded || !approved) return Response.json({ code: "not_found" }, { status: 404 });
        const ok = verifySessionProof(proof, loaded.request.targetPublicJwk, {
          action: "fetch", requestId: options.requestId, bodyCid: loaded.bodyCid, resultRef: options.resultRef, ackId: "", url,
        });
        phases.push({ phase: "fetch", verifiedBy: "target", status: ok ? 200 : 401 });
        if (!ok) return Response.json({ code: "invalid_proof" }, { status: 401 });
        return Response.json({
          requestId: options.requestId, bodyCid: loaded.bodyCid, resultRef: options.resultRef,
          expiresAt: options.resultExpiresAt, relay: { version: 1, marker: "encrypted" },
        });
      }

      if (url === `${OPENKEY_API_ORIGIN}/api/approval-results/${options.resultRef}/ack`) {
        if (!loaded || !approved) return Response.json({ code: "not_found" }, { status: 404 });
        const ackId = String(body.ackId ?? "");
        const ok = verifySessionProof(proof, loaded.request.targetPublicJwk, {
          action: "ack", requestId: options.requestId, bodyCid: loaded.bodyCid, resultRef: options.resultRef, ackId, url,
        });
        phases.push({ phase: "ack", verifiedBy: "target", status: ok ? 200 : 401 });
        if (!ok) return Response.json({ code: "invalid_proof" }, { status: 401 });
        return Response.json({ ackId, status: "acknowledged" });
      }

      throw new Error(`unexpected OpenKey URL: ${url}`);
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch;

  return { fetch: fetchFn, phases };
}

describe("approval request v2 with distinct stable requester key", () => {
  test("parses v2 when requester matches header issuer and target key matches targetDid", () => {
    const parsed = parseApprovalRequest(v2Request, { issuer: requesterSigner.did });
    expect(parsed).toEqual(v2Request);
    expect(isApprovalRequestV2(parsed)).toBe(true);
    expect(approvalRequestRequester(parsed)).toBe(requesterSigner.did);
    expect(parsed.issuer).toBe(requesterSigner.did);
    expect(parsed.targetDid).toBe(targetSigner.did);

    // Without options.issuer, internal v2 consistency is validated.
    expect(parseApprovalRequest(v2Request)).toEqual(v2Request);
  });

  test("v2 accepts optional purpose, renewal, and invitation context shapes", () => {
    const withPurposeAndRenewal = parseApprovalRequest(
      { ...v2Request, purpose: "standing", renewal: { version: 1, leaseLifetimeSeconds: 7_776_000 } },
      { issuer: requesterSigner.did },
    );
    expect(withPurposeAndRenewal.purpose).toBe("standing");
    expect(withPurposeAndRenewal.renewal).toEqual({ version: 1, leaseLifetimeSeconds: 7_776_000 });

    const invitationSpec = buildShareInvitationApprovalSpec({
      targetDid: targetSigner.did,
      targetPublicJwk,
      nodeOrigin: "https://node.example",
      context: {
        kind: "share-invitation",
        version: 1,
        invitationId: "01HZX3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3",
        recipientEmail: "reader@example.com",
        subjectKind: "session",
        subjectName: "plan",
        acceptanceExpiresAt: new Date(NOW + 3_600_000).toISOString(),
        accessExpiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
      now: NOW,
    });
    const invitationV2 = parseApprovalRequest(
      {
        ...invitationSpec,
        issuer: requesterSigner.did,
        requestVersion: 2,
        requester: requesterSigner.did,
        resultEncryptionPublicJwk: relay.publicJwk,
      },
      { issuer: requesterSigner.did },
    );
    expect(isApprovalRequestV2(invitationV2)).toBe(true);
    expect(invitationV2.permissions).toEqual([]);
  });

  test("createApprovalRequest with explicit v2 body and requesterKey signs header with requester, returns normalized request, and round-trips", async () => {
    const transport = makeLinkTransport();
    const created = await createApprovalRequest({
      request: v2Request,
      issuerKey: targetSigner,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });

    expect(created.record.header.issuer).toBe(requesterSigner.did);
    expect(created.record.header.issuer).not.toBe(targetSigner.did);
    expect(created.request).toEqual(v2Request);

    const resolved = await resolveApprovalRequest(created.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });
    expect(isApprovalRequestV2(resolved.request)).toBe(true);
    expect(resolved.request).toEqual(v2Request);
    expect(resolved.header.issuer).toBe(requesterSigner.did);
    expect(approvalRequestRequester(resolved.request)).toBe(requesterSigner.did);

    // resolveLink runs the same validation pipeline on openkey-approval-request links.
    const opened = await resolveLink(created.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });
    expect(opened.value).toEqual(v2Request);
  });

  test("createApprovalRequest accepts explicit v2 with requesterKey alone and with issuerKey=requester", async () => {
    const t1 = makeLinkTransport();
    const c1 = await createApprovalRequest({
      request: v2Request,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: t1.fetch,
    });
    expect(c1.request).toEqual(v2Request);
    const r1 = await resolveApprovalRequest(c1.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: t1.fetch,
    });
    expect(r1.request).toEqual(v2Request);

    const t2 = makeLinkTransport();
    const c2 = await createApprovalRequest({
      request: v2Request,
      issuerKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: t2.fetch,
    });
    expect(c2.request).toEqual(v2Request);
    const r2 = await resolveApprovalRequest(c2.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: t2.fetch,
    });
    expect(r2.request).toEqual(v2Request);
  });

  test("phased OpenKey lifecycle for v2: discover signs with requesterSigningKey (pre-load and post-load), fetch and ack sign with target signingKey", async () => {
    const linkTransport = makeLinkTransport();
    const created = await createApprovalRequest({
      request: v2Request,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: linkTransport.fetch,
    });

    const resultRef = "synthetic-result-reference-v2-1234";
    const resultExpiresAt = new Date(NOW + 600_000).toISOString();
    const ackId = "ack-v2-phased-proof-01";
    const openkey = makePhasedOpenKey({
      link: created.link,
      linkTransport,
      requestId: created.id,
      resultRef,
      resultExpiresAt,
      loadAfterPreLoadPolls: 1,
    });

    const state: ApprovalRequesterState = {
      requestId: created.id,
      bodyCid: created.bodyCid,
      record: created.record,
      apiOrigin: OPENKEY_API_ORIGIN,
      signingKey: targetPrivateJwk,
      requesterSigningKey: requesterPrivateJwk,
    };

    // Direct proof check: discover verifies under requester (not target); fetch/ack verify under target (not requester).
    const discoverUrl = `${OPENKEY_API_ORIGIN}/api/approval-requests/${created.id}/result`;
    const fetchUrl = `${OPENKEY_API_ORIGIN}/api/approval-results/${resultRef}/fetch`;
    const ackUrl = `${OPENKEY_API_ORIGIN}/api/approval-results/${resultRef}/ack`;
    const discoverProof = approvalSessionProof(state, "discover");
    const fetchProof = approvalSessionProof(state, "fetch", resultRef);
    const ackProof = approvalSessionProof(state, "ack", resultRef, ackId);
    expect(verifySessionProof(discoverProof, requesterPublicJwk, { action: "discover", requestId: created.id, bodyCid: created.bodyCid, resultRef: "", ackId: "", url: discoverUrl })).toBe(true);
    expect(verifySessionProof(discoverProof, targetPublicJwk, { action: "discover", requestId: created.id, bodyCid: created.bodyCid, resultRef: "", ackId: "", url: discoverUrl })).toBe(false);
    expect(verifySessionProof(fetchProof, targetPublicJwk, { action: "fetch", requestId: created.id, bodyCid: created.bodyCid, resultRef, ackId: "", url: fetchUrl })).toBe(true);
    expect(verifySessionProof(fetchProof, requesterPublicJwk, { action: "fetch", requestId: created.id, bodyCid: created.bodyCid, resultRef, ackId: "", url: fetchUrl })).toBe(false);
    expect(verifySessionProof(ackProof, targetPublicJwk, { action: "ack", requestId: created.id, bodyCid: created.bodyCid, resultRef, ackId, url: ackUrl })).toBe(true);
    expect(verifySessionProof(ackProof, requesterPublicJwk, { action: "ack", requestId: created.id, bodyCid: created.bodyCid, resultRef, ackId, url: ackUrl })).toBe(false);

    // Full phased collection: pre-load discover (202) -> /load + approve -> post-load discover (200) -> fetch (200) -> ack (200).
    const collected = await collectApprovalResult(state, { fetch: openkey.fetch, sleep: async () => {} });
    expect(collected).toEqual({
      status: "result",
      resultRef,
      expiresAt: resultExpiresAt,
      relay: { version: 1, marker: "encrypted" },
    });
    expect(await ackApprovalResult(state, resultRef, ackId, { fetch: openkey.fetch })).toBe("acknowledged");
    expect(openkey.phases).toEqual([
      { phase: "discover-preload", verifiedBy: "header-issuer", status: 202 },
      { phase: "discover-postload", verifiedBy: "header-issuer", status: 200 },
      { phase: "fetch", verifiedBy: "target", status: 200 },
      { phase: "ack", verifiedBy: "target", status: 200 },
    ]);

    // Result binding binds requesterDid to requester and targetDid to target separately.
    const delegationExpiresAt = new Date(NOW + 3_600_000).toISOString();
    const goodResult = {
      resultVersion: 1,
      requestId: created.id,
      requestDigest: created.bodyCid,
      requesterDid: requesterSigner.did,
      targetDid: targetSigner.did,
      ownerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
      delegationExpiresAt,
      delegation: { marker: "ok" },
    };
    const bindingRequest = { issuer: created.request.issuer, targetDid: created.request.targetDid };
    expect(
      checkApprovalResultBinding(goodResult, { requestId: created.id, bodyCid: created.bodyCid, request: bindingRequest, now: NOW }),
    ).toEqual({ ownerDid: goodResult.ownerDid, delegationExpiresAt, delegation: { marker: "ok" } });

    expect(() =>
      checkApprovalResultBinding({ ...goodResult, requesterDid: targetSigner.did }, { requestId: created.id, bodyCid: created.bodyCid, request: bindingRequest, now: NOW }),
    ).toThrow(/requesterDid/);
    expect(() =>
      checkApprovalResultBinding({ ...goodResult, targetDid: requesterSigner.did }, { requestId: created.id, bodyCid: created.bodyCid, request: bindingRequest, now: NOW }),
    ).toThrow(/targetDid/);
  });

  test("approval client enforces requesterSigningKey on non-code-claim discover, allows fetch/ack without it, and signs code-claim discover with target key", async () => {
    const v2Transport = makeLinkTransport();
    const createdV2 = await createApprovalRequest({
      request: v2Request,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: v2Transport.fetch,
    });
    const v1Transport = makeLinkTransport();
    const createdV1 = await createApprovalRequest({
      request: v1Request,
      issuerKey: targetSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: v1Transport.fetch,
    });

    let calls = 0;
    const countingFetch = Object.assign(
      async () => { calls += 1; return new Response(null, { status: 500 }); },
      { preconnect: () => {} },
    ) as typeof globalThis.fetch;

    const found = { resultRef: "synthetic-result-reference-v2-1234", expiresAt: new Date(NOW + 600_000).toISOString() };

    // v2 without requesterSigningKey is refused on non-code-claim discover and collect (without known resultRef).
    const v2TargetOnly: ApprovalRequesterState = {
      requestId: createdV2.id, bodyCid: createdV2.bodyCid, record: createdV2.record, apiOrigin: OPENKEY_API_ORIGIN, signingKey: targetPrivateJwk,
    };
    expect((await clientRefusalOf(() => discoverApprovalResult(v2TargetOnly, { fetch: countingFetch }))).code).toBe("request_binding");
    expect((await clientRefusalOf(() => collectApprovalResult(v2TargetOnly, { fetch: countingFetch, sleep: async () => {} }))).code).toBe("request_binding");

    // v2 with wrong requesterSigningKey (target key or third key) is refused on discover, fetch, and ack.
    for (const badKey of [targetPrivateJwk, thirdPrivateJwk]) {
      const badState: ApprovalRequesterState = { ...v2TargetOnly, requesterSigningKey: badKey };
      expect((await clientRefusalOf(() => discoverApprovalResult(badState, { fetch: countingFetch }))).code).toBe("request_binding");
      expect((await clientRefusalOf(() => fetchApprovalResult(badState, found, { fetch: countingFetch }))).code).toBe("request_binding");
      expect((await clientRefusalOf(() => ackApprovalResult(badState, found.resultRef, "ack-bad-1", { fetch: countingFetch }))).code).toBe("request_binding");
      expect((await clientRefusalOf(() => discoverApprovalResult(badState, { fetch: countingFetch, approvalCode: "abcd-efgh", delegationClaim: "claim-intent-1234567890" }))).code).toBe("request_binding");
    }

    // v1 with requesterSigningKey (same key or different key) is refused.
    const v1Base: ApprovalRequesterState = {
      requestId: createdV1.id, bodyCid: createdV1.bodyCid, record: createdV1.record, apiOrigin: OPENKEY_API_ORIGIN, signingKey: targetPrivateJwk,
    };
    expect((await clientRefusalOf(() => discoverApprovalResult({ ...v1Base, requesterSigningKey: targetPrivateJwk }, { fetch: countingFetch }))).code).toBe("request_binding");
    expect((await clientRefusalOf(() => discoverApprovalResult({ ...v1Base, requesterSigningKey: requesterPrivateJwk }, { fetch: countingFetch }))).code).toBe("request_binding");
    expect((await clientRefusalOf(() => fetchApprovalResult({ ...v1Base, requesterSigningKey: requesterPrivateJwk }, found, { fetch: countingFetch }))).code).toBe("request_binding");

    // Code-claim discover without delegationClaim is refused before sending HTTP.
    expect((await clientRefusalOf(() => discoverApprovalResult(v2TargetOnly, { fetch: countingFetch, approvalCode: "abcd-efgh" }))).code).toBe("request_binding");

    expect(calls).toBe(0);

    // N2 + N1: a process holding ONLY the target key (no requesterSigningKey) can run fetch, ack,
    // collect(known), and code-claim discover; code-claim discover signs with the target key even when requesterSigningKey is present.
    const openkey = makePhasedOpenKey({
      link: createdV2.link,
      linkTransport: v2Transport,
      requestId: createdV2.id,
      resultRef: found.resultRef,
      resultExpiresAt: found.expiresAt,
      loadAfterPreLoadPolls: 1,
    });
    const v2WithRequester: ApprovalRequesterState = { ...v2TargetOnly, requesterSigningKey: requesterPrivateJwk };

    // Drive pre-load discover with requesterSigningKey so OpenKey loads & approves the v2 request.
    expect(await discoverApprovalResult(v2WithRequester, { fetch: openkey.fetch })).toEqual({ status: "pending" });

    // Code-claim discover signs with TARGET key even when requesterSigningKey is present, and also works without requesterSigningKey.
    const claim = "claim-intent-1234567890abcdef";
    const code = "ABCD-2345";
    const discoverUrl = `${OPENKEY_API_ORIGIN}/api/approval-requests/${createdV2.id}/result`;
    const expectedCodeBinding: readonly [string, string] = [
      createHash("sha256").update(code.trim().toLowerCase()).digest("base64url"),
      createHash("sha256").update(claim).digest("base64url"),
    ];
    const codeClaimProof = approvalSessionProof(v2WithRequester, "discover", "", "", expectedCodeBinding);
    expect(verifySessionProof(codeClaimProof, targetPublicJwk, { action: "discover", requestId: createdV2.id, bodyCid: createdV2.bodyCid, resultRef: "", ackId: "", url: discoverUrl, codeBinding: expectedCodeBinding })).toBe(true);
    expect(verifySessionProof(codeClaimProof, requesterPublicJwk, { action: "discover", requestId: createdV2.id, bodyCid: createdV2.bodyCid, resultRef: "", ackId: "", url: discoverUrl, codeBinding: expectedCodeBinding })).toBe(false);

    expect(await discoverApprovalResult(v2WithRequester, { fetch: openkey.fetch, approvalCode: code, delegationClaim: claim })).toEqual({
      status: "ready", resultRef: found.resultRef, expiresAt: found.expiresAt,
    });
    expect(await discoverApprovalResult(v2TargetOnly, { fetch: openkey.fetch, approvalCode: code, delegationClaim: claim })).toEqual({
      status: "ready", resultRef: found.resultRef, expiresAt: found.expiresAt,
    });

    // Fetch, collect(known), and ack all succeed on v2 WITHOUT requesterSigningKey.
    expect(await fetchApprovalResult(v2TargetOnly, found, { fetch: openkey.fetch })).toEqual({ version: 1, marker: "encrypted" });
    expect(await collectApprovalResult(v2TargetOnly, { fetch: openkey.fetch, known: found })).toEqual({
      status: "result", resultRef: found.resultRef, expiresAt: found.expiresAt, relay: { version: 1, marker: "encrypted" },
    });
    expect(await ackApprovalResult(v2TargetOnly, found.resultRef, "ack-target-only-01", { fetch: openkey.fetch })).toBe("acknowledged");

    expect(openkey.phases).toEqual([
      { phase: "discover-preload", verifiedBy: "header-issuer", status: 202 },
      { phase: "discover-code-claim", verifiedBy: "target", status: 200 },
      { phase: "discover-code-claim", verifiedBy: "target", status: 200 },
      { phase: "fetch", verifiedBy: "target", status: 200 },
      { phase: "fetch", verifiedBy: "target", status: 200 },
      { phase: "ack", verifiedBy: "target", status: 200 },
    ]);
  });
});

describe("refusals: binding mismatches, unknown versions, malformed requester DIDs, and createApprovalRequest guards", () => {
  test("refuses v2 when header issuer is the target key or a third key", async () => {
    expect(refusalOf(() => parseApprovalRequest(v2Request, { issuer: targetSigner.did })).code).toBe("issuer_binding_mismatch");
    expect(refusalOf(() => parseApprovalRequest(v2Request, { issuer: thirdSigner.did })).code).toBe("issuer_binding_mismatch");

    // Body issuer disagrees with requester.
    expect(refusalOf(() => parseApprovalRequest({ ...v2Request, issuer: targetSigner.did }, { issuer: targetSigner.did })).code).toBe("issuer_binding_mismatch");
    expect(refusalOf(() => parseApprovalRequest({ ...v2Request, issuer: thirdSigner.did }, { issuer: thirdSigner.did })).code).toBe("issuer_binding_mismatch");

    // End-to-end link resolution: v2 body sealed inside a link signed by target or third key.
    for (const [label, body, headerSigner] of [
      ["v2 body with requester issuer signed by target", v2Request, targetSigner],
      ["v2 body with target issuer and requester field signed by target", { ...v2Request, issuer: targetSigner.did }, targetSigner],
      ["v2 body with requester issuer signed by third key", v2Request, thirdSigner],
      ["v2 body with third issuer and requester field signed by third key", { ...v2Request, issuer: thirdSigner.did }, thirdSigner],
    ] as const) {
      const prepared = await prepareLinkRecord({
        type: "openkey-approval-request",
        issuerKey: headerSigner,
        apiOrigin: API_ORIGIN,
        now: NOW,
        expiresAt: new Date(NOW + 3_600_000),
        plaintext: new TextEncoder().encode(canonicalize(body)),
      });
      const transport = makeLinkTransport();
      transport.setStored(prepared.record);
      const link = buildShortLink({
        origin: OPENKEY_ORIGIN,
        type: "openkey-approval-request",
        id: LINK_ID,
        key: prepared.key,
        bodyCid: prepared.bodyCid,
      });
      const err = await asyncRefusalOf(() =>
        resolveApprovalRequest(link, { trustedOrigins: [OPENKEY_ORIGIN], apiOrigin: API_ORIGIN, now: NOW, fetch: transport.fetch }),
      );
      expect(err.code, label).toBe("issuer_binding_mismatch");
    }
  });

  test("refuses v2 when requester === targetDid (same-key requests must use v1, no fallback)", async () => {
    const sameKeyV2 = {
      ...v2Request,
      issuer: targetSigner.did,
      requester: targetSigner.did,
      targetDid: targetSigner.did,
      targetPublicJwk,
    };
    expect(refusalOf(() => parseApprovalRequest(sameKeyV2, { issuer: targetSigner.did })).code).toBe("issuer_binding_mismatch");
    expect(refusalOf(() => parseApprovalRequest(sameKeyV2)).code).toBe("issuer_binding_mismatch");

    const transport = makeLinkTransport();
    const err = await asyncRefusalOf(() =>
      createApprovalRequest({
        request: sameKeyV2,
        requesterKey: targetSigner,
        apiOrigin: API_ORIGIN,
        openkeyOrigin: OPENKEY_ORIGIN,
        now: NOW,
        fetch: transport.fetch,
      }),
    );
    expect(err.code).toBe("issuer_binding_mismatch");
    expect(transport.getPosts()).toBe(0);
  });

  test("refuses v2 when targetPublicJwk does not match targetDid or carries private material", () => {
    expect(
      refusalOf(() => parseApprovalRequest({ ...v2Request, targetDid: thirdSigner.did }, { issuer: requesterSigner.did })).code,
    ).toBe("issuer_binding_mismatch");
    expect(
      refusalOf(() => parseApprovalRequest({ ...v2Request, targetPublicJwk: requesterPublicJwk }, { issuer: requesterSigner.did })).code,
    ).toBe("issuer_binding_mismatch");
    expect(
      refusalOf(() => parseApprovalRequest({ ...v2Request, targetPublicJwk: { ...targetPublicJwk, d: targetPrivateJwk.d } }, { issuer: requesterSigner.did })).code,
    ).toBe("body_validation_failed");
  });

  test("refuses unknown or inherited request versions and v2 without requester", () => {
    for (const version of [0, 3, -1, 1.5, "1", "2", null, undefined, true, [2], {}]) {
      expect(refusalOf(() => parseApprovalRequest({ ...v1Request, requestVersion: version })).code).toBe("body_validation_failed");
      expect(refusalOf(() => parseApprovalRequest({ ...v2Request, requestVersion: version })).code).toBe("body_validation_failed");
    }
    const { requestVersion: _ver, ...v2NoVersion } = v2Request;
    const inheritedVersion = Object.assign(Object.create({ requestVersion: 2 }), v2NoVersion);
    expect(refusalOf(() => parseApprovalRequest(inheritedVersion, { issuer: requesterSigner.did })).code).toBe("body_validation_failed");

    const { requester: _omitted, ...v2WithoutRequester } = v2Request;
    expect(refusalOf(() => parseApprovalRequest(v2WithoutRequester, { issuer: requesterSigner.did })).code).toBe("body_validation_failed");
    expect(refusalOf(() => parseApprovalRequest({ ...v2Request, extra: true }, { issuer: requesterSigner.did })).code).toBe("body_validation_failed");
  });

  test("refuses malformed requester DIDs (only canonical prime-order Ed25519 did:key is accepted)", () => {
    // Non-Ed25519 multicodec prefixes: P-256 (0x80 0x24), X25519 (0xec 0x01), secp256k1.
    const p256Did = `did:key:${base58btc.encode(Uint8Array.of(0x80, 0x24, ...new Uint8Array(33).fill(2)))}`;
    const x25519Did = `did:key:${base58btc.encode(Uint8Array.of(0xec, 0x01, ...new Uint8Array(32).fill(3)))}`;
    const secp256k1Did = "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme";
    // Wrong key length (31 bytes and 33 bytes under Ed25519 multicodec 0xed 0x01).
    const shortEd25519Did = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...new Uint8Array(31).fill(4)))}`;
    const longEd25519Did = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...new Uint8Array(33).fill(4)))}`;
    // Weak (identity point: 0x01 followed by 31 zero bytes, order 1) and non-canonical (all 0xff, y >= p).
    const weakPoint = new Uint8Array(32);
    weakPoint[0] = 1;
    const weakDid = didKeyFromEd25519PublicKey(weakPoint);
    const nonCanonicalDid = didKeyFromEd25519PublicKey(new Uint8Array(32).fill(0xff));

    const badRequesters: unknown[] = [
      "",
      "not-a-did",
      "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
      "did:web:example.com",
      "service:openkey",
      "did:key:z0invalidbase58",
      `${requesterSigner.did}#${requesterSigner.did.slice(8)}`,
      ` ${requesterSigner.did}`,
      `${requesterSigner.did} `,
      p256Did,
      x25519Did,
      secp256k1Did,
      shortEd25519Did,
      longEd25519Did,
      weakDid,
      nonCanonicalDid,
      123,
      null,
      undefined,
    ];
    for (const requester of badRequesters) {
      const err = refusalOf(() => parseApprovalRequest({ ...v2Request, issuer: String(requester), requester }));
      expect(err.code, `requester=${String(requester)}`).toBe("body_validation_failed");
    }
  });

  test("createApprovalRequest refuses v1 bodies with requesterKey and refuses mismatched signers before sending HTTP", async () => {
    const transport = makeLinkTransport();

    // v1 body with requesterKey must be refused (no silent rewrite to v2).
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: v1Request,
          issuerKey: targetSigner,
          requesterKey: requesterSigner,
          apiOrigin: API_ORIGIN,
          openkeyOrigin: OPENKEY_ORIGIN,
          now: NOW,
          fetch: transport.fetch,
        }),
      )).code,
    ).toBe("body_validation_failed");

    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: v1Request,
          requesterKey: requesterSigner,
          apiOrigin: API_ORIGIN,
          openkeyOrigin: OPENKEY_ORIGIN,
          now: NOW,
          fetch: transport.fetch,
        }),
      )).code,
    ).toBe("body_validation_failed");

    // Third-party issuerKey alongside requesterKey on a v2 request.
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: v2Request,
          issuerKey: thirdSigner,
          requesterKey: requesterSigner,
          apiOrigin: API_ORIGIN,
          openkeyOrigin: OPENKEY_ORIGIN,
          now: NOW,
          fetch: transport.fetch,
        }),
      )).code,
    ).toBe("issuer_binding_mismatch");

    // v2 request naming requesterSigner but signed with thirdSigner as requesterKey.
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: v2Request,
          requesterKey: thirdSigner,
          apiOrigin: API_ORIGIN,
          openkeyOrigin: OPENKEY_ORIGIN,
          now: NOW,
          fetch: transport.fetch,
        }),
      )).code,
    ).toBe("issuer_binding_mismatch");

    // v2 request signed with targetSigner as issuerKey (no requesterKey).
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: v2Request,
          issuerKey: targetSigner,
          apiOrigin: API_ORIGIN,
          openkeyOrigin: OPENKEY_ORIGIN,
          now: NOW,
          fetch: transport.fetch,
        }),
      )).code,
    ).toBe("issuer_binding_mismatch");

    expect(transport.getPosts()).toBe(0);
  });
});

describe("approval request v1 remains unchanged", () => {
  test("without requesterKey, createApprovalRequest emits v1 byte-for-byte and completes the full phased OpenKey lifecycle with one key", async () => {
    const transport = makeLinkTransport();
    const created = await createApprovalRequest({
      request: v1Request,
      issuerKey: targetSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });
    expect(created.record.header.issuer).toBe(targetSigner.did);
    expect(created.request).toEqual(v1Request);

    const parsedLink = parseLink(created.link, { trustedOrigins: [OPENKEY_ORIGIN] });
    expect(parsedLink.form).toBe("short");
    const opened = await openLinkRecord(created.record, (parsedLink as { key: Uint8Array }).key, { now: NOW });
    expect(new TextDecoder().decode(opened.plaintext)).toBe(canonicalize(v1Request));
    expect("requester" in opened.value).toBe(false);

    const resolved = await resolveApprovalRequest(created.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });
    expect(isApprovalRequestV2(resolved.request)).toBe(false);
    expect(approvalRequestRequester(resolved.request)).toBe(targetSigner.did);
    expect(resolved.request).toEqual(v1Request);

    // v1 works through the phased OpenKey mock with only signingKey (no requesterSigningKey).
    const resultRef = "synthetic-result-reference-v1-1234";
    const resultExpiresAt = new Date(NOW + 600_000).toISOString();
    const openkey = makePhasedOpenKey({
      link: created.link,
      linkTransport: transport,
      requestId: created.id,
      resultRef,
      resultExpiresAt,
      loadAfterPreLoadPolls: 1,
    });
    const state: ApprovalRequesterState = {
      requestId: created.id,
      bodyCid: created.bodyCid,
      record: created.record,
      apiOrigin: OPENKEY_API_ORIGIN,
      signingKey: targetPrivateJwk,
    };
    const collected = await collectApprovalResult(state, { fetch: openkey.fetch, sleep: async () => {} });
    expect(collected.status).toBe("result");
    expect(await ackApprovalResult(state, resultRef, "ack-v1-01", { fetch: openkey.fetch })).toBe("acknowledged");
    expect(openkey.phases).toEqual([
      { phase: "discover-preload", verifiedBy: "header-issuer", status: 202 },
      { phase: "discover-postload", verifiedBy: "target", status: 200 },
      { phase: "fetch", verifiedBy: "target", status: 200 },
      { phase: "ack", verifiedBy: "target", status: 200 },
    ]);
  });

  test("v1 does not relax issuer === targetDid and rejects a requester field", () => {
    // Separate issuer on v1 is refused even when options.issuer matches request.issuer.
    expect(
      refusalOf(() => parseApprovalRequest({ ...v1Request, issuer: requesterSigner.did }, { issuer: requesterSigner.did })).code,
    ).toBe("issuer_binding_mismatch");
    // Header issuer mismatch on v1 is refused.
    expect(refusalOf(() => parseApprovalRequest(v1Request, { issuer: requesterSigner.did })).code).toBe("issuer_binding_mismatch");
    // Extra requester field on v1 is refused by strict schema.
    expect(
      refusalOf(() => parseApprovalRequest({ ...v1Request, requester: requesterSigner.did }, { issuer: targetSigner.did })).code,
    ).toBe("body_validation_failed");
  });
});
