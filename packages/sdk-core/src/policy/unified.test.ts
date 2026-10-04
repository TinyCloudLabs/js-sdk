import { describe, expect, test } from "bun:test";
import { authorizationVerdictOf } from "@tinycloud/sdk-services";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  contentSourceDigestHex,
  compactAttenuationContains,
  createCompactPolicyDescendant,
  createCompactPolicyInvocation,
  jcsCanonicalize,
  getPolicyRootStatusV3,
  mintPolicySessionV3,
  normalizeUnifiedPolicyCapability,
  parsePolicySessionUcan,
  parseCompactUcanAuthorization,
  policyDigestHex,
  policyIdForDigestHex,
  ROOT_REVOCATION_V1_DOMAIN,
  requestPolicyChallengeV3,
  ROOT_STATUS_V1_DOMAIN,
  revokePolicyRootV3,
  signCompactPolicyDescendant,
  signCompactUcanAuthorization,
  signCompactUcanRootAuthorization,
  projectUnifiedPolicyCapability,
  unifiedNativeProjectionHashHex,
  unifiedPolicyCapabilityContains,
  unifiedPolicyCapabilityDigestHex,
  unifiedPolicyCapabilityFromNative,
  verifyPolicyRootStatusCheckpointV3,
  verifyPolicyRootRevocationV3,
} from "./index";

const kv = {
  kind: "kv" as const,
  resource: "tinycloud://space/kv/docs/a",
  selector: "exact" as const,
  actions: ["tinycloud.kv/put", "tinycloud.kv/get"] as const,
};

