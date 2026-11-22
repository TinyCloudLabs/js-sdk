import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { base58btc } from "multiformats/bases/base58";
import { canonicalize } from "../src/jcs.js";
import { didKeyFromEd25519PublicKey } from "../src/didkey.js";
import {
  ackApprovalResult,
  approvalRequestRequester,
  approvalSessionProof,
  buildShareInvitationApprovalSpec,
  buildShortLink,
  checkApprovalResultBinding,
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
  type Ed25519PrivateJwk,
  type LinkRecord,
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

  test("createApprovalRequest with requesterKey signs header with requester, emits v2, and round-trips through resolveApprovalRequest", async () => {
    const transport = makeLinkTransport();
    const created = await createApprovalRequest({
      request: v1Request,
      issuerKey: targetSigner,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });

    expect(created.record.header.issuer).toBe(requesterSigner.did);
    expect(created.record.header.issuer).not.toBe(targetSigner.did);

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

  test("createApprovalRequest accepts requesterKey without issuerKey and also accepts an explicit v2 request with issuerKey=requester", async () => {
    const t1 = makeLinkTransport();
    const c1 = await createApprovalRequest({
      request: v1Request,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: t1.fetch,
    });
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
    const r2 = await resolveApprovalRequest(c2.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: t2.fetch,
    });
    expect(r2.request).toEqual(v2Request);
  });

  test("discover, fetch, and ack proofs verify against the target key (not the requester key) and result binding checks both DIDs", async () => {
    const transport = makeLinkTransport();
    const created = await createApprovalRequest({
      request: v1Request,
      issuerKey: targetSigner,
      requesterKey: requesterSigner,
      apiOrigin: API_ORIGIN,
      openkeyOrigin: OPENKEY_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });
    const resolved = await resolveApprovalRequest(created.link, {
      trustedOrigins: [OPENKEY_ORIGIN],
      apiOrigin: API_ORIGIN,
      now: NOW,
      fetch: transport.fetch,
    });

    const resultRef = "synthetic-result-reference-v2-1234";
    const resultExpiresAt = new Date(NOW + 600_000).toISOString();
    const ackId = "ack-v2-target-proof-01";
    const verifiedUnderTarget: string[] = [];
    const verifiedUnderRequester: boolean[] = [];

    const verifyProofUnder = (proof: string, jwk: { kty: "OKP"; crv: "Ed25519"; x: string }, action: string, url: string, ref: string, ack: string) => {
      const [h, p, s] = proof.split(".");
      const parsedHeader = JSON.parse(Buffer.from(h!, "base64url").toString("utf8")) as Record<string, unknown>;
      const claims = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, unknown>;
      const jkt = createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x })).digest("base64url");
      const credHash = createHash("sha256")
        .update(JSON.stringify([action, created.id, created.bodyCid, ref, ack]))
        .digest("base64url");
      return (
        verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s!, "base64url")) &&
        parsedHeader.kid === jkt &&
        claims.htu === url &&
        claims.cred_hash === credHash
      );
    };

    const openkeyFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string>;
        const proof = headers["OpenKey-Session-Proof"]!;
        const action = url.endsWith("/result") ? "discover" : url.endsWith("/fetch") ? "fetch" : "ack";
        const ref = action === "discover" ? "" : resultRef;
        const ack = action === "ack" ? ackId : "";
        if (verifyProofUnder(proof, resolved.request.targetPublicJwk, action, url, ref, ack)) {
          verifiedUnderTarget.push(action);
        }
        verifiedUnderRequester.push(verifyProofUnder(proof, requesterPublicJwk, action, url, ref, ack));
        if (action === "discover") return Response.json({ resultRef, expiresAt: resultExpiresAt });
        if (action === "fetch") return Response.json({ requestId: created.id, bodyCid: created.bodyCid, resultRef, expiresAt: resultExpiresAt, relay: { version: 1 } });
        return Response.json({ ackId, status: "acknowledged" });
      },
      { preconnect: () => {} },
    ) as typeof globalThis.fetch;

    // Requester state signs discover/fetch/ack with the TARGET key while record.header is signed by requester.
    const state = {
      requestId: created.id,
      bodyCid: created.bodyCid,
      record: created.record,
      apiOrigin: OPENKEY_API_ORIGIN,
      signingKey: targetPrivateJwk,
    };

    expect(approvalSessionProof(state, "discover").split(".")).toHaveLength(3);
    const discovered = await discoverApprovalResult(state, { fetch: openkeyFetch });
    expect(discovered).toEqual({ status: "ready", resultRef, expiresAt: resultExpiresAt });
    await fetchApprovalResult(state, { resultRef, expiresAt: resultExpiresAt }, { fetch: openkeyFetch });
    expect(await ackApprovalResult(state, resultRef, ackId, { fetch: openkeyFetch })).toBe("acknowledged");

    expect(verifiedUnderTarget).toEqual(["discover", "fetch", "ack"]);
    expect(verifiedUnderRequester).toEqual([false, false, false]);

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
    const bindingRequest = { issuer: resolved.request.issuer, targetDid: resolved.request.targetDid };
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
});

