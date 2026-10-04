import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilePath, withProfileLock, withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { encodeSealedInlineShareUrl, unifiedPolicyV2Schema } from "@tinycloud/share-envelope";
import { historyRecordForPublishedShare, notifyShare, type SenderShareRecord, type TargetPublishInput } from "@tinycloud/share-sdk";
import { createEmailCredentialRequirement, createEmailDomainCredentialRequirement, credentialRequirementDigest, LocationRecordValidationError, LocationRegistryHttpError } from "@tinycloud/sdk-core";
import { CLIError } from "../output/errors.js";

const transportDid = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX";
const credentialHolderDid = "did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH";
const nodeDid = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";
const ownerRootInputs: Array<{ readonly ownerDid: string; readonly role: string }> = [];
const sessionSignatures: Uint8Array[] = [];
const deliveryAuthorizationInputs: Array<Record<string, unknown>> = [];
let deliveryAuthorization: { readonly key: string; readonly body: string; readonly receipt: Record<string, unknown> } | undefined;
let deliveryAuthorizationConflicts = 0;
const publishEvents: string[] = [];
const registeredPolicies: unknown[] = [];

let nodeSpaceId: string | undefined = "tinycloud:test-space";
let restoredSpaceId: string | undefined = "tinycloud:test-space";
let nativeSpaceId = "tinycloud:test-space";
const uploadedSpaces: string[] = [];
const uploadedPaths: string[] = [];
const encryptionSpaces: string[] = [];
let sessionOnly = true;
let invokerDid = credentialHolderDid;
let nodeInfoStatus = 200;
const nodeInfoRequests: RequestInit[] = [];
let historyCacheDir: string | undefined;
let historyLocalKey = true;
let historyKeyId = "key-one";
let historySpaceName = "default";
let historyProfileDirectories = false;
let historyBeforeLock: ((profile: string) => Promise<void>) | undefined;
let historyOnCacheAccess: ((profile: string) => void) | undefined;
let historyProfileMissing = false;
let historyMissingProfileName: string | undefined;
let historyOnSign: (() => void) | undefined;
let historyResolvedProfile: string | undefined;
let uploadErrorCode: string | undefined;
let uploadErrorMeta: Record<string, unknown> | undefined;
let sessionExpiresAt = "2099-01-01T00:00:00.000Z";
let authenticationError: unknown;
let registryError: unknown;
let sharingPreflight: "ok" | "caveated" | "not-covered" = "ok";
let nodeContract: "1.17.2" | "1.17.3" = "1.17.2";
let advertisedNodeVersion: string | undefined;
const preflightRequests: Array<{ readonly path: string; readonly actions?: string[]; readonly expiry?: Date }> = [];

/** Digest of the descriptor the issuer serves for `name`, from sdk-core's golden vectors. */
async function goldenDescriptorDigest(name: string): Promise<string> {
  const fixture: unknown = JSON.parse(await readFile(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url), "utf8"));
  const vectors: unknown[] = typeof fixture === "object" && fixture !== null && "vectors" in fixture && Array.isArray(fixture.vectors) ? fixture.vectors : [];
  const vector = vectors.find((candidate) => typeof candidate === "object" && candidate !== null && "name" in candidate && candidate.name === name);
  if (typeof vector !== "object" || vector === null || !("digest" in vector) || typeof vector.digest !== "string") throw new Error(`golden descriptor vector ${name} is missing`);
  return vector.digest;
}
/** tinycloud-node `delivery_email`: ASCII-lowercased mailbox, or undefined when the Node refuses it. */
function nodeDeliveryEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (at <= 0 || domain.length === 0 || value.length > 254 || /[\u0000-\u0020\u007f-\uffff]/.test(value) || !/^[A-Za-z0-9.-]+$/.test(domain)) return undefined;
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}
/**
 * The Node delivery contract the fake node enforces before it signs a receipt:
 * the recipient, pin, display, action and credential checks of
 * `v3_envelope_delivery_projection` and `authorize_delivery` in
 * tinycloud-node-server/src/policy_v3.rs. Registration binding is not
 * mirrored. Any mismatch is a `403 delivery-authorization-invalid`.
 *
 * - "1.17.2": node 1.17.1/1.17.2 (`60c3ab8`, identical policy_v3.rs). The
 *   envelope must pin `deliveryEmail` byte-equal to the request (TC-571),
 *   the matcher must be `exactEmail`, and actions must be exactly `read`.
 * - "1.17.3": node `05c6a93`. The pin is optional but byte-equal when present;
 *   actions must include `read`. Domain invitations additionally require the
 *   invoking DID (without a fragment) to equal the policy owner DID, a canonical
 *   mailbox at the exact domain and the domain-proof profile.
 */