describe("TC-405 unified policy contracts", () => {
  test("authors long-lived proofless roots without widening invocation TTL", async () => {
    const privateKey = new Uint8Array(32).fill(17);
    const publicKey = ed25519.getPublicKey(privateKey);
    const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
    const root = await signCompactUcanRootAuthorization({
      issuerDid: ownerDid,
      audienceDid: "did:tinycloud:policy:root",
      attenuation: { "tinycloud://space/kv/docs/a": { "tinycloud.kv/get": [{}] } },
      facts: [{ role: "policy-authority" }],
      notBefore: 1_800_000_000,
      expiresAt: 1_800_086_400,
      nonce: "root-authorization",
      sign: async (bytes) => ed25519.sign(bytes, privateKey),
    });
    expect(root.payload.prf).toEqual([]);
    expect(root.payload.exp - root.payload.nbf).toBe(86_400);
    await expect(signCompactUcanAuthorization({
      issuerDid: ownerDid,
      audienceDid: root.payload.aud,
      attenuation: root.payload.att,
      facts: [root.payload.fct[0]],
      proofs: [],
      notBefore: root.payload.nbf,
      expiresAt: root.payload.exp,
      nonce: root.payload.nnc,
      sign: async (bytes) => ed25519.sign(bytes, privateKey),
    })).rejects.toThrow("60 seconds");
  });
  test("matches the Rust canonicalization and content-source vectors", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/canonicalization.json`,
    ).json()) as any;
    expect(jcsCanonicalize(normalizeUnifiedPolicyCapability(kv))).toBe(
      Buffer.from(vector.vectors[0].canonicalJcsUtf8Hex, "hex").toString(
        "utf8",
      ),
    );
    expect(unifiedPolicyCapabilityDigestHex(kv)).toBe(
      vector.vectors[0].policyCapabilityDigestHex,
    );
    expect(contentSourceDigestHex(vector.contentSource)).toBe(
      vector.contentSourceDigestHex,
    );
  });

  test("projects KV selector caveats and exact encryption resources", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/projection.json`,
    ).json()) as any;
    const projected = projectUnifiedPolicyCapability(
      vector.vectors[0].policyCapability,
    );
    expect(projected).toEqual(vector.vectors[0].nativeCapability);
    expect(
      unifiedNativeProjectionHashHex([vector.vectors[0].policyCapability]),
    ).toBe(vector.vectors[0].nativeProjectionHashHex);
    expect(unifiedPolicyCapabilityFromNative(projected)).toEqual(
      vector.vectors[0].policyCapability,
    );
    expect(
      unifiedPolicyCapabilityContains(
        vector.vectors[1].authorized,
        vector.vectors[1].requested,
      ),
    ).toBe(true);
    expect(
      unifiedPolicyCapabilityContains(
        vector.vectors[2].authorized,
        vector.vectors[2].requested,
      ),
    ).toBe(false);
    expect(
      unifiedPolicyCapabilityContains(
        vector.vectors[3].authorized,
        vector.vectors[3].requested,
      ),
    ).toBe(false);
  });

  test("preserves native TinyCloud KV resources through policy projection", () => {
    const resource = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications/kv/shares/report.md";
    const capability = { kind: "kv" as const, resource, selector: "exact" as const, actions: ["tinycloud.kv/get"] as const };
    const projected = projectUnifiedPolicyCapability(capability);
    expect(projected).toEqual({
      service: "tinycloud.kv",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
      path: "shares/report.md",
      actions: ["tinycloud.kv/get"],
      caveat: { type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource },
    });
    expect(unifiedPolicyCapabilityFromNative(projected)).toEqual(capability);
  });

  test("uses one segment-bounded selector containment rule for descendants", () => {
    const root = "tinycloud://space/kv/shares/root";
    const caveat = (kind: "exact" | "prefix", value: string) => [{
      type: "xyz.tinycloud.resource/selector",
      kind,
      value,
    }];
    const parent = { [root]: { "tinycloud.kv/get": caveat("prefix", root) } };
    expect(compactAttenuationContains(parent, {
      [root]: { "tinycloud.kv/get": caveat("exact", root) },
    })).toBe(true);
    expect(compactAttenuationContains(parent, {
      [`${root}/folder/document.txt`]: { "tinycloud.kv/get": caveat("exact", `${root}/folder/document.txt`) },
    })).toBe(true);
    expect(compactAttenuationContains(parent, {
      [`${root}-sibling`]: { "tinycloud.kv/get": caveat("exact", `${root}-sibling`) },
    })).toBe(false);
    expect(compactAttenuationContains(parent, {
      [`${root}/folder`]: { "tinycloud.kv/put": caveat("exact", `${root}/folder`) },
    })).toBe(false);
  });

  test("verifies current root checkpoints before lifecycle clients trust them", () => {
    const privateKey = new Uint8Array(32).fill(23);
    const publicKey = ed25519.getPublicKey(privateKey);
    const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
    const unsigned = {
      schema: "xyz.tinycloud.policy/root-status/v1",
      targetCid: "bafy-root",
      targetRole: "policy-authority",
      ownerDid: "did:key:zOwner",
      nodeAudience: nodeDid,
      state: "active",
      sequence: 1,
      checkedAt: "2026-07-31T00:00:00Z",
      freshUntil: "2026-07-31T00:05:00Z",
      issuerDid: nodeDid,
    };
    const signature = ed25519.sign(sha256(new TextEncoder().encode(`${ROOT_STATUS_V1_DOMAIN}${jcsCanonicalize(unsigned)}`)), privateKey);
    const checkpoint = { ...unsigned, signature: { suite: "Ed25519", signerDid: nodeDid, value: Buffer.from(signature).toString("base64url") } };
    const now = new Date("2026-07-31T00:01:00Z");
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-root", checkpoint, expectedNodeAudience: nodeDid, now })).toBe(true);
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-other", checkpoint, expectedNodeAudience: nodeDid, now })).toBe(false);
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-root", checkpoint: { ...checkpoint, sequence: 2 }, expectedNodeAudience: nodeDid, now })).toBe(false);
    expect(verifyPolicyRootStatusCheckpointV3({ rootCid: "bafy-root", checkpoint, expectedNodeAudience: nodeDid, now: new Date("2026-07-31T00:06:00Z") })).toBe(false);
  });

  test("binds mint responses to the exact ordered roots and requested attenuation", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const input = {
      nodeOrigin: "https://node.example",
      policyCid: vector.policy.policyCid as string,
      policyRootCid: vector.policyRoot.cid as string,
      enforcementRootCid: vector.enforcementRoot.cid as string,
      recipientDid: vector.principals.recipientDid as string,
      requestedCapabilities: vector.policy.value.capabilityCeiling,
      claim: {},
      presentation: {},
      challenge: { challengeId: "challenge-405", nonce: "session-405", policyCid: vector.policy.policyCid, recipientDid: vector.principals.recipientDid },
      fetch: (async () => new Response(JSON.stringify({ admitted: true, sessionCid: vector.s0.cid, authorization: vector.s0.authorization }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    };
    await expect(mintPolicySessionV3(input)).resolves.toMatchObject({ cid: vector.s0.cid });
    await expect(mintPolicySessionV3({ ...input, policyRootCid: vector.enforcementRoot.cid, enforcementRootCid: vector.policyRoot.cid })).rejects.toThrow("ordered proofs");
    await expect(mintPolicySessionV3({ ...input, requestedCapabilities: vector.policy.value.capabilityCeiling.slice(0, 1) })).rejects.toThrow("signed binding");
  });

  test("verifies the exact revocation referenced by a revoked checkpoint", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const revocation = vector.revocation.value as Record<string, unknown>;
    const checkpoint = {
      targetRole: revocation.targetRole,
      ownerDid: revocation.ownerDid,
      nodeAudience: revocation.nodeAudience,
      revokedAt: revocation.revokedAt,
      revocationCid: vector.revocation.signatureDigestHex,
    };
    expect(verifyPolicyRootRevocationV3({ rootCid: revocation.targetCid as string, checkpoint, revocation, expectedEnforcerDid: vector.principals.enforcerDid })).toBe(true);
    expect(verifyPolicyRootRevocationV3({ rootCid: revocation.targetCid as string, checkpoint, revocation: { ...revocation, reason: "substituted" }, expectedEnforcerDid: vector.principals.enforcerDid })).toBe(false);
  });

  test("derives policy IDs from the additive v1 digest", () => {
    const unsigned = {
      schema: "xyz.tinycloud.policy/policy/v1" as const,
      ownerDid: "did:key:zowner",
      createdAt: "2026-07-31T00:00:00Z",
      contentSource: {
        shareId: "share-1",
        kvResource: "tinycloud://space/kv/docs/a",
        selector: "exact" as const,
        encryptionNetwork: "urn:tinycloud:encryption:did:key:zowner:default",
        encryptedSymmetricKeyDigestHex: "a".repeat(64),
        keyVersion: 1,
        mode: "immutable" as const,
        initialCiphertextDigestHex: "b".repeat(64),
      },
      capabilityCeiling: [kv],
    };
    const digest = policyDigestHex(unsigned);
    expect(policyIdForDigestHex(digest)).toBe(
      "pol_cj523vzxd2ly7y6utaqgmc6e6xj5rwnlyvlrcjdouasgp6fkc5jq",
    );
  });

  test("verifies exact compact Authorization bytes, ordered proofs, signature, and CID", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const session = parsePolicySessionUcan(vector.s0.authorization, [
      vector.policyRoot.cid,
      vector.enforcementRoot.cid,
    ]);
    expect(session.cid).toBe(vector.s0.cid);
    expect(session.prf).toEqual([vector.policyRoot.cid, vector.enforcementRoot.cid]);
    expect(session.fact.contentSourceDigestHex).toBe(
      vector.projections.contentSourceDigestHex,
    );
    expect(() =>
      parsePolicySessionUcan(vector.s0.authorization, [
        vector.enforcementRoot.cid,
        vector.policyRoot.cid,
      ]),
    ).toThrow();
    const mutated = `${vector.s0.authorization.slice(0, -1)}${vector.s0.authorization.endsWith("A") ? "B" : "A"}`;
    expect(() => parsePolicySessionUcan(mutated)).toThrow();

    const s1 = parseCompactUcanAuthorization(vector.s1.authorization);
    const descendant = createCompactPolicyDescendant({
      parentAuthorization: vector.s0.authorization,
      parentCid: vector.s0.cid,
      issuerDid: vector.principals.recipientDid,
      audienceDid: s1.payload.aud,
      attenuation: s1.payload.att,
      privateKey: new Uint8Array(32).fill(9),
      now: s1.payload.nbf,
      expiresAt: s1.payload.exp,
      nonce: s1.payload.nnc,
    });
    expect(descendant.authorization).toBe(vector.s1.authorization);
    expect(descendant.cid).toBe(vector.s1.cid);

    const invocation = createCompactPolicyInvocation({
      sessionAuthorization: vector.s0.authorization,
      sessionCid: vector.s0.cid,
      recipientDid: vector.principals.recipientDid,
      audienceDid: vector.principals.nodeDid,
      resource: vector.policy.value.contentSource.kvResource,
      action: "tinycloud.kv/get",
      caveat: { type: "xyz.tinycloud.resource/selector", kind: "exact", value: vector.policy.value.contentSource.kvResource },
      privateKey: new Uint8Array(32).fill(9),
      now: session.nbf + 1,
      nonce: "fresh-invocation-405",
    });
    expect(invocation.payload.prf).toEqual([vector.s0.cid]);
    expect(invocation.authorization).not.toBe(vector.s0.authorization);

    const callbackSigned = await signCompactUcanAuthorization({
      issuerDid: vector.principals.recipientDid,
      audienceDid: vector.principals.nodeDid,
      attenuation: invocation.payload.att,
      facts: [invocation.payload.fct[0]],
      proofs: [vector.s0.cid],
      notBefore: invocation.payload.nbf,
      expiresAt: invocation.payload.exp,
      nonce: invocation.payload.nnc,
      sign: async (bytes) => ed25519.sign(bytes, new Uint8Array(32).fill(9)),
    });
    expect(callbackSigned.authorization).toBe(invocation.authorization);
    expect(callbackSigned.cid).toBe(invocation.cid);
  });

  test("accepts exactly legacy facts or the complete validated v4 audit pair", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const legacy = parsePolicySessionUcan(vector.s0.authorization);
    expect(legacy.fact.credentialIdAuditDigestHex).toBeUndefined();
    expect(legacy.fact.presentationJtiAuditDigestHex).toBeUndefined();

    const parsed = parseCompactUcanAuthorization(vector.s0.authorization);
    const privateKey = new Uint8Array(32).fill(29);
    const publicKey = ed25519.getPublicKey(privateKey);
    const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
    const signWithFacts = async (additionalFacts: Readonly<Record<string, unknown>>) => (await signCompactUcanAuthorization({
      issuerDid: nodeDid,
      audienceDid: parsed.payload.aud,
      attenuation: parsed.payload.att,
      facts: [{ ...parsed.payload.fct[0]!, nodeAudience: nodeDid, ...additionalFacts }],
      proofs: parsed.payload.prf,
      notBefore: parsed.payload.nbf,
      expiresAt: parsed.payload.exp,
      nonce: parsed.payload.nnc,
      sign: async (bytes) => ed25519.sign(bytes, privateKey),
    })).authorization;

    const v4 = parsePolicySessionUcan(await signWithFacts({
      credentialIdAuditDigestHex: "a".repeat(64),
      presentationJtiAuditDigestHex: "b".repeat(64),
    }));
    expect(v4.fact.credentialIdAuditDigestHex).toBe("a".repeat(64));
    expect(v4.fact.presentationJtiAuditDigestHex).toBe("b".repeat(64));

    const partial = await signWithFacts({
      credentialIdAuditDigestHex: "a".repeat(64),
    });
    expect(() => parsePolicySessionUcan(partial)).toThrow("incomplete");
    const malformed = await signWithFacts({
      credentialIdAuditDigestHex: "A".repeat(64),
      presentationJtiAuditDigestHex: "b".repeat(64),
    });
    expect(() => parsePolicySessionUcan(malformed)).toThrow("audit facts");
    const unknown = await signWithFacts({
      credentialIdAuditDigestHex: "a".repeat(64),
      presentationJtiAuditDigestHex: "b".repeat(64),
      unknownAuditFact: "c".repeat(64),
    });
    expect(() => parsePolicySessionUcan(unknown)).toThrow("incomplete");
  });

  test("TC-531: descendants default to the parent's whole window and can be signed by a callback", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const s1 = parseCompactUcanAuthorization(vector.s1.authorization);
    const recipientKey = new Uint8Array(32).fill(9);
    const base = {
      parentAuthorization: vector.s0.authorization,
      parentCid: vector.s0.cid,
      issuerDid: vector.principals.recipientDid,
      audienceDid: s1.payload.aud,
      attenuation: s1.payload.att,
      now: s1.payload.nbf,
      nonce: s1.payload.nnc,
    };
    // A caller-owned signer produces the exact bytes of the private-key path.
    const callbackSigned = await signCompactPolicyDescendant({
      ...base,
      expiresAt: s1.payload.exp,
      sign: async (bytes) => ed25519.sign(bytes, recipientKey),
    });
    expect(callbackSigned.authorization).toBe(vector.s1.authorization);
    // Without an expiry, the descendant lasts as long as its parent allows.
    const session = parsePolicySessionUcan(vector.s0.authorization);
    const longest = createCompactPolicyDescendant({ ...base, privateKey: recipientKey });
    expect(longest.payload.exp).toBe(session.exp - 1);
    expect(longest.payload.nbf).toBe(s1.payload.nbf);
    expect(longest.payload.fct[0]!.remainingRedelegationDepth).toBe(session.fact.remainingRedelegationDepth - 1);
    // Without a start time it starts just inside the parent, so it is usable at once.
    const { now: _now, ...startless } = base;
    expect(createCompactPolicyDescendant({ ...startless, privateKey: recipientKey }).payload.nbf).toBe(session.nbf + 1);
    // A requested expiry is honoured but never exceeds the parent.
    expect(createCompactPolicyDescendant({ ...base, privateKey: recipientKey, expiresAt: session.exp + 3600 }).payload.exp).toBe(session.exp - 1);
    // A signer that is not the issuer's key is refused.
    await expect(signCompactPolicyDescendant({
      ...base,
      sign: async (bytes) => ed25519.sign(bytes, new Uint8Array(32).fill(10)),
    })).rejects.toThrow("signature is invalid");
  });

  test("TC-531: accepts long-lived sessions up to the 31-day root bound", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-fixtures/policy-engine-vectors/unified-policy/compact-authorization.json`,
    ).json()) as any;
    const parsed = parseCompactUcanAuthorization(vector.s0.authorization);
    const nodeKey = new Uint8Array(32).fill(29);
    const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(nodeKey)]))}`;
    // Signed directly: the compact invocation signer stops at 60 seconds.
    const sessionLasting = (seconds: number) => {
      const encode = (value: unknown) => Buffer.from(jcsCanonicalize(value)).toString("base64url");
      const header = encode({ alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: Buffer.from(ed25519.getPublicKey(nodeKey)).toString("base64url") }, typ: "JWT", ucv: "0.10.0" });
      const payload = encode({
        ...parsed.payload,
        exp: parsed.payload.nbf + seconds,
        fct: [{ ...parsed.payload.fct[0]!, nodeAudience: nodeDid }],
        iss: `${nodeDid}#${nodeDid.slice("did:key:".length)}`,
      });
      const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(`${header}.${payload}`), nodeKey)).toString("base64url");
      return `${header}.${payload}.${signature}`;
    };
    expect(parsePolicySessionUcan(sessionLasting(3600)).exp - parsed.payload.nbf).toBe(3600);
    expect(parsePolicySessionUcan(sessionLasting(31 * 24 * 60 * 60)).exp).toBe(parsed.payload.nbf + 31 * 24 * 60 * 60);
    expect(() => parsePolicySessionUcan(sessionLasting(31 * 24 * 60 * 60 + 1))).toThrow("fact is invalid");
  });

  test("TC-601: a root revocation is stamped in whole seconds, a form the Node always reproduces exactly", async () => {
    const ownerKey = new Uint8Array(32).fill(61);
    const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(ownerKey)]))}`;
    const nodeAudience = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(62))]))}`;
    const posted: Record<string, unknown>[] = [];
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ revoked: true, cid: "bafy-root" }), { status: 200 });
    }) as typeof globalThis.fetch;
    // The Node formats `.120Z` as `.12Z` and `.000Z` without a fraction, so
    // either millisecond stamp was refused as non-canonical.
    for (const now of ["2026-10-04T06:00:00.120Z", "2026-10-04T06:00:00.000Z", "2026-10-04T06:00:00.567Z"]) {
      await revokePolicyRootV3({
        nodeOrigin: "https://node.example", rootCid: "bafy-root", targetRole: "policy-enforcement", ownerDid, issuerDid: ownerDid,
        nodeAudience, reason: "share revoked", sign: async (digest) => ed25519.sign(digest, ownerKey), now: new Date(now), fetch,
      });
    }
    const revocations = posted.map((body) => body.revocation as Record<string, unknown>);
    expect(revocations.map((revocation) => revocation.revokedAt)).toEqual(["2026-10-04T06:00:00Z", "2026-10-04T06:00:00Z", "2026-10-04T06:00:00Z"]);
    // The signature covers that text, and it matches the checkpoint the Node
    // signs: its revokedAt and the revocation digest it records.
    const { signature: _signature, ...unsigned } = revocations[0]!;
    const revocationCid = Buffer.from(sha256(new TextEncoder().encode(ROOT_REVOCATION_V1_DOMAIN + jcsCanonicalize(unsigned)))).toString("hex");
    const checkpoint = { targetRole: "policy-enforcement", ownerDid, nodeAudience, revokedAt: "2026-10-04T06:00:00Z", revocationCid };
    expect(verifyPolicyRootRevocationV3({ rootCid: "bafy-root", checkpoint, revocation: revocations[0]! })).toBe(true);

    // Every millisecond survives the Node's RFC 3339 formatter, which drops
    // trailing zeros from the fraction and omits a zero fraction.
    const nodeFormat = (text: string) => text.replace(/\.(\d*?)0*Z$/, (_match, digits: string) => digits.length > 0 ? `.${digits}Z` : "Z");
    posted.length = 0;
    for (let millisecond = 0; millisecond < 1000; millisecond += 1) {
      await revokePolicyRootV3({
        nodeOrigin: "https://node.example", rootCid: "bafy-root", targetRole: "policy-enforcement", ownerDid, issuerDid: ownerDid,
        nodeAudience, reason: "share revoked", sign: async () => new Uint8Array(64), now: new Date(Date.UTC(2026, 9, 4, 6, 0, 0, millisecond)), fetch,
      });
    }
    const refused = posted.map((body) => (body.revocation as Record<string, string>).revokedAt!).filter((stamp) => nodeFormat(stamp) !== stamp);
    expect(refused).toEqual([]);
  });
  test("preserves status and server text from real policy challenge, mint, and root-status requests", async () => {
    const fetch = (status: number, body: string) =>
      // Bun's fetch type includes a preconnect method that this injected test callback never uses.
      (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
    const challengeInput = {
      nodeOrigin: "https://node.example",
      policyCid: "bafy-policy",
      recipientDid: "did:key:zHolder",
      requestedCapabilities: [],
    };
    const challenge = {
      challengeId: "challenge", nonce: "nonce",
      policyCid: challengeInput.policyCid, recipientDid: challengeInput.recipientDid,
    };
    const operations = [
      {
        name: "challenge",
        invoke: (status: number, body: string) => requestPolicyChallengeV3({
          ...challengeInput, fetch: fetch(status, body),
        }),
      },
      {
        name: "delegation",
        invoke: (status: number, body: string) => mintPolicySessionV3({
          ...challengeInput, policyRootCid: "bafy-root", enforcementRootCid: "bafy-enforcement",
          claim: {}, presentation: {}, challenge, fetch: fetch(status, body),
        }),
      },
      {
        name: "root status",
        invoke: (status: number, body: string) => getPolicyRootStatusV3({
          nodeOrigin: challengeInput.nodeOrigin, rootCid: "bafy-root", fetch: fetch(status, body),
        }),
      },
    ];
    for (const operation of operations) {
      for (const [status, body, verdict] of [
        [401, "Forbidden", "unauthenticated"],
        [403, "session expired", "forbidden"],
      ] as const) {
        const error: unknown = await operation.invoke(status, body).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ status });
        expect((error as Error).message).toContain(operation.name);
        expect((error as Error).message).toContain(`${status}`);
        expect((error as Error).message).toContain(body);
        expect(authorizationVerdictOf(error)).toBe(verdict);
      }
    }
  });

});
