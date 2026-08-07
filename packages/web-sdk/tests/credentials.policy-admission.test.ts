import { describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  POLICY_PRESENTATION_V3_DOMAIN,
  POLICY_SESSION_UCAN_V1_PROFILE,
  POLICY_V2_DOMAIN,
  POLICY_V2_SCHEMA,
  canonicalDigest,
  createStorageReceipt,
  credentialRequirementDigest,
  decodeBase64Url,
  encodeBase64Url,
  jcsCanonicalize,
  policyCidFromCanonicalBytes,
  policyIdForDigestHex,
  policyV2DigestHex,
  sha256Base64Url,
  signCompactUcanAuthorization,
  type CredentialRequirement,
  type StoredCredentialRecord,
  type UnifiedPolicyV2,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import { CredentialsService } from "../src/credentials/service";
import type { CredentialClient } from "../src/credentials/types";

function did(privateKey: Uint8Array): string {
  return `did:key:${base58btc.encode(
    Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(privateKey)]),
  )}`;
}

const OWNER_KEY = new Uint8Array(32).fill(31);
const ISSUER_KEY = new Uint8Array(32).fill(32);
const HOLDER_KEY = new Uint8Array(32).fill(33);
const ENFORCER_KEY = new Uint8Array(32).fill(34);
const NODE_KEY = new Uint8Array(32).fill(35);
const OWNER_DID = did(OWNER_KEY);
const ISSUER_DID = did(ISSUER_KEY);
const HOLDER_DID = did(HOLDER_KEY);
const ENFORCER_DID = did(ENFORCER_KEY);
const NODE_DID = did(NODE_KEY);
const ACCOUNT_OWNER_DID =
  "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-08-03T16:00:00.000Z");
const POLICY_ROOT_CID = "bafy-policy-root-470";
const ENFORCEMENT_ROOT_CID = "bafy-enforcement-root-470";
const NODE_ORIGIN = "https://node.example.test";
const RESOURCE = "tinycloud://owner-space/kv/docs/report.md";
const CREDENTIAL_SPACE_ID =
  "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:credentials";
const ACCOUNT_AUTHORIZATION_CID = "bafy-account-authorization-470";
const CAPABILITY = {
  kind: "kv" as const,
  resource: RESOURCE,
  selector: "exact" as const,
  actions: ["tinycloud.kv/get"] as const,
};
const REQUIREMENT: CredentialRequirement = {
  type: "TinyCloudCredentialRequirement",
  version: 1,
  profile: { id: "tinycloud.email-proof/v1", version: 1 },
  credentialType: { id: "opencredentials.email/v1", version: 1 },
  claims: { email: "alice@example.test" },
  maxAgeSeconds: 3600,
};