describe("refusals: binding mismatches, unknown versions, and malformed requester DIDs", () => {
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

  test("refuses v2 when requester === targetDid (same-key requests must use v1)", async () => {
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
        request: v1Request,
        issuerKey: targetSigner,
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

  test("refuses unknown request versions and v2 without requester", () => {
    for (const version of [0, 3, -1, 1.5, "1", "2", null, undefined]) {
      expect(refusalOf(() => parseApprovalRequest({ ...v1Request, requestVersion: version })).code).toBe("body_validation_failed");
      expect(refusalOf(() => parseApprovalRequest({ ...v2Request, requestVersion: version })).code).toBe("body_validation_failed");
    }
    const { requester: _omitted, ...v2WithoutRequester } = v2Request;
    expect(refusalOf(() => parseApprovalRequest(v2WithoutRequester, { issuer: requesterSigner.did })).code).toBe("body_validation_failed");
    expect(refusalOf(() => parseApprovalRequest({ ...v2Request, extra: true }, { issuer: requesterSigner.did })).code).toBe("body_validation_failed");
  });

  test("refuses malformed requester DIDs (only canonical prime-order Ed25519 did:key is accepted)", () => {
    // Non-Ed25519 multicodec prefixes: P-256 (0x80 0x24) and X25519 (0xec 0x01).
    const p256Did = `did:key:${base58btc.encode(Uint8Array.of(0x80, 0x24, ...new Uint8Array(33).fill(2)))}`;
    const x25519Did = `did:key:${base58btc.encode(Uint8Array.of(0xec, 0x01, ...new Uint8Array(32).fill(3)))}`;
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
      ` ${requesterSigner.did}`,
      `${requesterSigner.did} `,
      p256Did,
      x25519Did,
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

  test("createApprovalRequest refuses mismatched signers before sending any HTTP request", async () => {
    const transport = makeLinkTransport();
    // Third-party issuerKey alongside requesterKey.
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: v1Request,
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

    // v1 request carrying a spurious requester field with requesterKey.
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: { ...v1Request, requester: thirdSigner.did } as OpenKeyApprovalRequestV1,
          requesterKey: requesterSigner,
          apiOrigin: API_ORIGIN,
          openkeyOrigin: OPENKEY_ORIGIN,
          now: NOW,
          fetch: transport.fetch,
        }),
      )).code,
    ).toBe("body_validation_failed");

    // v1 request naming a third-party issuer with requesterKey.
    expect(
      (await asyncRefusalOf(() =>
        createApprovalRequest({
          request: { ...v1Request, issuer: thirdSigner.did },
          requesterKey: requesterSigner,
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
  test("without requesterKey, createApprovalRequest emits v1 byte-for-byte with no requester field", async () => {
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
