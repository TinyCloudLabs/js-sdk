import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { decodeBase64Url, encodeBase64Url } from "../credentials";
import { jcsCanonicalize } from "./jcs";
import {
  POLICY_PRESENTATION_V4_DOMAIN,
  postPolicyDelegation,
  requestedSessionExpiry,
  signPolicyCredentialPresentationV4,
  validatePolicyCredentialAdmissionV4Authority,
  type UnifiedPolicyV2,
  type UnsignedPolicyCredentialPresentationV4,
} from "./credential-admission";
import { requestPolicyChallengeV3 } from "./unified";

describe("TC-500 policy presentation v4", () => {
  test("matches the frozen cross-language golden vector", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-vectors/policy-presentation-v4.json`,
    ).json()) as any;
    const seed = decodeBase64Url(vector.holderSeedBase64Url);
    expect(jcsCanonicalize(vector.unsigned)).toBe(vector.canonicalUnsigned);
    expect(encodeBase64Url(sha256(new TextEncoder().encode(
      POLICY_PRESENTATION_V4_DOMAIN + vector.canonicalUnsigned,
    )))).toBe(vector.signingDigestBase64Url);
    const presentation = await signPolicyCredentialPresentationV4(
      vector.unsigned as UnsignedPolicyCredentialPresentationV4,
      async (digest) => ed25519.sign(digest, seed),
    );
    expect(presentation.signature.value).toBe(vector.signatureBase64Url);
    expect(presentation.signature.signerDid).toBe(vector.holderDid);
    expect("accountAuthorizationCid" in presentation).toBe(false);
    expect("credentialSpaceId" in presentation).toBe(false);
  });

  test("rejects account fields and broken key continuity", async () => {
    const vector = (await Bun.file(
      `${import.meta.dir}/../../test-vectors/policy-presentation-v4.json`,
    ).json()) as any;
    const seed = decodeBase64Url(vector.holderSeedBase64Url);
    await expect(signPolicyCredentialPresentationV4(
      { ...vector.unsigned, accountAuthorizationCid: "forbidden" },
      async (digest) => ed25519.sign(digest, seed),
    )).rejects.toThrow("unknown or missing field");
    await expect(signPolicyCredentialPresentationV4(
      { ...vector.unsigned, subjectDid: "did:key:zBroken" },
      async (digest) => ed25519.sign(digest, seed),
    )).rejects.toThrow("invalid");
  });

  test("requires out-of-band runtime Node and enforcer authority", () => {
    const nodeAudience = "did:key:z6MkRuntimeNode";
    const enforcerDid = "did:key:z6MkEnforcer";
    const session = {
      iss: `${nodeAudience}#key`,
      fact: { nodeAudience, enforcerDid },
    } as any;
    expect(() => validatePolicyCredentialAdmissionV4Authority(session, { nodeAudience, enforcerDid })).not.toThrow();
    expect(() => validatePolicyCredentialAdmissionV4Authority(session, { nodeAudience: "did:key:z6MkAttacker", enforcerDid })).toThrow("authority binding");
    expect(() => validatePolicyCredentialAdmissionV4Authority(session, { nodeAudience, enforcerDid: "did:key:z6MkAttacker" })).toThrow("authority binding");
  });

  test("uses only the embedded Node policy route", async () => {
    const calls: string[] = [];
    const challenge = await requestPolicyChallengeV3({
      nodeOrigin: "https://node.example",
      policyCid: "bafy-policy",
      recipientDid: "did:key:zHolder",
      requestedCapabilities: [],
      fetch: (async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({
          challengeId: "challenge",
          nonce: "nonce",
          policyCid: "bafy-policy",
          recipientDid: "did:key:zHolder",
        }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    expect(challenge.challengeId).toBe("challenge");
    expect(calls).toEqual(["https://node.example/policy/v3/challenges"]);
    expect(calls.some((url) => url.includes("/share/"))).toBe(false);
    await expect(requestPolicyChallengeV3({
      nodeOrigin: "https://node.example",
      policyRuntimePath: "/policy/v3?legacy-alias",
      policyCid: "bafy-policy",
      recipientDid: "did:key:zHolder",
      requestedCapabilities: [],
      fetch: (async () => new Response()) as typeof fetch,
    })).rejects.toThrow("policy runtime path is invalid");
  });

  test("asks for a session as long as the policy, in the form the Node accepts", () => {
    const policy = (expiresAt?: string) => ({ expiresAt }) as unknown as UnifiedPolicyV2;
    const inAnHour = new Date(Date.now() + 3_600_000);
    inAnHour.setUTCMilliseconds(250);
    const canonical = new Date(Math.floor(inAnHour.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
    expect(requestedSessionExpiry(undefined, policy(inAnHour.toISOString()))).toBe(canonical);
    expect(canonical).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // An explicit request wins; null asks for the legacy minute.
    expect(requestedSessionExpiry(canonical, policy(undefined))).toBe(canonical);
    expect(requestedSessionExpiry(null, policy(inAnHour.toISOString()))).toBeUndefined();
    // No policy expiry, an expiry within a minute, or garbage: no request.
    expect(requestedSessionExpiry(undefined, policy(undefined))).toBeUndefined();
    expect(requestedSessionExpiry(undefined, policy(new Date(Date.now() + 30_000).toISOString()))).toBeUndefined();
    expect(requestedSessionExpiry("tomorrow", policy(undefined))).toBeUndefined();
  });

  test("falls back to the legacy mint when an older Node rejects the field", async () => {
    const url = new URL("https://node.example/policy/v3/delegations");
    const mint = (statuses: number[]) => {
      const bodies: Record<string, unknown>[] = [];
      const fetchFn = (async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: statuses[bodies.length - 1] ?? 500 });
      }) as typeof fetch;
      return { bodies, fetchFn };
    };
    const body = { policyCid: "bafy-policy", challengeId: "challenge" };
    const expiry = "2026-10-08T12:00:00Z";

    const current = mint([200]);
    expect((await postPolicyDelegation(current.fetchFn, url, body, expiry, undefined)).status).toBe(200);
    expect(current.bodies).toEqual([{ ...body, requestedExpiresAt: expiry }]);

    // Nodes before 1.17.3 refuse unknown fields with 422 before spending the challenge.
    const older = mint([422, 200]);
    expect((await postPolicyDelegation(older.fetchFn, url, body, expiry, undefined)).status).toBe(200);
    expect(older.bodies).toEqual([{ ...body, requestedExpiresAt: expiry }, body]);

    // Any other refusal is final.
    const refused = mint([400, 200]);
    expect((await postPolicyDelegation(refused.fetchFn, url, body, expiry, undefined)).status).toBe(400);
    expect(refused.bodies).toHaveLength(1);

    const legacy = mint([200]);
    await postPolicyDelegation(legacy.fetchFn, url, body, undefined, undefined);
    expect(legacy.bodies).toEqual([body]);
  });
});