async function fixture() {
  const requirementDigest = await credentialRequirementDigest(REQUIREMENT);
  const descriptorDigest =
    "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0";
  const issuerKid = `${ISSUER_DID}#controller`;
  const credentialValue = "issuer-signed-sd-jwt~email-disclosure";
  const credentialDigest = await sha256Base64Url(credentialValue);
  const claimsDigest = await canonicalDigest(REQUIREMENT.claims);
  const unsignedPolicy = {
    schema: POLICY_V2_SCHEMA,
    ownerDid: OWNER_DID,
    createdAt: NOW.toISOString(),
    expiresAt: "2026-08-04T16:00:00.000Z",
    contentSource: {
      shareId: "share-470",
      kvResource: RESOURCE,
      selector: "exact" as const,
      encryptionNetwork: `urn:tinycloud:encryption:${OWNER_DID}:default`,
      encryptedSymmetricKeyDigestHex: "a".repeat(64),
      keyVersion: 1,
      mode: "immutable" as const,
      initialCiphertextDigestHex: "b".repeat(64),
    },
    capabilityCeiling: [CAPABILITY],
    credentialRequirement: {
      type: "TinyCloudPolicyCredentialRequirement" as const,
      version: 1 as const,
      requirementDigest,
      descriptorDigest,
      issuerDid: ISSUER_DID,
      issuerKid,
      profile: REQUIREMENT.profile,
      credentialType: REQUIREMENT.credentialType,
    },
  };
  const policyDigest = policyV2DigestHex(unsignedPolicy);
  const policyId = policyIdForDigestHex(policyDigest);
  const policySignature = ed25519.sign(
    sha256(
      new TextEncoder().encode(
        `${POLICY_V2_DOMAIN}${jcsCanonicalize(unsignedPolicy)}`,
      ),
    ),
    OWNER_KEY,
  );
  const policy: UnifiedPolicyV2 = {
    ...unsignedPolicy,
    policyId,
    signature: {
      suite: "Ed25519",
      signerDid: OWNER_DID,
      value: encodeBase64Url(policySignature),
    },
  };
  const policyCid = policyCidFromCanonicalBytes(
    new TextEncoder().encode(jcsCanonicalize(policy)),
  );
  const credential: VerifiedCredential = {
    type: "OpenCredentialsIssuedCredential",
    version: 1,
    protocol: "tinycloud.credentials/acquisition/v1",
    profile: REQUIREMENT.profile,
    credentialType: REQUIREMENT.credentialType,
    schema: REQUIREMENT.credentialType.id,
    format: "vc+sd-jwt",
    issuerDid: ISSUER_DID,
    issuerKid,
    subjectDid: HOLDER_DID,
    holderDid: HOLDER_DID,
    claims: REQUIREMENT.claims,
    claimsDigest,
    descriptorDigest,
    credentialId: "credential-470",
    issuedAt: "2026-08-03T15:55:00.000Z",
    notBefore: "2026-08-03T15:55:00.000Z",
    expiresAt: "2026-08-04T15:55:00.000Z",
    status: { method: "none", freshnessSeconds: 300 },
    credential: credentialValue,
    verifiedAt: "2026-08-03T15:56:00.000Z",
    credentialDigest,
    statusCheckedAt: "2026-08-03T15:56:00.000Z",
  };
  const record: StoredCredentialRecord = {
    type: "TinyCloudStoredCredential",
    version: 1,
    ownerDid: ACCOUNT_OWNER_DID,
    recordId: "record-470",
    requirementDigest,
    descriptorDigest,
    profile: credential.profile,
    credentialType: credential.credentialType,
    issuerDid: credential.issuerDid,
    issuerKid: credential.issuerKid,
    holderDid: credential.holderDid,
    claims: credential.claims,
    claimsDigest,
    credentialDigest,
    credential: credentialValue,
    schema: credential.schema,
    credentialId: credential.credentialId,
    issuedAt: credential.issuedAt,
    notBefore: credential.notBefore,
    expiresAt: credential.expiresAt,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    storedAt: "2026-08-03T15:57:00.000Z",
  };
  const receipt = await createStorageReceipt(record, "etag-470");
  const attenuation = {
    [RESOURCE]: {
      "tinycloud.kv/get": [
        {
          type: "xyz.tinycloud.resource/selector",
          kind: "exact",
          value: RESOURCE,
        },
      ],
    },
  };
  const session = await signCompactUcanAuthorization({
    issuerDid: NODE_DID,
    audienceDid: HOLDER_DID,
    attenuation,
    facts: [
      {
        profile: POLICY_SESSION_UCAN_V1_PROFILE,
        ownerDid: OWNER_DID,
        policyId,
        policyDigestHex: policyDigest,
        policyCid,
        policyDelegationCid: POLICY_ROOT_CID,
        enforcementDelegationCid: ENFORCEMENT_ROOT_CID,
        contentSourceDigestHex: "c".repeat(64),
        capabilityCeilingHashHex: "d".repeat(64),
        nativeProjectionHashHex: "e".repeat(64),
        enforcerDid: ENFORCER_DID,
        nodeAudience: NODE_DID,
        recipientDid: HOLDER_DID,
        challengeId: "challenge-470",
        claimDigestHex: "f".repeat(64),
        claimJti: "claim-470",
        vpDigestHex: "1".repeat(64),
        credentialEvidenceDigestHex: "2".repeat(64),
        decisionContextDigestHex: "3".repeat(64),
        issuanceAuditDigestHex: "4".repeat(64),
        remainingRedelegationDepth: 0,
      },
    ],
    proofs: [POLICY_ROOT_CID, ENFORCEMENT_ROOT_CID],
    notBefore: Math.floor(NOW.getTime() / 1000),
    expiresAt: Math.floor(NOW.getTime() / 1000) + 60,
    nonce: "session-470",
    sign: async (bytes) => ed25519.sign(bytes, NODE_KEY),
  });
  return { policy, policyCid, credential, record, receipt, session };
}