function nodeRefusesDelivery(input: Record<string, unknown>): boolean {
  const envelope = input.envelope as Record<string, unknown> | undefined;
  const matcher = envelope?.recipientMatcher as Record<string, unknown> | undefined;
  const display = envelope?.display as Record<string, unknown> | undefined;
  const policy = envelope?.policy as { readonly credentialRequirement?: { readonly credentialType?: { readonly id?: unknown }; readonly profile?: { readonly id?: unknown } } } | undefined;
  const actions = Array.isArray(envelope?.actions) ? envelope.actions : [];
  const canonicalRecipient = nodeDeliveryEmail(input.recipientEmail);
  const expected = nodeDeliveryEmail(matcher?.value);
  const pinRefused = nodeContract === "1.17.2"
    ? envelope?.deliveryEmail !== input.recipientEmail
    : envelope?.deliveryEmail !== undefined && envelope.deliveryEmail !== input.recipientEmail;
  const actionsRefused = nodeContract === "1.17.2" ? JSON.stringify(actions) !== JSON.stringify(["read"]) : !actions.includes("read");
  const domain = matcher?.kind === "emailDomain";
  const matcherRefused = domain
    ? nodeContract !== "1.17.3"
      || invokerDid.split("#", 1)[0] !== (envelope?.signature as { readonly signerDid?: string } | undefined)?.signerDid
      || policy?.credentialRequirement?.profile?.id !== "tinycloud.email-domain-proof/v1"
      || typeof matcher.value !== "string"
      || canonicalRecipient !== input.recipientEmail
      || canonicalRecipient?.split("@").at(-1) !== matcher.value
    : matcher?.kind !== "exactEmail" || expected === undefined || expected !== canonicalRecipient;
  return matcher === undefined
    || Object.keys(matcher).length !== 2
    || matcherRefused
    || pinRefused
    || display?.filename !== input.documentName
    || actionsRefused
    || policy?.credentialRequirement?.credentialType?.id !== "opencredentials.email/v1"
    || typeof envelope?.expiry !== "string";
}
const node = {
  did: transportDid,
  get credentialHolderDid() { return invokerDid.split("#", 1)[0]; },
  get spaceId() { return nodeSpaceId; },
  get isSessionOnly() { return sessionOnly; },
  get restorableSession() {
    return restoredSpaceId === undefined ? undefined : {
      spaceId: restoredSpaceId,
      siwe: `share.example wants you to sign in with your Ethereum account:\n0x0000000000000000000000000000000000000001\n\nSign in to TinyCloud\n\nURI: https://share.example\nVersion: 1\nChain ID: 1\nNonce: 12345678\nIssued At: 2025-01-01T00:00:00.000Z\nExpiration Time: ${sessionExpiresAt}`,
      signature: "signed-proof",
    };
  },
  activeNodeIdentity: async () => ({ origin: "https://node.example", nodeDid }),
  publishActiveNodeLocation: async (registryUrl: string) => {
    if (registryError !== undefined) throw registryError;
    publishEvents.push(`location ${registryUrl}`);
  },
  getEncryptionNetworkIdForSpace: (spaceId: string) => {
    encryptionSpaces.push(spaceId);
    return `urn:tinycloud:encryption:${credentialHolderDid}:default`;
  },
  encryption: {
    encryptToNetwork: async (networkId: string) => ({
      ok: true as const,
      data: {
        v: 1,
        networkId,
        alg: "x25519-aes256gcm/v1",
        keyVersion: 1,
        encryptedSymmetricKey: "network-wrapped-key",
        encryptedSymmetricKeyHash: "1".repeat(64),
        ciphertext: "AQ",
        metadata: { contentType: "text/plain" },
      },
    }),
  },
  kvForSpace: (spaceId: string) => ({
    put: async (path: string) => {
      publishEvents.push("upload");
      uploadedSpaces.push(spaceId);
      uploadedPaths.push(path);
      return uploadErrorCode === undefined
        ? { ok: true as const }
        : { ok: false as const, error: { code: uploadErrorCode, message: "secret server response", service: "kv", meta: uploadErrorMeta ?? { status: uploadErrorCode === "STORAGE_QUOTA_EXCEEDED" ? 402 : 503, usedBytes: 387_382_794, limitBytes: 8_119_195, requiredAction: "tinycloud.kv/put" } } };
    },
  }),
  sharing: {
    generate: async ({ expiry }: { readonly expiry: Date }) => ({ ok: true, data: { token: "opaque-share-token", delegation: { cid: "bafy-native-share" }, expiresAt: expiry } }),
    preflightGenerate: (request: { readonly path: string; readonly actions?: string[]; readonly expiry?: Date }) => {
      preflightRequests.push(request);
      return sharingPreflight;
    },
    decodeLink: () => ({ spaceId: nativeSpaceId, path: "xyz.tinycloud.share/shares/report.md" }),
  },
  createUnifiedOwnerRoot: async (input: { readonly ownerDid: string; readonly role: "policy-authority" | "policy-enforcement" }) => {
    // Capture every addressed owner-root request for the contract assertions.
    ownerRootInputs.push(input);
    return {
      cid: input.role === "policy-authority" ? "bafy-policy-root" : "bafy-enforcement-root",
      delegationHeader: { Authorization: input.role === "policy-authority" ? "a.b.c" : "d.e.f" },
    };
  },
  signSessionBytes: async (bytes: Uint8Array) => {
    historyOnSign?.();
    sessionSignatures.push(bytes.slice());
    return new Uint8Array(64).fill(7);
  },
  registerPolicy: async (input: { readonly policyCid: string; readonly policy: unknown; readonly policyRoot: { readonly cid: string }; readonly enforcementRoot: { readonly cid: string } }) => {
    registeredPolicies.push(input.policy);
    return {
      policyCid: input.policyCid,
      policyRootCid: input.policyRoot.cid,
      enforcementRootCid: input.enforcementRoot.cid,
      attestedEnforcerBinding: {
        schema: "xyz.tinycloud.policy/attested-enforcer/v2" as const,
        enforcerDid: nodeDid,
        nodeAudience: nodeDid,
        attestationBindingDigestHex: "2".repeat(64),
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
        signature: { suite: "Ed25519" as const, signerDid: nodeDid, value: "AQ" },
      },
    };
  },
  authorizeShareDeliveryV3: async (input: Record<string, unknown> & { readonly expiresAt: string; readonly idempotencyKey: string; readonly shareUrl: string }) => {
    const captured = { ...input };
    const body = JSON.stringify(captured);
    deliveryAuthorizationInputs.push(captured);
    if (nodeRefusesDelivery(input)) throw new Error("V3 share delivery authorization failed: 403");
    if (deliveryAuthorization?.key === input.idempotencyKey) {
      if (deliveryAuthorization.body !== body) {
        deliveryAuthorizationConflicts += 1;
        throw new Error("V3 share delivery authorization failed: 409");
      }
      return deliveryAuthorization.receipt;
    }
    const receipt = {
      request: { returnLink: input.shareUrl },
      admission: {},
      proof: { signature: "stable-replay-proof" },
    };
    deliveryAuthorization = { key: input.idempotencyKey, body, receipt };
    return receipt;
  },
};
mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async ({ profile }: { profile: string }) => ({ profile: historyResolvedProfile ?? profile, host: "https://node.example" }),
    getProfile: async (profile: string) => {
      if (historyProfileMissing || profile === historyMissingProfileName) {
        throw new CLIError("PROFILE_NOT_FOUND", `Profile "${profile}" does not exist. Run tc init first.`);
      }
      return historyCacheDir === undefined ? { authMethod: "openkey" } : historyLocalKey
        ? { authMethod: "local", privateKey: "test-history-key", spaceName: historySpaceName }
        : { authMethod: "openkey", spaceName: historySpaceName };
    },
    getKey: async () => ({ id: historyKeyId }),
    getSession: async () => ({ id: historyKeyId }),
    getCacheDir: async (profile: string) => {
      if (historyCacheDir === undefined) throw new Error("history test directory is not configured");
      historyOnCacheAccess?.(profile);
      return historyProfileDirectories ? join(profilePath(profile), "cache") : historyCacheDir;
    },
    withLock: async <T>(profile: string, action: () => Promise<T>, options?: Parameters<typeof withProfileLock>[2]): Promise<T> => {
      await historyBeforeLock?.(profile);
      return withProfileLock(profile, action, options);
    },
  },
}));
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => {
    if (authenticationError !== undefined) throw authenticationError;
    return node;
  },
}));

const { createEncryptedProfileHistory, createShareAuthorityAdapters } = await import("./adapters.js");
const { SharePublishAuthorityError } = await import("./errors.js");

afterEach(() => {
  nodeSpaceId = "tinycloud:test-space";
  restoredSpaceId = "tinycloud:test-space";
  nativeSpaceId = "tinycloud:test-space";
  uploadedPaths.length = 0;
  sessionOnly = true;
  invokerDid = credentialHolderDid;
  nodeInfoStatus = 200;
  nodeInfoRequests.length = 0;
  uploadErrorCode = undefined;
  uploadErrorMeta = undefined;
  uploadedSpaces.length = 0;
  historyCacheDir = undefined;
  historyLocalKey = true;
  historyKeyId = "key-one";
  historySpaceName = "default";
  historyProfileDirectories = false;
  historyBeforeLock = undefined;
  historyOnCacheAccess = undefined;
  historyProfileMissing = false;
  historyMissingProfileName = undefined;
  historyOnSign = undefined;
  historyResolvedProfile = undefined;
  encryptionSpaces.length = 0;
  ownerRootInputs.length = 0;
  sessionSignatures.length = 0;
  deliveryAuthorizationInputs.length = 0;
  deliveryAuthorization = undefined;
  deliveryAuthorizationConflicts = 0;
  publishEvents.length = 0;
  registeredPolicies.length = 0;
  sessionExpiresAt = "2099-01-01T00:00:00.000Z";
  authenticationError = undefined;
  registryError = undefined;
  sharingPreflight = "ok";
  nodeContract = "1.17.2";
  advertisedNodeVersion = undefined;
  preflightRequests.length = 0;
});

/** A separate Bun process holds the same filesystem profile lock as the CLI. */
async function acquireProfileLockInChild(root: string, holdMs: number, timeoutMs: number): Promise<() => Promise<void>> {
  const script = `import { withProfileLock } from "@tinycloud/operations/state";
await withProfileLock("history-test", async () => {
  console.log("LOCKED");
  // Integration boundary: only a real elapsed hold exercises cross-process lock expiry.
  const delay = Promise.withResolvers();
  setTimeout(delay.resolve, ${holdMs});
  await delay.promise;
}, { timeoutMs: ${timeoutMs} });`;
  const child = Bun.spawn(["bun", "-e", script], {
    cwd: join(import.meta.dir, "../../../.."),
    env: { ...process.env, TC_HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // A real subprocess may fail to start: bound readiness, not the lock behavior.
    const ready = await Promise.race([
      child.stdout.getReader().read(),
      Bun.sleep(2000).then(() => { throw new Error("lock holder did not become ready"); }),
    ]);
    if (ready.done || !new TextDecoder().decode(ready.value).includes("LOCKED")) {
      throw new Error("second process could not acquire the profile lock");
    }
    return async () => { await child.exited; };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}

describe("TinyCloud share authority adapter", () => {
  it("publishes bearer shares from the restored owner space and preserves origin binding", async () => {
    nodeSpaceId = undefined;
    restoredSpaceId = "tinycloud:restored-owner-space";
    nativeSpaceId = restoredSpaceId;
    uploadedSpaces.length = 0;
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });

    const published = await targetAdapter.publish({
      source: new TextEncoder().encode("restored-session share"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example",
    });

    expect("state" in published).toBe(false);
    if ("state" in published) throw new Error("expected bearer publish success");
    expect(uploadedSpaces).toEqual([restoredSpaceId]);
    expect(published.metadata.target.spaceId).toBe(restoredSpaceId);
    expect(published.metadata.origin).toBe("https://share.example");
    await expect(targetAdapter.publish({
      source: new TextEncoder().encode("wrong origin"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://attacker.example",
    })).rejects.toMatchObject({ failure: { kind: "origin-mismatch" } });
    expect(uploadedSpaces).toEqual([restoredSpaceId]);
  });
  it("publishes special filenames at a readable URI-safe path and preserves display metadata", async () => {
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });
    const storedAs = {
      "report.md": "report.md",
      "Q3.v2_final-draft.html": "Q3.v2_final-draft.html",
      "Edge test (A) - read.md": "Edge-test-A-read.md",
      "Résumé 東京.md": "Resume.md",
      "question?#percent%.md": "question-percent.md",
      "東京.html": "share.html",
      "my notes.tar.gz": "my-notes.tar.gz",
      "no extension here": "no-extension-here",
      "notes..md": "notes.md",
      "Q3 report..final.md": "Q3-report.final.md",
      ".md": "share.md",
      ".env": "share.env",
      "my notes.md.": "my-notes-md",
      "notes.md~": "notes-md",
      "notes.\uff4d\uff44": "notes-md",
      "a\uff0e\uff0emd": "a-md",
    };
    for (const [filename, stored] of Object.entries(storedAs)) {
      for (const target of [{ kind: "bearer" as const }, { kind: "email" as const, address: "alice@example.com" }]) {
        const published = await targetAdapter.publish({
          source: new TextEncoder().encode("filename round trip"),
          filename,
          target,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          origin: "https://share.example",
        });
        expect("state" in published).toBe(false);
        if ("state" in published) throw new Error("expected publication");
        expect(published.metadata.display.filename).toBe(filename);
        const path = published.metadata.resource.path;
        expect(path).toMatch(/^(?:xyz\.tinycloud\.share\/)?shares?\/[a-f0-9]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
        expect(path.split("/").at(-1)).toBe(stored);
        expect(path).not.toContain("..");
        expect(uploadedPaths.at(-1)).toBe(path);
      }
    }
    // The viewer refuses format characters, so publication refuses them too (TC-580).
    await expect(targetAdapter.publish({
      source: new TextEncoder().encode("filename round trip"), filename: "x.html\u200b", target: { kind: "email", address: "alice@example.com" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"), origin: "https://share.example",
    })).rejects.toMatchObject({ failure: { kind: "invalid-request", reason: "addressed filename is invalid" } });
  });

  it("clamps implicit lifetime to signed session expiry and rejects explicit overrun", async () => {
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });
    const base = {
      source: new TextEncoder().encode("expiry-bound share"),
      filename: "report.md",
      target: { kind: "bearer" as const },
      origin: "https://share.example",
    };
    const implicit = await targetAdapter.publish({ ...base, expiresAt: new Date("2100-01-01T00:00:00.000Z"), expiryWasExplicit: false });
    expect("state" in implicit).toBe(false);
    if ("state" in implicit) throw new Error("expected publication");
    expect(implicit.metadata.expiryClamped).toBe(true);
    expect(implicit.metadata.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    await expect(targetAdapter.publish({ ...base, expiresAt: new Date("2100-01-01T00:00:00.000Z"), expiryWasExplicit: true }))
      .rejects.toMatchObject({ failure: { kind: "lifetime-exceeds-session", reason: "beyond-session", sessionExpiresAt: new Date("2099-01-01T00:00:00.000Z") } });
    const nearExpiry = new Date(Date.now() + 600).toISOString();
    sessionExpiresAt = nearExpiry;
    uploadedSpaces.length = 0;
    await expect(targetAdapter.publish({
      ...base,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      expiryWasExplicit: false,
    })).rejects.toMatchObject({ failure: { kind: "lifetime-exceeds-session", reason: "session-too-close" } });
    sessionExpiresAt = new Date(Date.now() + 50_000).toISOString();
    for (const lifetimeMs of [30_000, 70_000]) {
      await expect(targetAdapter.publish({
        ...base,
        expiresAt: new Date(Date.now() + lifetimeMs),
        expiryWasExplicit: true,
      })).rejects.toMatchObject({
        failure: { kind: "lifetime-exceeds-session", reason: "session-too-close" },
      });
    }
    expect(uploadedSpaces).toEqual([]);
  });
  it("allows signer-backed local-key shares to outlive the restored session", async () => {
    sessionOnly = false;
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "local",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });
    const published = await targetAdapter.publish({
      source: new TextEncoder().encode("wallet-signed share"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      expiryWasExplicit: true,
      origin: "https://share.example",
    });

    expect("state" in published).toBe(false);
    if ("state" in published) throw new Error("expected local-key publication");
    expect(published.metadata.expiryClamped).toBeUndefined();
    expect(published.metadata.expiresAt).toBe("2100-01-01T00:00:00.000Z");
    await expect(targetAdapter.publish({
      source: new TextEncoder().encode("too-short local share"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date(Date.now() + 30_000),
      expiryWasExplicit: true,
      origin: "https://share.example",
    })).rejects.toMatchObject({ failure: { kind: "lifetime-exceeds-session", reason: "below-minimum" } });
  });


  it("classifies storage and other KV upload failures for bearer and addressed shares", async () => {
    const account = { usedBytes: 389_777_359, limitBytes: 104_857_600, plan: "free" };
    const cases = [
      { code: "STORAGE_QUOTA_EXCEEDED", meta: { status: 402, usedBytes: 155_744, limitBytes: 0, account }, failure: { kind: "storage-full", code: "STORAGE_QUOTA_EXCEEDED", account } },
      { code: "STORAGE_QUOTA_EXCEEDED", meta: { status: 402 }, failure: { kind: "storage-full", code: "STORAGE_QUOTA_EXCEEDED" } },
      { code: "STORAGE_QUOTA_EXCEEDED", meta: { status: 402, account: { usedBytes: -1, limitBytes: "100 MB" } }, failure: { kind: "storage-full", code: "STORAGE_QUOTA_EXCEEDED" } },
      { code: "STORAGE_LIMIT_REACHED", meta: { status: 413 }, failure: { kind: "storage-full", code: "STORAGE_LIMIT_REACHED" } },
      { code: "UNAVAILABLE", meta: undefined, failure: { kind: "upload-failed" } },
    ];
    for (const target of [{ kind: "bearer" as const }, { kind: "email" as const, address: "alice@example.com" }]) {
      for (const { code, meta, failure } of cases) {
        uploadErrorCode = code;
        uploadErrorMeta = meta;
        const { targetAdapter } = createShareAuthorityAdapters({
          origin: "https://share.example",
          profileName: async () => "test",
          fetchFn: (async () => Response.json({
            version: "tinycloud.share/config-v2",
            shareOrigin: "https://share.example",
            registryOrigin: "https://registry.example",
            credentialsOrigin: "https://credentials.example",
          })) as unknown as typeof globalThis.fetch,
        });
        const error = await targetAdapter.publish({
          source: new TextEncoder().encode("failed source"),
          filename: "report.md",
          target,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          origin: "https://share.example",
        }).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(SharePublishAuthorityError);
        expect((error as InstanceType<typeof SharePublishAuthorityError>).failure as unknown).toEqual(failure);
        expect(String((error as Error).message)).not.toContain("secret server response");
      }
    }
  });

  it("types KV upload authorization failures without exposing server text", async () => {
    uploadErrorCode = "AUTH_UNAUTHORIZED";
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });
    await expect(targetAdapter.publish({
      source: new TextEncoder().encode("denied share"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example",
    })).rejects.toMatchObject({
      failure: { kind: "scope-denied", capability: "KV upload", requiredAction: "tinycloud.kv/put" },
      message: "scope-denied",
    });
  });

  it("reports absent restored owner authority as authentication required", async () => {
    nodeSpaceId = "tinycloud:transport-space";
    restoredSpaceId = undefined;
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });
    await expect(targetAdapter.publish({
      source: new TextEncoder().encode("unbound share"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example",
    })).rejects.toMatchObject({ failure: { kind: "owner-space-unresolved", localKey: false } });
    expect(uploadedSpaces).toEqual([]);
  });

  it("converts expired restored-session authorization into AUTH_REQUIRED", async () => {
    authenticationError = Object.assign(new Error("persisted SIWE is expired or not yet valid"), { code: "AUTH_EXPIRED" });
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });
    await expect(targetAdapter.publish({
      source: new TextEncoder().encode("expired session"),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example",
    })).rejects.toMatchObject({ failure: { kind: "owner-space-unresolved", localKey: false } });
  });

  it("uses the credential holder for owner roots and the signed Policy/v3 revoke payload", async () => {
    ownerRootInputs.length = 0;
    sessionSignatures.length = 0;
    const originalFetch = globalThis.fetch;
    const revocations: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      revocations.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true });
    }) as unknown as typeof globalThis.fetch;

    nodeSpaceId = "tinycloud:transport-space";
    restoredSpaceId = "tinycloud:restored-owner-space";
    nativeSpaceId = restoredSpaceId;
    try {
      const { targetAdapter, revocation } = createShareAuthorityAdapters({
        origin: "https://share.example",
        profileName: async () => "test",
        fetchFn: (async (input: string | URL | Request) => {
          expect(String(input)).toBe("https://share.example/.well-known/tinycloud-share/config.json");
          return Response.json({
            version: "tinycloud.share/config-v2",
            shareOrigin: "https://share.example",
            registryOrigin: "https://registry.example",
            credentialsOrigin: "https://credentials.example",
          });
        }) as unknown as typeof globalThis.fetch,
      });

      const addressed = await targetAdapter.publish({
        source: new TextEncoder().encode("holder-bound share"),
        filename: "readme.txt",
        target: { kind: "email", address: "alice@example.com" },
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
        expiryWasExplicit: false,
        origin: "https://share.example",
        mediaType: "text/plain",
      });
      expect("state" in addressed).toBe(false);
      if ("state" in addressed) throw new Error("expected addressed publication");
      expect(addressed.metadata.expiryClamped).toBe(true);
      expect(new Date(addressed.metadata.expiresAt).getTime()).toBe(new Date("2099-01-01T00:00:00.000Z").getTime());
      expect(addressed.metadata.target.spaceId).toBe(restoredSpaceId);
      expect(uploadedSpaces).toEqual([restoredSpaceId]);
      expect(encryptionSpaces).toEqual([restoredSpaceId]);

      expect(addressed.metadata.ownerDid).toBe(credentialHolderDid);
      expect(ownerRootInputs.map(({ role }) => role)).toEqual(["policy-authority", "policy-enforcement"]);

      await revocation.revokePolicyRoot!({
        rootCid: "bafy-enforcement-root",
        targetRole: "policy-enforcement",
        ownerDid: credentialHolderDid,
        nodeOrigin: "https://node.example",
        nodeAudience: nodeDid,
      });

      expect(revocations).toHaveLength(1);
      expect(revocations[0]?.url).toBe("https://node.example/revoke");
      expect(revocations[0]?.body).toMatchObject({
        revocation: {
          schema: "xyz.tinycloud.policy/root-revocation/v1",
          targetCid: "bafy-enforcement-root",
          targetRole: "policy-enforcement",
          ownerDid: credentialHolderDid,
          issuerDid: credentialHolderDid,
          nodeAudience: nodeDid,
          reason: "share revoked",
          signature: { suite: "Ed25519", signerDid: credentialHolderDid },
        },
      });
      expect(sessionSignatures).toHaveLength(3);
      expect(sessionSignatures.at(-1)).toHaveLength(32);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const addressedAdapter = () => createShareAuthorityAdapters({
    origin: "https://share.example",
    profileName: async () => "test",
    fetchFn: (async () => Response.json({
      version: "tinycloud.share/config-v2",
      shareOrigin: "https://share.example",
      registryOrigin: "https://registry.example",
      credentialsOrigin: "https://credentials.example",
    })) as unknown as typeof globalThis.fetch,
  }).targetAdapter;
  const addressedInput = (target: TargetPublishInput["target"], actions?: TargetPublishInput["actions"]): TargetPublishInput => ({
    source: new TextEncoder().encode("only me"),
    filename: "note.md",
    target,
    ...(actions === undefined ? {} : { actions }),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    origin: "https://share.example",
    mediaType: "text/markdown",
  });

  it("publishes owner-only email shares a receiver can open (TC-556)", async () => {
    const published = await addressedAdapter().publish(addressedInput({ kind: "email", address: "Owner@Example.COM" }));
    if ("state" in published) throw new Error("expected addressed publication");
    // The viewer verifies the node binding against the owner's registry record,
    // so it must exist before the invitation does.
    expect(publishEvents).toEqual(["location https://registry.example", "upload"]);
    // The issuer accepts only the lowercase mailbox, so the matcher is canonical.
    expect(published.metadata.recipientMatcher).toEqual({ kind: "exactEmail", value: "owner@example.com" });
    // The accountless receiver accepts only Policy/v2 and rebuilds the
    // requirement from the signed recipient matcher, exactly as here.
    expect(registeredPolicies).toHaveLength(1);
    const policy = unifiedPolicyV2Schema.parse(registeredPolicies[0]);
    const commitment = policy.credentialRequirement;
    const requirement = createEmailCredentialRequirement({ email: "owner@example.com", profile: commitment.profile, credentialType: commitment.credentialType });
    expect(await credentialRequirementDigest(requirement)).toBe(commitment.requirementDigest);
    expect(commitment.descriptorDigest).toBe(await goldenDescriptorDigest("email"));
  });

  it("publishes view-only email-domain shares with the domain credential commitment", async () => {
    const published = await addressedAdapter().publish(addressedInput({ kind: "emailDomain", domain: "Example.com" }));
    if ("state" in published) throw new Error("expected addressed publication");
    expect(published.metadata.recipientMatcher).toEqual({ kind: "emailDomain", value: "example.com" });
    const commitment = unifiedPolicyV2Schema.parse(registeredPolicies[0]).credentialRequirement;
    const requirement = createEmailDomainCredentialRequirement({ domain: "example.com", profile: commitment.profile, credentialType: commitment.credentialType });
    expect(await credentialRequirementDigest(requirement)).toBe(commitment.requirementDigest);
    expect(commitment.descriptorDigest).toBe(await goldenDescriptorDigest("email-domain-proof-v1"));
  });

  it("refuses invalid addressed recipients before publishing a location or uploading", async () => {
    const adapter = addressedAdapter();
    await expect(adapter.publish(addressedInput({ kind: "emailDomain", domain: "example.123" })))
      .rejects.toMatchObject({ failure: { kind: "invalid-request", reason: "recipient email domain is invalid" } });
    await expect(adapter.publish(addressedInput({ kind: "email", address: "a%b@example.com" })))
      .rejects.toMatchObject({ failure: { kind: "invalid-request", reason: "recipient email is invalid" } });
    expect(publishEvents).toEqual([]);
    expect(uploadedSpaces).toEqual([]);
  });

  it("separates a retryable registry outage from a rejection, and uploads nothing either way", async () => {
    const cases: Array<[unknown, "registry-unavailable" | "registry-rejected"]> = [
      [new TypeError("fetch failed"), "registry-unavailable"],
      [new LocationRegistryHttpError("location registry publish returned HTTP 503", 503), "registry-unavailable"],
      [new LocationRegistryHttpError("location registry publish returned HTTP 429", 429), "registry-unavailable"],
      [new LocationRegistryHttpError("location registry publish returned HTTP 400", 400), "registry-rejected"],
      [new LocationRegistryHttpError("location registry returned HTTP 403", 403), "registry-rejected"],
      [new LocationRecordValidationError("existing location record signature is invalid"), "registry-rejected"],
    ];
    for (const [error, kind] of cases) {
      registryError = error;
      await expect(addressedAdapter().publish(addressedInput({ kind: "email", address: "owner@example.com" })))
        .rejects.toMatchObject({ failure: { kind } });
    }
    expect(uploadedSpaces).toEqual([]);
  });

  it("refuses a bearer share the session cannot delegate before uploading anything", async () => {
    const bearer = { ...addressedInput({ kind: "bearer" }), filename: "report.md" };
    sharingPreflight = "caveated";
    await expect(addressedAdapter().publish(bearer)).rejects.toMatchObject({ failure: { kind: "caveated-session", profileName: "test" } });
    sharingPreflight = "not-covered";
    await expect(addressedAdapter().publish(bearer)).rejects.toMatchObject({ failure: { kind: "scope-denied", capability: "sharing delegation", profileName: "test" } });
    expect(publishEvents).toEqual([]);
    expect(uploadedPaths).toEqual([]);
    // Exactly the delegation createNativeShare will request.
    expect(preflightRequests).toHaveLength(2);
    expect(preflightRequests[0]).toEqual({
      path: expect.stringMatching(/^xyz\.tinycloud\.share\/shares\/[0-9a-f]{32}\/report\.md$/),
      actions: ["tinycloud.kv/get"],
      expiry: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  it("does not preflight addressed shares or signer-backed bearer shares", async () => {
    sharingPreflight = "caveated";
    const addressed = await addressedAdapter().publish(addressedInput({ kind: "email", address: "owner@example.com" }));
    expect("state" in addressed).toBe(false);
    sessionOnly = false;
    const bearer = await addressedAdapter().publish(addressedInput({ kind: "bearer" }));
    expect("state" in bearer).toBe(false);
    expect(preflightRequests).toEqual([]);
    expect(uploadedPaths).toHaveLength(2);
  });

  it("keeps a lost-response retry identical after the clock advances and the adapter is recreated", async () => {
    deliveryAuthorizationInputs.length = 0;
    deliveryAuthorization = undefined;
    deliveryAuthorizationConflicts = 0;
    const originalNow = Date.now;
    let now = Date.parse("2026-09-15T01:00:00.000Z");
    Date.now = () => now;
    let invitationAttempts = 0;
    const invitationBodies: string[] = [];
    try {
      const link = await encodeSealedInlineShareUrl({
        origin: "https://share.example",
        ciphertext: new Uint8Array([1, 2, 3]),
        key32: new Uint8Array(32).fill(7),
      });
      const record: SenderShareRecord = {
        shareId: "share-retry",
        target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
        resource: { kind: "exact", path: "shares/share-retry/readme.md" },
        actions: ["tinycloud.kv/get"],
        recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
        registeredAt: "2026-09-15T01:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z",
        link,
        filename: "readme.md",
        deliveryMaterial: {
          envelope: {
            version: 3,
            recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
            deliveryEmail: "alice@example.com",
            actions: ["read"],
            display: { filename: "readme.md" },
            policy: { credentialRequirement: { credentialType: { id: "opencredentials.email/v1", version: 1 } } },
            expiry: "2030-01-01T00:00:00Z",
          },
          sealedEnvelope: "AQ",
          envelopeKey: "A".repeat(43),
          shareCid: "bafkreibm6jg3ux5qucnwb24kinphs4b5fbc7n5t3lti2skm4du5qjn4fli",
        },
      };
      const createDelivery = () => createShareAuthorityAdapters({
        origin: "https://share.example",
        profileName: async () => "test",
        fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/.well-known/tinycloud-share/config.json")) {
            return Response.json({
              version: "tinycloud.share/config-v2",
              shareOrigin: "https://share.example",
              registryOrigin: "https://registry.example",
              credentialsOrigin: "https://credentials.example",
            });
          }
          expect(url).toBe("https://credentials.example/v1/credential-invitations");
          invitationAttempts += 1;
          invitationBodies.push(String(init?.body));
          if (invitationAttempts === 1) {
            throw new Error("response lost after Node authorization");
          }
          return Response.json({ status: "accepted" }, { status: 202 });
        }) as unknown as typeof globalThis.fetch,
      }).delivery;

      const first = await notifyShare({
        shareId: record.shareId,
        recipient: "alice@example.com",
        record,
        adapter: createDelivery(),
        maxAttempts: 1,
      });
      expect(first).toMatchObject({ state: "partial-failure", attempts: 1 });

      now += 2_000;
      await expect(notifyShare({
        shareId: record.shareId,
        recipient: "alice@example.com",
        record,
        adapter: createDelivery(),
        maxAttempts: 1,
      })).resolves.toMatchObject({ state: "delivered", attempts: 1, idempotencyKey: first.idempotencyKey });

      expect(deliveryAuthorizationInputs).toHaveLength(2);
      expect(deliveryAuthorizationInputs[1]).toEqual(deliveryAuthorizationInputs[0]);
      expect(deliveryAuthorizationInputs[0]?.expiresAt).toBe("2026-09-15T01:05:00.000Z");
      expect(Date.parse(String(deliveryAuthorizationInputs[1]?.expiresAt)) - now).toBe(298_000);
      expect(deliveryAuthorizationConflicts).toBe(0);
      expect(invitationBodies[1]).toBe(invitationBodies[0]);
      now = Date.parse("2026-09-15T01:05:00.000Z");
      await expect(notifyShare({
        shareId: record.shareId,
        recipient: "alice@example.com",
        record,
        adapter: createDelivery(),
      })).resolves.toMatchObject({ state: "partial-failure", attempts: 1, retryable: false, reason: "delivery-window-expired" });
      expect(deliveryAuthorizationInputs).toHaveLength(2);
    } finally {
      Date.now = originalNow;
    }
  });

  /** Real adapters whose credentials service accepts and records every invitation. */
  const deliveringAdapters = () => {
    const invitations: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://credentials.example/v1/credential-invitations") {
        invitations.push(String(init?.body));
        return Response.json({ status: "accepted" }, { status: 202 });
      }
      if (url === "https://node.example/info") {
        nodeInfoRequests.push(init ?? {});
        return Response.json({ version: advertisedNodeVersion ?? nodeContract }, { status: nodeInfoStatus });
      }
      return Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      });
    }) as unknown as typeof globalThis.fetch;
    return { invitations, ...createShareAuthorityAdapters({ origin: "https://share.example", profileName: async () => "test", fetchFn }) };
  };

  it("gates domain invitations by version but admits a session-only publisher's own policy", async () => {
    nodeContract = "1.17.2";
    const adapters = deliveringAdapters();
    const domain = { ...addressedInput({ kind: "emailDomain", domain: "example.com" }, ["read", "edit"]), notify: true };
    await expect(adapters.targetAdapter.publish(domain))
      .rejects.toMatchObject({ failure: { kind: "invalid-request", reason: expect.stringContaining("1.17.3") } });
    expect(publishEvents).toEqual([]);
    expect(registeredPolicies).toHaveLength(0);

    nodeContract = "1.17.3";
    sessionOnly = true;
    const published = await adapters.targetAdapter.publish(domain);
    if ("state" in published) throw new Error("expected addressed publication");
    const record = historyRecordForPublishedShare(published);
    expect(record.ownerDid).toBe(credentialHolderDid);
    const result = await notifyShare({ shareId: record.shareId, recipient: "Bob@Example.COM", record, adapter: adapters.delivery });
    expect(result.state).toBe("delivered");
    expect(deliveryAuthorizationInputs[0]?.recipientEmail).toBe("bob@example.com");
    expect(adapters.invitations).toHaveLength(1);

    invokerDid = `${transportDid}#session`;
    await expect(notifyShare({ shareId: record.shareId, recipient: "alice@example.com", record, adapter: adapters.delivery, maxAttempts: 1 }))
      .resolves.toMatchObject({ state: "partial-failure", attempts: 1 });
    expect(adapters.invitations).toHaveLength(1);
  });

  it("compares node semver and follows the SDK's /info redirects", async () => {
    nodeContract = "1.17.3";
    const adapters = deliveringAdapters();
    const domain = { ...addressedInput({ kind: "emailDomain", domain: "example.com" }), notify: true };
    for (const version of ["1.17.3-rc.1", "1.17.2", "1.18.0-01", "not-a-version"]) {
      advertisedNodeVersion = version;
      const publishRefusal = await adapters.targetAdapter.publish(domain).then(() => undefined, (error: unknown) => error);
      expect(publishRefusal).toBeInstanceOf(SharePublishAuthorityError);
      if (!(publishRefusal instanceof SharePublishAuthorityError) || publishRefusal.failure.kind !== "invalid-request") throw publishRefusal;
      expect(publishRefusal.failure.reason).toContain(version);
      expect(publishRefusal.failure.reason).toContain("nothing was shared and no invitation was sent");
      const notifyRefusal = await adapters.assertDomainDelivery().then(() => undefined, (error: unknown) => error);
      expect(notifyRefusal).toBeInstanceOf(SharePublishAuthorityError);
      if (!(notifyRefusal instanceof SharePublishAuthorityError) || notifyRefusal.failure.kind !== "invalid-request") throw notifyRefusal;
      expect(notifyRefusal.failure.reason).toContain(version);
      expect(notifyRefusal.failure.reason).toContain("no invitation was sent");
      expect(notifyRefusal.failure.reason).not.toContain("nothing was shared");
    }
    expect(publishEvents).toEqual([]);
    for (const version of ["1.18.0-beta.1", "v1.17.3", " 1.17.3 ", "1.17.3+build.4"]) {
      advertisedNodeVersion = version;
      const published = await adapters.targetAdapter.publish(domain);
      expect("state" in published).toBe(false);
      await expect(adapters.assertDomainDelivery()).resolves.toBeUndefined();
    }
    expect(nodeInfoRequests.every((options) => options.redirect !== "error")).toBe(true);
    nodeInfoStatus = 503;
    await expect(adapters.targetAdapter.publish(domain)).rejects.toMatchObject({ failure: { kind: "node-info-unavailable" } });
    await expect(adapters.assertDomainDelivery()).rejects.toMatchObject({ failure: { kind: "node-info-unavailable" } });
  });

  it("classifies a stalled 200 /info body as unavailable, but malformed completed JSON as unsupported", async () => {
    let stalled = true;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        if (!stalled) return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(" ")); },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    let receivedHeaders = false;
    try {
      const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(new URL("/info", server.url), {
          ...init,
          signal: AbortSignal.any([init?.signal ?? new AbortController().signal, AbortSignal.timeout(500)]),
        });
        receivedHeaders = response.status === 200;
        return response;
      }) as typeof globalThis.fetch;
      const adapter = createShareAuthorityAdapters({ profileName: async () => "test", fetchFn });
      await expect(adapter.assertDomainDelivery()).rejects.toMatchObject({ failure: { kind: "node-info-unavailable" } });
      expect(receivedHeaders).toBe(true);
      stalled = false;
      await expect(adapter.assertDomainDelivery()).rejects.toMatchObject({
        failure: { kind: "invalid-request", reason: expect.stringContaining("(unrecognized)") },
      });
    } finally {
      server.stop(true);
    }
  });

  it("serializes profile history updates across adapters and preserves concurrent fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-lock-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(historyCacheDir, { recursive: true });
        const first = createEncryptedProfileHistory(async () => "history-test");
        const second = createEncryptedProfileHistory(async () => "history-test");
        const base: SenderShareRecord = {
          shareId: "share-history",
          target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/share-history/note.md" },
          actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "emailDomain", value: "example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
        await first.put(base);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const revoke = first.update!("share-history", async (current) => {
          entered.resolve();
          await release.promise;
          return { ...current, revokedAt: "2026-01-02T00:00:00.000Z" };
        });
        await entered.promise;
        const notify = second.update!("share-history", (current) => ({ ...current, deliveredRecipients: ["alice@example.com"] }));
        release.resolve();
        await Promise.all([revoke, notify]);
        expect(await first.get("share-history")).toMatchObject({
          revokedAt: "2026-01-02T00:00:00.000Z", deliveredRecipients: ["alice@example.com"],
        });
      });
    } finally {
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a history retry when the profile disappears after a successful node revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-revoke-removal-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(historyCacheDir, { recursive: true });
        const storage = createEncryptedProfileHistory(async () => "history-test");
        const record: SenderShareRecord = {
          shareId: "removed-after-revoke",
          target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/removed-after-revoke/note.md" },
          actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "emailDomain", value: "example.com" },
          ownerDid: credentialHolderDid,
          enforcementDelegationCid: "bafy-enforcement",
          registeredAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
        await storage.put(record);
        const { configureShareCommandServices } = await import("../commands/share.js");
        const { runShareCaptured } = await import("../commands/share.integration-harness.js");
        let revocations = 0;
        configureShareCommandServices({
          records: storage,
          revocation: {
            async revokePolicyRoot() { revocations++; historyProfileMissing = true; },
          },
        });
        const originalExit = process.exit;
        const exits: number[] = [];
        process.exit = ((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit;
        try {
          const output = await runShareCaptured(["share", "revoke", record.shareId]);
          expect(revocations).toBe(1);
          expect(exits).toEqual([1]);
          const failure = (JSON.parse(output.stderr) as { error: { code: string; hint?: string } }).error;
          expect(failure.code).toBe("SHARE_HISTORY_RETRY");
          expect(failure.hint).toContain("revocation may already have succeeded");
        } finally {
          process.exit = originalExit;
          configureShareCommandServices({});
        }
        historyProfileMissing = false;
        let selected = "history-test";
        const scoped = createEncryptedProfileHistory(async () => selected);
        expect(await scoped.get(record.shareId)).toBeDefined();
        historyMissingProfileName = "history-other";
        selected = "history-other";
        await expect(scoped.get(record.shareId)).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });
      });
    } finally {
      historyProfileMissing = false;
      historyMissingProfileName = undefined;
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an in-flight encrypted history write on its original profile after a salt race and default switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-profile-race-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyProfileDirectories = true;
        historyCacheDir = join(profilePath("history-a"), "cache");
        await Promise.all(["history-a", "history-b"].map((name) => mkdir(join(profilePath(name), "cache"), { recursive: true })));
        let selected = "history-a";
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let gateFirst = true;
        historyBeforeLock = async (profile) => {
          if (profile === "history-a" && gateFirst) {
            gateFirst = false;
            entered.resolve();
            await release.promise;
          }
        };
        const first = createEncryptedProfileHistory(async () => selected);
        const writerA = createEncryptedProfileHistory(async () => "history-a");
        const writerB = createEncryptedProfileHistory(async () => "history-b");
        const record: SenderShareRecord = {
          shareId: "first", link: "https://share.example/s/inline#v=2&p=sealed",
          target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/first/note.md" }, actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
        };
        const pending = first.put(record);
        try {
          await entered.promise;
          await writerA.put({ ...record, shareId: "second" });
          // First passed the profile check but has not read the new salt.
          historyOnCacheAccess = (profile) => {
            if (profile === "history-a") {
              selected = "history-b";
              historyOnCacheAccess = undefined;
            }
          };
          release.resolve();
          await pending;
          expect(selected).toBe("history-b");
          expect(await writerA.get("first")).toMatchObject({ link: record.link });
          expect(await writerA.get("second")).toBeDefined();
          expect(await writerB.get("first")).toBeUndefined();
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
          historyBeforeLock = undefined;
          historyOnCacheAccess = undefined;
        }
      });
    } finally {
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reselect the default profile after OpenKey signs the history key", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-openkey-profile-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyLocalKey = false;
        historyProfileDirectories = true;
        historyCacheDir = join(profilePath("history-a"), "cache");
        await Promise.all(["history-a", "history-b"].map((name) => mkdir(join(profilePath(name), "cache"), { recursive: true })));
        let selected = "history-a";
        let selections = 0;
        historyOnSign = () => { selected = "history-b"; historyOnSign = undefined; };
        const storage = createShareAuthorityAdapters({ profileName: async () => { selections++; return selected; } }).records;
        const record: SenderShareRecord = {
          shareId: "openkey-a", link: "https://share.example/s/inline#v=2&p=sealed",
          target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/openkey-a/note.md" }, actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
        };
        await storage.put(record);
        expect(selections).toBe(1);
        expect(selected).toBe("history-b");
        const pinned = createShareAuthorityAdapters({ profileName: async () => "history-a" }).records;
        const other = createShareAuthorityAdapters({ profileName: async () => "history-b" }).records;
        expect(await pinned.get(record.shareId)).toMatchObject({ link: record.link });
        expect(await other.get(record.shareId)).toBeUndefined();
      });
    } finally {
      historyOnSign = undefined;
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a published share under its authenticated profile after the default changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-publish-default-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyProfileDirectories = true;
        historyCacheDir = join(profilePath("history-a"), "cache");
        await Promise.all(["history-a", "history-b"].map((name) => mkdir(join(profilePath(name), "cache"), { recursive: true })));
        let selected = "history-a";
        const selections: string[] = [];
        const adapters = createShareAuthorityAdapters({
          profileName: async () => { selections.push(selected); return selected; },
          origin: "https://share.example",
          fetchFn: (async () => Response.json({
            version: "tinycloud.share/config-v2",
            shareOrigin: "https://share.example",
            registryOrigin: "https://registry.example",
            credentialsOrigin: "https://credentials.example",
          })) as unknown as typeof globalThis.fetch,
        });
        const published = await adapters.targetAdapter.publish(addressedInput({ kind: "email", address: "alice@example.com" }));
        if ("state" in published) throw new Error("expected publication from history-a");
        expect(selections).toEqual(["history-a"]);
        selected = "history-b";
        await adapters.records.put(historyRecordForPublishedShare(published));
        const original = createEncryptedProfileHistory(async () => "history-a");
        const other = createEncryptedProfileHistory(async () => "history-b");
        expect(await original.get(published.metadata.shareId)).toMatchObject({ link: published.url });
        expect(await other.get(published.metadata.shareId)).toBeUndefined();
        expect(selections).toEqual(["history-a"]);
      });
    } finally {
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores an unrelated profile setting edited while acquiring the history lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-settings-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(historyCacheDir, { recursive: true });
        const record: SenderShareRecord = {
          shareId: "settings", target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/settings/note.md" }, actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
        };
        const storage = createEncryptedProfileHistory(async () => "history-test");
        await storage.put(record);
        historyBeforeLock = async () => { historySpaceName = "renamed-space"; };
        await storage.update!("settings", (current) => ({ ...current, revokedAt: "2026-01-02T00:00:00.000Z" }));
        expect(await storage.get(record.shareId)).toMatchObject({ revokedAt: "2026-01-02T00:00:00.000Z" });
      });
    } finally {
      historyBeforeLock = undefined;
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns once after a prolonged second-process profile lock wait and preserves the history write", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-wait-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(historyCacheDir, { recursive: true });
        const storage = createEncryptedProfileHistory(async () => "history-test");
        const record: SenderShareRecord = {
          shareId: "lock-wait", target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/lock-wait/note.md" }, actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
        };
        await storage.put(record);
        const finishChild = await acquireProfileLockInChild(root, 2700, 1000);
        const warnings: string[] = [];
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
        try {
          await storage.put({ ...record, revokedAt: "2026-01-02T00:00:00.000Z" });
          expect(await storage.get(record.shareId)).toMatchObject({ revokedAt: "2026-01-02T00:00:00.000Z" });
        } finally {
          process.stderr.write = originalWrite;
          await finishChild();
        }
        expect(warnings).toEqual([expect.stringContaining('Waiting for profile lock for "history-test"')]);
      });
    } finally {
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a blocked OpenKey signer outside the lock and re-prepares after a key-input change", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-signer-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        historyLocalKey = false;
        await mkdir(historyCacheDir, { recursive: true });
        const record: SenderShareRecord = {
          shareId: "signer-wait", target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/signer-wait/note.md" }, actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
        };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let observedSignerProfile: string | undefined;
        const signer = async (_bytes: Uint8Array, profile: string) => {
          observedSignerProfile = profile;
          entered.resolve();
          await release.promise;
          return new TextEncoder().encode("session-signature");
        };
        const storage = createEncryptedProfileHistory(async () => "history-test", signer);
        const writing = storage.put(record);
        try {
          await entered.promise;
          const finishChild = await acquireProfileLockInChild(root, 25, 300);
          await finishChild();
        } finally {
          release.resolve();
          await writing.catch(() => undefined);
        }
        expect(observedSignerProfile).toBe("history-test");

        const changed = Promise.withResolvers<void>();
        const finishSigning = Promise.withResolvers<void>();
        const rotating = createEncryptedProfileHistory(async () => "history-test", async () => {
          changed.resolve();
          await finishSigning.promise;
          return new TextEncoder().encode("session-signature");
        });
        const update = rotating.put({ ...record, revokedAt: "2026-01-02T00:00:00.000Z" });
        await changed.promise;
        historyKeyId = "key-two";
        finishSigning.resolve();
        await update;
        expect(await storage.get(record.shareId)).toMatchObject({ revokedAt: "2026-01-02T00:00:00.000Z" });
      });
    } finally {
      historyCacheDir = undefined;
      historyLocalKey = true;
      historyKeyId = "key-one";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports retryable history failures after bounded key churn or removal of the pinned profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-churn-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        historyLocalKey = false;
        await mkdir(historyCacheDir, { recursive: true });
        const record: SenderShareRecord = {
          shareId: "churn", target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
          resource: { kind: "exact", path: "shares/churn/note.md" }, actions: ["tinycloud.kv/get"],
          recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
          registeredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
        };
        const storage = createEncryptedProfileHistory(async () => "history-test", async () => new TextEncoder().encode("session-signature"));
        let changes = 0;
        historyBeforeLock = async () => { historyKeyId = `key-${++changes}`; };
        await expect(storage.put(record)).rejects.toMatchObject({ code: "SHARE_HISTORY_RETRY", profile: "history-test" });
        historyBeforeLock = async () => { historyProfileMissing = true; };
        await expect(storage.put(record)).rejects.toMatchObject({ code: "SHARE_HISTORY_RETRY", profile: "history-test" });
        historyBeforeLock = undefined;
        historyProfileMissing = false;
        expect(await storage.get(record.shareId)).toBeUndefined();
      });
    } finally {
      historyBeforeLock = undefined;
      historyProfileMissing = false;
      historyCacheDir = undefined;
      historyLocalKey = true;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a typed retry error when a resolved signer context belongs to another profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-context-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        historyLocalKey = false;
        historyResolvedProfile = "history-other";
        await mkdir(historyCacheDir, { recursive: true });
        const storage = createShareAuthorityAdapters({ profileName: async () => "history-test" }).records;
        await expect(storage.list()).rejects.toMatchObject({ code: "SHARE_HISTORY_RETRY", profile: "history-test" });
      });
    } finally {
      historyResolvedProfile = undefined;
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes an email share whose --notify invitation the Node authorizes and delivers (TC-571)", async () => {
    const adapters = deliveringAdapters();
    const { invitations } = adapters;

    const published = await adapters.targetAdapter.publish(addressedInput({ kind: "email", address: "Alice@Example.COM" }));
    if ("state" in published) throw new Error("expected addressed publication");
    const record = historyRecordForPublishedShare(published);
    // The signed envelope names the canonical mailbox the Node delivers to.
    expect(record.deliveryMaterial?.envelope).toMatchObject({
      recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
      deliveryEmail: "alice@example.com",
    });

    const result = await notifyShare({ shareId: record.shareId, recipient: "Alice@Example.COM", record, adapter: adapters.delivery });

    expect(result).toMatchObject({ state: "delivered", attempts: 1 });
    expect(deliveryAuthorizationInputs).toHaveLength(1);
    expect(deliveryAuthorizationInputs[0]).toMatchObject({ recipientEmail: "alice@example.com", documentName: "note.md" });
    expect(invitations).toHaveLength(1);
  });

  it("publishes mailboxes the envelope cannot pin unpinned; node 1.17.3 still delivers them", async () => {
    for (const address of ["a/b@example.com", "alice@example.xn--p1ai"]) {
      const uploadsBefore = uploadedPaths.length;
      const policiesBefore = registeredPolicies.length;
      const adapters = deliveringAdapters();
      const published = await adapters.targetAdapter.publish(addressedInput({ kind: "email", address }));
      if ("state" in published) throw new Error("expected addressed publication");
      // One upload, one registration, and both belong to a published share.
      expect(uploadedPaths.length - uploadsBefore).toBe(1);
      expect(registeredPolicies.length - policiesBefore).toBe(1);
      const record = historyRecordForPublishedShare(published);
      expect(record.deliveryMaterial?.envelope).toMatchObject({ recipientMatcher: { kind: "exactEmail", value: address } });
      expect(record.deliveryMaterial?.envelope).not.toHaveProperty("deliveryEmail");

      // 1.17.2 requires the pin, so these rare mailboxes cannot be emailed there.
      nodeContract = "1.17.2";
      await expect(notifyShare({ shareId: record.shareId, recipient: address, record, adapter: adapters.delivery, maxAttempts: 1 }))
        .resolves.toMatchObject({ state: "partial-failure" });
      nodeContract = "1.17.3";
      await expect(notifyShare({ shareId: record.shareId, recipient: address, record, adapter: adapters.delivery }))
        .resolves.toMatchObject({ state: "delivered", attempts: 1 });
      expect(adapters.invitations).toHaveLength(1);
    }
  });

});