describe("TC-470 credential policy admission", () => {
  test("presents distinct issuer, owner, account, holder, enforcer, and node identities, then installs S0", async () => {
    const values = await fixture();
    const requests: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }> = [];
    const controller = new AbortController();
    const activate = mock(async (input: any) => ({
      cid: input.cid,
      delegation: { cid: input.cid },
      effectivePermissions: [],
      expiry: new Date("2026-08-03T16:01:00.000Z"),
      audience: HOLDER_DID,
      host: NODE_ORIGIN,
    }));
    const ensureOwnedSpaceHosted = mock(async (_name: string) => CREDENTIAL_SPACE_ID);
    const client: CredentialClient = {
      sessionDid: `${HOLDER_DID}#${HOLDER_DID.slice("did:key:".length)}`,
      credentialHolderDid: HOLDER_DID,
      credentialHolderKid: `${HOLDER_DID}#${HOLDER_DID.slice("did:key:".length)}`,
      session: () => ({ address: "0x1", walletAddress: "0x1", chainId: 1 }) as any,
      signSessionBytes: async (bytes) => ed25519.sign(bytes, HOLDER_KEY),
      ensureOwnedSpaceHosted,
      credentialSpaceOwnerDid: () => ACCOUNT_OWNER_DID,
      kvForSpace: () => ({}) as any,
      accountAuthorizationCid: () => ACCOUNT_AUTHORIZATION_CID,
      activateCompactRuntimeDelegation: activate,
    };
    const fetchFn = mock(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = String(resource);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body, signal: init?.signal });
      expect(url).not.toContain(values.credential.credential);
      if (url.endsWith("/share/v3/policy/challenges")) {
        expect(JSON.stringify(body)).not.toContain(values.credential.credential);
        return new Response(
          JSON.stringify({
            challengeId: "challenge-470",
            nonce: "nonce-470",
            policyCid: values.policyCid,
            recipientDid: HOLDER_DID,
            nodeAudience: NODE_DID,
            expiresAt: "2026-08-03T16:02:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          admitted: true,
          sessionCid: values.session.cid,
          authorization: values.session.authorization,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await new CredentialsService(client).admitPolicy({
      ensured: {
        status: "acquired",
        credential: values.credential,
        record: values.record,
        receipt: values.receipt,
      },
      policy: values.policy,
      policyCid: values.policyCid,
      policyRootCid: POLICY_ROOT_CID,
      enforcementRootCid: ENFORCEMENT_ROOT_CID,
      requirement: REQUIREMENT,
      requestedCapabilities: [CAPABILITY],
      nodeOrigin: NODE_ORIGIN,
      fetch: fetchFn,
      signal: controller.signal,
      now: NOW,
      jti: "presentation-470",
    });

    expect(result.installed.cid).toBe(values.session.cid);
    expect(activate).toHaveBeenCalledWith({
      authorization: values.session.authorization,
      cid: values.session.cid,
      host: NODE_ORIGIN,
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.signal === controller.signal)).toBe(true);
    const mint = requests[1]!.body as any;
    expect(Object.keys(mint).sort()).toEqual(
      [
        "policyCid",
        "challengeId",
        "nonce",
        "requirement",
        "credential",
        "accountAuthorizationCid",
        "credentialSpaceId",
        "presentation",
      ].sort(),
    );
    expect(ensureOwnedSpaceHosted).toHaveBeenCalledWith("credentials");
    expect(mint.accountAuthorizationCid).toBe(ACCOUNT_AUTHORIZATION_CID);
    expect(mint.credentialSpaceId).toBe(CREDENTIAL_SPACE_ID);
    expect(mint.credentialSpaceId).not.toBe(values.policy.contentSource.kvResource);
    expect(mint.credentialSpaceId).not.toBe(RESOURCE);
    expect(mint.credential.credential).toBe(values.credential.credential);
    expect(mint.credential.verifiedAt).toBeUndefined();
    expect(mint.presentation.credentialSpaceOwnerDid).toBe(ACCOUNT_OWNER_DID);
    expect(mint.presentation.holderDid).toBe(HOLDER_DID);
    expect(mint.presentation.subjectDid).toBe(HOLDER_DID);
    expect(mint.presentation.signature.signerDid).toBe(HOLDER_DID);
    expect(mint.presentation.nodeAudience).toBe(NODE_DID);
    expect(mint.presentation.issuedAt).toBe("2026-08-03T16:00:00Z");
    expect(mint.presentation.expiresAt).toBe("2026-08-03T16:01:00Z");
    expect(mint.presentation).not.toHaveProperty("credential");
    const { signature, ...unsignedPresentation } = mint.presentation;
    const digest = sha256(
      new TextEncoder().encode(
        `${POLICY_PRESENTATION_V3_DOMAIN}${jcsCanonicalize(unsignedPresentation)}`,
      ),
    );
    expect(
      ed25519.verify(
        decodeBase64Url(signature.value),
        digest,
        ed25519.getPublicKey(HOLDER_KEY),
      ),
    ).toBe(true);
    expect(new Set([OWNER_DID, ISSUER_DID, HOLDER_DID, ENFORCER_DID, NODE_DID, ACCOUNT_OWNER_DID]).size).toBe(6);
  });

  test("cancels account admission during the challenge without activating authority", async () => {
    const values = await fixture();
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let fetchCalls = 0;
    let activateCalls = 0;
    const client = {
      sessionDid: HOLDER_DID,
      credentialHolderDid: HOLDER_DID,
      credentialHolderKid: `${HOLDER_DID}#${HOLDER_DID.slice("did:key:".length)}`,
      session: () => ({ address: "0x1", walletAddress: "0x1", chainId: 1 }),
      signSessionBytes: async (bytes: Uint8Array) => ed25519.sign(bytes, HOLDER_KEY),
      ensureOwnedSpaceHosted: async () => CREDENTIAL_SPACE_ID,
      credentialSpaceOwnerDid: () => ACCOUNT_OWNER_DID,
      kvForSpace: () => ({}),
      accountAuthorizationCid: () => ACCOUNT_AUTHORIZATION_CID,
      activateCompactRuntimeDelegation: async () => { activateCalls += 1; return {} as any; },
    } as unknown as CredentialClient;
    const fetchFn = ((_resource: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      fetchCalls += 1;
      expect(init?.signal).toBe(controller.signal);
      notifyStarted();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

    const pending = new CredentialsService(client).admitPolicy({
      ensured: {
        status: "reused",
        credential: values.credential,
        record: values.record,
      },
      policy: values.policy,
      policyCid: values.policyCid,
      policyRootCid: POLICY_ROOT_CID,
      enforcementRootCid: ENFORCEMENT_ROOT_CID,
      requirement: REQUIREMENT,
      requestedCapabilities: [CAPABILITY],
      nodeOrigin: NODE_ORIGIN,
      fetch: fetchFn,
      signal: controller.signal,
      now: NOW,
    });

    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(fetchCalls).toBe(1);
    expect(activateCalls).toBe(0);
  });

  test("rejects a substituted stored account owner before requesting admission", async () => {
    const values = await fixture();
    let calls = 0;
    const client = {
      sessionDid: HOLDER_DID,
      credentialHolderDid: HOLDER_DID,
      credentialHolderKid: `${HOLDER_DID}#${HOLDER_DID.slice("did:key:".length)}`,
      session: () => ({ address: "0x1", chainId: 1 }),
      signSessionBytes: async (bytes: Uint8Array) => ed25519.sign(bytes, HOLDER_KEY),
      ensureOwnedSpaceHosted: async () => "tinycloud:pkh:eip155:1:0x1:credentials",
      credentialSpaceOwnerDid: () => ACCOUNT_OWNER_DID,
      kvForSpace: () => ({}),
      activateCompactRuntimeDelegation: async () => ({}),
    } as unknown as CredentialClient;
    await expect(
      new CredentialsService(client).admitPolicy({
        ensured: {
          status: "reused",
          credential: values.credential,
          record: { ...values.record, ownerDid: "did:pkh:eip155:1:0xsubstituted" },
        },
        policy: values.policy,
        policyCid: values.policyCid,
        policyRootCid: POLICY_ROOT_CID,
        enforcementRootCid: ENFORCEMENT_ROOT_CID,
        requirement: REQUIREMENT,
        requestedCapabilities: [CAPABILITY],
        nodeOrigin: NODE_ORIGIN,
        fetch: (async () => { calls += 1; throw new Error("must not fetch"); }) as typeof fetch,
        now: NOW,
      }),
    ).rejects.toThrow("Stored credential provenance");
    expect(calls).toBe(0);
  });
});
