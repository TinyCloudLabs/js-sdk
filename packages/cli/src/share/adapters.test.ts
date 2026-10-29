import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { profilePath, withProfileLock, withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { fromBase64Url, unifiedPolicyV2Schema } from "@tinycloud/share-envelope";
import { buildShortLink } from "@tinycloud/share-envelope/links";
import { ADDRESSED_SHARE_TOO_LARGE_MESSAGE, historyRecordForPublishedShare, notifyShare, revokeShare, type PublishedShare, type SenderShareRecord, type ShareNotifyResult, type SharePolicyRootRevocation, type TargetPublishInput } from "@tinycloud/share-sdk";
import { shortLinkId } from "./short-links.js";
import { createEmailCredentialRequirement, createEmailDomainCredentialRequirement, credentialRequirementDigest, LocationRecordValidationError, LocationRegistryHttpError, ShareDeliveryRefusedError } from "@tinycloud/sdk-core";
import { CLIError } from "../output/errors.js";
import { ShareHistoryReadError, ShareHistoryRetryError, ShareHistoryUnreadableError, SharePublishAuthorityError, shareHistoryReason } from "./errors.js";

const transportDid = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX";
/** The session key signs the envelope and every link header, so its DID is the credential holder. */
const holderSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const credentialHolderDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(holderSeed)]))}`;
const canonicalOwnerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const nodeDid = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";
const ownerRootInputs: Array<{ readonly ownerDid: string; readonly role: string }> = [];
const sessionSignatures: Uint8Array[] = [];
const deliveryAuthorizationInputs: Array<Record<string, unknown>> = [];
let deliveryAuthorization: { readonly key: string; readonly body: string; readonly receipt: Record<string, unknown> } | undefined;
let deliveryAuthorizationConflicts = 0;
const publishEvents: string[] = [];
const registeredPolicies: unknown[] = [];
/** The owner's KV as the artifact layout sees it: write-once creates, reads and prefix lists. */
const ownerKv = new Map<string, Uint8Array>();
let encryptions = 0;
/** When set, the stub node's owner roots carry this authorization: a root far larger than any real one. */
let oversizedRootAuthorization: string | undefined;

let nodeSpaceId: string | undefined = "tinycloud:test-space";
let restoredSpaceId: string | undefined = "tinycloud:test-space";
let nativeSpaceId = "tinycloud:test-space";
const uploadedSpaces: string[] = [];
const uploadedPaths: string[] = [];
const encryptionSpaces: string[] = [];
let sessionOnly = true;
let holdsDecrypt = true;
const decryptChecks: unknown[] = [];
let invokerDid = credentialHolderDid;
let nodeInfoStatus = 200;
const nodeInfoRequests: RequestInit[] = [];
let historyCacheDir: string | undefined;
let historyLocalKey = true;
let historySignedOut = false;
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
let listErrorCode: string | undefined;
let uploadErrorMeta: Record<string, unknown> | undefined;
/** The Node has no row for the owner space: every write answers 404 "Space not found". */
let spaceUnhosted = false;
let sessionExpiresAt = "2099-01-01T00:00:00.000Z";
let authenticationError: unknown;
let registryError: unknown;
let sharingPreflight: "ok" | "caveated" | "not-covered" = "ok";
let nodeContract: "1.17.2" | "1.17.3" = "1.17.2";
let advertisedNodeVersion: string | undefined;
const preflightRequests: Array<{ readonly path: string; readonly actions?: string[]; readonly expiry?: Date }> = [];
const emailDescriptor = ((await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json()) as { vectors: { name: string; descriptor: unknown }[] }).vectors.find((vector) => vector.name === "email")!.descriptor;
const emailCredentialInputs = {
  credentialDescriptor: emailDescriptor,
  issuerDid: "did:web:issuer.credentials.org",
  issuerKid: "did:web:issuer.credentials.org#controller",
};

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
  getDefaultEncryptionNetworkId: () => `urn:tinycloud:encryption:${canonicalOwnerDid}:default`,
  hasRuntimePermissions: (entries: unknown) => {
    decryptChecks.push(entries);
    return holdsDecrypt;
  },
  encryption: {
    encryptToNetwork: async (networkId: string, _bytes: Uint8Array, options?: { readonly keyPath?: string }) => {
      encryptions += 1;
      return {
        ok: true as const,
        data: {
          v: 1,
          networkId,
          ...(options?.keyPath === undefined ? {} : { keyPath: options.keyPath }),
          alg: "x25519-aes256gcm/v1",
          keyVersion: 1,
          encryptedSymmetricKey: "network-wrapped-key",
          // A fresh wrapped key per encryption, so reuse of an earlier ciphertext is observable.
          encryptedSymmetricKeyHash: encryptions.toString(16).padStart(64, "0"),
          ciphertext: "AQ",
          metadata: { contentType: "text/plain" },
        },
      };
    },
  },
  kvForSpace: (spaceId: string) => ({
    put: async (path: string, bytes?: Uint8Array, options?: { readonly ifNoneMatch?: "*" }) => {
      publishEvents.push("upload");
      uploadedSpaces.push(spaceId);
      uploadedPaths.push(path);
      if (spaceUnhosted) {
        return { ok: false as const, error: { code: "KV_WRITE_FAILED", message: `Failed to put key ${JSON.stringify(path)}: 404 - Space not found`, service: "kv", meta: { status: 404 } } };
      }
      if (uploadErrorCode === undefined && options?.ifNoneMatch === "*" && ownerKv.has(path)) {
        return { ok: false as const, error: { code: "KV_PRECONDITION_FAILED", message: "exists", service: "kv", meta: { status: 412 } } };
      }
      if (uploadErrorCode === undefined && bytes !== undefined) ownerKv.set(path, bytes.slice());
      return uploadErrorCode === undefined
        ? { ok: true as const }
        : { ok: false as const, error: { code: uploadErrorCode, message: "secret server response", service: "kv", meta: uploadErrorMeta ?? { status: uploadErrorCode === "STORAGE_QUOTA_EXCEEDED" ? 402 : 503, usedBytes: 387_382_794, limitBytes: 8_119_195, requiredAction: "tinycloud.kv/put" } } };
    },
    delete: async (path: string) => {
      publishEvents.push("delete");
      ownerKv.delete(path);
      return { ok: true as const };
    },
    get: async (path: string) => {
      const value = ownerKv.get(path);
      return value === undefined
        ? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing", service: "kv" } }
        : { ok: true as const, data: { data: value.slice(), headers: {} } };
    },
    list: async (options: { readonly prefix: string }) => listErrorCode === undefined
      ? { ok: true as const, data: { keys: [...ownerKv.keys()].filter((key) => key.startsWith(options.prefix)) } }
      : { ok: false as const, error: { code: listErrorCode, message: "denied", service: "kv", meta: { status: 401, requiredAction: "tinycloud.kv/list" } } },
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
      delegationHeader: { Authorization: oversizedRootAuthorization ?? (input.role === "policy-authority" ? "a.b.c" : "d.e.f") },
    };
  },
  signSessionBytes: async (bytes: Uint8Array) => {
    historyOnSign?.();
    sessionSignatures.push(bytes.slice());
    return ed25519.sign(bytes, holderSeed);
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
        : { authMethod: "openkey", spaceName: historySpaceName, authSignedOut: historySignedOut };
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

const { createEncryptedProfileHistory, createShareAuthorityAdapters, profileHistoryFileExists, quarantineUnreadableProfileHistory, signShareHistoryBytes } = await import("./adapters.js");
const { assertShareHistoryAllowsKeyDrop, checkShareHistoryForKeyDrop } = await import("./history-guard.js");

afterEach(() => {
  ownerKv.clear();
  encryptions = 0;
  oversizedRootAuthorization = undefined;
  nodeSpaceId = "tinycloud:test-space";
  restoredSpaceId = "tinycloud:test-space";
  nativeSpaceId = "tinycloud:test-space";
  uploadedPaths.length = 0;
  sessionOnly = true;
  holdsDecrypt = true;
  decryptChecks.length = 0;
  invokerDid = credentialHolderDid;
  nodeInfoStatus = 200;
  nodeInfoRequests.length = 0;
  uploadErrorCode = undefined;
  listErrorCode = undefined;
  uploadErrorMeta = undefined;
  spaceUnhosted = false;
  uploadedSpaces.length = 0;
  historyCacheDir = undefined;
  historyLocalKey = true;
  historySignedOut = false;
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
          ...(target.kind === "email" ? emailCredentialInputs : {}),
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
      ...emailCredentialInputs,
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
          ...(target.kind === "email" ? emailCredentialInputs : {}),
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
        ...emailCredentialInputs,
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
      expect(encryptionSpaces).toEqual([]);
      expect(decryptChecks).toEqual([[{
        service: "tinycloud.encryption",
        path: expect.stringMatching(new RegExp(`^urn:tinycloud:encryption:${canonicalOwnerDid}:default/share/[0-9a-f]{32}$`)),
        actions: ["tinycloud.encryption/decrypt"],
      }]]);

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
      // Policy, envelope and link header at publish, then the revocation.
      expect(sessionSignatures).toHaveLength(4);
      expect(sessionSignatures.at(-1)).toHaveLength(32);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("names the Share service, not the node, when the public config cannot be fetched", async () => {
    const cases: Array<[string, typeof globalThis.fetch]> = [
      ["refused", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch],
      ["HTTP 503", (async () => new Response("down", { status: 503 })) as unknown as typeof globalThis.fetch],
    ];
    for (const [label, fetchFn] of cases) {
      const { targetAdapter } = createShareAuthorityAdapters({ origin: "https://share.example", profileName: async () => "test", fetchFn });
      const outcome = await targetAdapter.publish({
        source: new TextEncoder().encode("x"), filename: "readme.txt",
        target: { kind: "email", address: "alice@example.com" },
        ...emailCredentialInputs,
        expiresAt: new Date("2100-01-01T00:00:00.000Z"), expiryWasExplicit: false,
        origin: "https://share.example", mediaType: "text/plain",
      }).then(() => undefined, (error: unknown) => error);
      expect({ label, failure: outcome instanceof SharePublishAuthorityError ? outcome.failure : outcome })
        .toEqual({ label, failure: { kind: "share-service-unavailable", origin: "https://share.example" } });
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
    ...(target.kind === "email" ? emailCredentialInputs : {}),
    ...(actions === undefined ? {} : { actions }),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    origin: "https://share.example",
    mediaType: "text/markdown",
  });

  it("refuses exact-email publication without a descriptor and issuer before side effects", async () => {
    const rawEmailInput: TargetPublishInput = {
      source: new TextEncoder().encode("only me"), filename: "note.md",
      target: { kind: "email", address: "owner@example.com" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example", mediaType: "text/markdown",
    };
    await expect(addressedAdapter().publish(rawEmailInput)).rejects.toThrow();
    expect(publishEvents).toEqual([]);
    expect(uploadedPaths).toEqual([]);
    expect(registeredPolicies).toEqual([]);
  });

  it("refuses exact-email CLI publication before every adapter side effect, even with valid credential flags", async () => {
    // Load the command graph after this file's profile/SDK module mocks.
    const { configureShareCommandServices } = await import("../commands/share.js");
    const { runShareCaptured } = await import("../commands/share.integration-harness.js");
    const root = await mkdtemp(join(tmpdir(), "tc-email-unavailable-adapter-"));
    const input = join(root, "note.md");
    const descriptor = join(root, "descriptor.json");
    let creates = 0;
    let configs = 0;
    const adapter = createShareAuthorityAdapters({
      origin: "https://share.example", profileName: async () => "test",
      fetchFn: (async () => {
        configs++;
        return Response.json({ version: "tinycloud.share/config-v2", shareOrigin: "https://share.example", registryOrigin: "https://registry.example", credentialsOrigin: "https://credentials.example" });
      }) as unknown as typeof globalThis.fetch,
    }).targetAdapter;
    configureShareCommandServices({ targetAdapter: { publish: async (request) => {
      creates++;
      return adapter.publish(request);
    } } });
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
    try {
      await writeFile(input, "synthetic refusal input");
      await writeFile(descriptor, JSON.stringify(emailDescriptor));
      const result = await runShareCaptured(["share", "publish", input, "--to", "email:owner@example.com", "--json",
        "--viewer-origin", "https://share.example", "--credential-descriptor", descriptor,
        "--issuer-did", emailCredentialInputs.issuerDid, "--issuer-kid", emailCredentialInputs.issuerKid]);
      expect(exitCode ?? result.exitCode).toBe(4);
      const error = JSON.parse(result.stderr).error as { code: string; message: string };
      expect(error.code).toBe("UNAVAILABLE");
      expect(error.message).toMatch(/unavailable|not available/i);
      expect(creates).toBe(0);
      expect(configs).toBe(0);
      expect(publishEvents).toEqual([]);
      expect(encryptions).toBe(0);
      expect(uploadedPaths).toEqual([]);
      expect(registeredPolicies).toEqual([]);
      expect(ownerRootInputs).toEqual([]);
      expect(sessionSignatures).toEqual([]);
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The history record of a share whose printed link is its short link: the only link an invitation carries. */
  const recordWithShortLink = (published: PublishedShare): SenderShareRecord => ({
    ...historyRecordForPublishedShare(published),
    link: buildShortLink({
      origin: "https://share.example", type: "share", id: "a".repeat(26),
      key: fromBase64Url(published.deliveryMaterial!.envelopeKey), bodyCid: published.deliveryMaterial!.shareCid,
    }),
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

  describe("link size limit", () => {
    const config = (async () => Response.json({
      version: "tinycloud.share/config-v2",
      shareOrigin: "https://share.example",
      registryOrigin: "https://registry.example",
      credentialsOrigin: "https://credentials.example",
    })) as unknown as typeof globalThis.fetch;
    const email = { kind: "email", address: "alice@example.com" } as const;
    const adapterWithRevocation = (revokePolicyRoot: (request: SharePolicyRootRevocation) => Promise<void>) => createShareAuthorityAdapters({
      origin: "https://share.example", profileName: async () => "test", fetchFn: config, revokePolicyRoot,
    }).targetAdapter;
    const failureOf = (outcome: Promise<unknown>) => outcome.then(() => undefined, (error: unknown) => error);

    it("refuses a share whose largest sealed envelope is over the limit before any registry, upload or policy write", async () => {
      // The owner space id appears throughout the envelope; a very long one cannot fit in a link.
      restoredSpaceId = `tinycloud:${"a".repeat(5_000)}`;
      const failure = await failureOf(addressedAdapter().publish(addressedInput(email)));
      expect(failure).toMatchObject({ code: "max-bytes-exceeded", message: ADDRESSED_SHARE_TOO_LARGE_MESSAGE });
      expect(publishEvents).toEqual([]);
      expect(uploadedPaths).toEqual([]);
      expect(registeredPolicies).toEqual([]);
      expect(ownerRootInputs).toEqual([]);
      expect(sessionSignatures).toEqual([]);
      expect(encryptions).toBe(0);
    });

    it("removes what a publish wrote when the sealed envelope turns out over the limit", async () => {
      oversizedRootAuthorization = `a.${"b".repeat(70_000)}.c`;
      const revoked: SharePolicyRootRevocation[] = [];
      const failure = await failureOf(adapterWithRevocation(async (request) => { revoked.push(request); }).publish(addressedInput(email)));
      if (!(failure instanceof SharePublishAuthorityError) || failure.failure.kind !== "over-limit") throw failure;
      // Written, then removed: the object is uploaded and deleted, both roots revoked, the policy registered once.
      expect(publishEvents).toEqual(["location https://registry.example", "upload", "delete"]);
      expect(ownerKv.size).toBe(0);
      expect(registeredPolicies).toHaveLength(1);
      expect(revoked.map((request) => [request.rootCid, request.targetRole, request.ownerDid, request.nodeAudience])).toEqual([
        ["bafy-enforcement-root", "policy-enforcement", credentialHolderDid, nodeDid],
        ["bafy-policy-root", "policy-authority", credentialHolderDid, nodeDid],
      ]);
      // What cannot be removed is named; nothing else is.
      expect(failure.failure.remaining).toEqual([
        "a policy record stays on your node with both of its roots revoked, so it admits no one",
        "your node's location record stays in the TinyCloud registry, shared by all your shares",
      ]);
      // The link header was never signed: only the policy and the envelope were.
      expect(sessionSignatures).toHaveLength(2);
    });

    it("names a root that could not be revoked, a file that could not be deleted, and an artifact version that stays", async () => {
      oversizedRootAuthorization = `a.${"b".repeat(70_000)}.c`;
      const failure = await failureOf(adapterWithRevocation(async (request) => {
        if (request.targetRole === "policy-enforcement") throw new Error("node unavailable");
      }).publish({ ...addressedInput(email), artifact: { id: "art_over" } }));
      if (!(failure instanceof SharePublishAuthorityError) || failure.failure.kind !== "over-limit") throw failure;
      expect(failure.failure.remaining).toEqual([
        "the policy-enforcement root bafy-enforcement-root could not be revoked",
        "your node's location record stays in the TinyCloud registry, shared by all your shares",
        "artifact art_over version 1 stays in your space, because artifact versions are write-once",
      ]);
      expect(ownerKv.has("artifacts/art_over/versions/1/note.md")).toBe(true);
    });

    it("lists the registry location record among what stays behind, whatever else was removed", async () => {
      oversizedRootAuthorization = `a.${"b".repeat(70_000)}.c`;
      const failure = await failureOf(adapterWithRevocation(async () => {}).publish(addressedInput(email)));
      if (!(failure instanceof SharePublishAuthorityError) || failure.failure.kind !== "over-limit") throw failure;
      expect(failure.failure.remaining).toContain("your node's location record stays in the TinyCloud registry, shared by all your shares");
      // The registry write came first, before any content, so the record exists whenever a cleanup runs.
      expect(publishEvents[0]).toBe("location https://registry.example");
    });
  });

  describe("the delete-token record", () => {
    it("is neither written nor read by an addressed publish, a revoke and an unlink", async () => {
      const touched: string[] = [];
      const original = node.kvForSpace;
      const recording = (spaceId: string) => {
        const kv = original(spaceId);
        return {
          put: async (path: string, bytes?: Uint8Array, options?: { readonly ifNoneMatch?: "*" }) => { touched.push(`put ${path}`); return kv.put(path, bytes, options); },
          get: async (path: string) => { touched.push(`get ${path}`); return kv.get(path); },
          list: async (options: { readonly prefix: string }) => { touched.push(`list ${options.prefix}`); return kv.list(options); },
          delete: async (path: string) => { touched.push(`delete ${path}`); return kv.delete(path); },
        };
      };
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/.well-known/tinycloud-share/config.json")) {
          return Response.json({ version: "tinycloud.share/config-v2", shareOrigin: "https://share.example", registryOrigin: "https://registry.example", credentialsOrigin: "https://credentials.example" });
        }
        if (url === "https://api.tinycloud.xyz/v1/links") {
          return Response.json({ id: "a".repeat(26), expiresAt: (JSON.parse(String(init?.body)) as { header: { expiresAt: string } }).header.expiresAt }, { status: 201 });
        }
        if (url === `https://api.tinycloud.xyz/v1/links/${"a".repeat(26)}/delete`) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${url}`);
      }) as unknown as typeof globalThis.fetch;
      Object.defineProperty(node, "kvForSpace", { value: recording, configurable: true, writable: true });
      try {
        const adapters = createShareAuthorityAdapters({ origin: "https://share.example", profileName: async () => "test", fetchFn, revokePolicyRoot: async () => {} });
        const published = await adapters.targetAdapter.publish({ ...addressedInput({ kind: "email", address: "alice@example.com" }), expiresAt: new Date(Date.now() + 7 * 86_400_000) });
        if ("state" in published) throw new Error("expected addressed publication");
        const shown = await adapters.links.show(published, { fullLink: false });
        expect(shown.short).toBe(true);
        const record: SenderShareRecord = { ...historyRecordForPublishedShare(published), link: shown.url };
        expect((await revokeShare({ record, adapter: adapters.revocation })).state).toBe("revoked");
        expect(await adapters.links.unlink(shortLinkId(shown.url)!)).toBe("deleted");
        // The only space access is the content upload: no token key is written, read, listed or deleted.
        expect(touched).toEqual([`put ${uploadedPaths[0]}`]);
        expect(touched.filter((entry) => entry.includes("short-link"))).toEqual([]);
      } finally {
        Object.defineProperty(node, "kvForSpace", { value: original, configurable: true, writable: true });
      }
    });
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

  describe("owner space not found on upload (TC-1578)", () => {
    const publish = (target: TargetPublishInput["target"], artifact?: { id: string }) => createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    }).targetAdapter.publish({
      source: new TextEncoder().encode("report"),
      filename: "report.md",
      target,
      ...(target.kind === "email" ? emailCredentialInputs : {}),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example",
      ...(artifact === undefined ? {} : { artifact }),
    });

    it("types a 404 Space not found on the upload as space-not-ready, once, for bearer, addressed and artifact shares", async () => {
      for (const [target, artifact] of [[{ kind: "bearer" as const }, undefined], [{ kind: "email" as const, address: "alice@example.com" }, undefined], [{ kind: "bearer" as const }, { id: "art_t" }]] as const) {
        spaceUnhosted = true;
        uploadedPaths.length = 0;
        const error = await publish(target, artifact).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(SharePublishAuthorityError);
        expect((error as InstanceType<typeof SharePublishAuthorityError>).failure).toEqual({ kind: "space-not-ready" });
        // The Node's own error is kept on `cause`, not in the message; nothing retries.
        expect((error as Error).cause).toMatchObject({ message: expect.stringContaining("404 - Space not found") });
        expect((error as Error).message).not.toContain("Space not found");
        expect(uploadedPaths).toHaveLength(1);
      }
    });

    it("does not remap other upload failures, including other 404s", async () => {
      for (const [code, meta, kind] of [["UNAVAILABLE", undefined, "upload-failed"], ["KV_NOT_FOUND", { status: 404 }, "upload-failed"], ["STORAGE_QUOTA_EXCEEDED", { status: 402 }, "storage-full"]] as const) {
        uploadErrorCode = code;
        uploadErrorMeta = meta;
        await expect(publish({ kind: "bearer" })).rejects.toMatchObject({ failure: { kind } });
      }
    });
  });

  describe("artifact versions (TC-1428)", () => {
    const decode = (path: string) => new TextDecoder().decode(ownerKv.get(path));
    const bearerInput = (text: string, artifact: { id: string; note?: string }): TargetPublishInput => ({
      source: new TextEncoder().encode(text),
      filename: "report.md",
      target: { kind: "bearer" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.example",
      artifact,
    });
    const artifactAdapter = () => createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async () => Response.json({
        version: "tinycloud.share/config-v2",
        shareOrigin: "https://share.example",
        registryOrigin: "https://registry.example",
        credentialsOrigin: "https://credentials.example",
      })) as unknown as typeof globalThis.fetch,
    });

    it("pins a bearer share to a write-once version file and writes the manifest last", async () => {
      const { targetAdapter } = artifactAdapter();
      const first = await targetAdapter.publish(bearerInput("v1 text", { id: "art_t", note: "first" }));
      if ("state" in first) throw new Error("expected publish");
      expect(first.metadata.resource).toEqual({ kind: "exact", path: "artifacts/art_t/versions/1/report.md" });
      expect(first.metadata.artifact).toEqual({ id: "art_t", version: 1, mode: "pinned" });
      expect(uploadedPaths).toEqual(["artifacts/art_t/versions/1/report.md", "artifacts/art_t/versions/1/manifest.json"]);
      expect(decode("artifacts/art_t/versions/1/report.md")).toBe("v1 text");
      expect(JSON.parse(decode("artifacts/art_t/versions/1/manifest.json"))).toMatchObject({ v: 1, parent: null, note: "first", files: [{ path: "report.md", bytes: 7 }] });

      // Changed bytes make version 2; version 1 is untouched.
      const second = await targetAdapter.publish(bearerInput("v2 text", { id: "art_t" }));
      if ("state" in second) throw new Error("expected publish");
      expect(second.metadata.artifact?.version).toBe(2);
      expect(decode("artifacts/art_t/versions/1/report.md")).toBe("v1 text");

      // The same bytes again are the same version: nothing is written and the new share points at v2.
      uploadedPaths.length = 0;
      const again = await targetAdapter.publish(bearerInput("v2 text", { id: "art_t" }));
      if ("state" in again) throw new Error("expected publish");
      expect(again.metadata.artifact?.version).toBe(2);
      expect(uploadedPaths).toEqual([]);
    });

    it("does not touch the legacy shares/ path for artifact shares", async () => {
      await artifactAdapter().targetAdapter.publish(bearerInput("x", { id: "art_t" }));
      expect(uploadedPaths.some((path) => path.includes("shares/"))).toBe(false);
    });

    it("types a KV authority failure on an artifact write as scope-denied", async () => {
      uploadErrorCode = "AUTH_UNAUTHORIZED";
      uploadErrorMeta = { status: 401, requiredAction: "tinycloud.kv/put" };
      await expect(artifactAdapter().targetAdapter.publish(bearerInput("x", { id: "art_t" })))
        .rejects.toMatchObject({ failure: { kind: "scope-denied", capability: "KV upload", requiredAction: "tinycloud.kv/put" } });
    });

    it("pins an addressed share to the encrypted version file; each encryption is its own version and no plaintext digest is stored", async () => {
      const adapter = addressedAdapter();
      const toOwner = (text: string, address: string): TargetPublishInput => ({ ...addressedInput({ kind: "email", address }), source: new TextEncoder().encode(text), artifact: { id: "art_t" } });
      const first = await adapter.publish(toOwner("only me", "a@example.com"));
      if ("state" in first) throw new Error("expected addressed publication");
      expect(first.metadata.resource).toEqual({ kind: "exact", path: "artifacts/art_t/versions/1/note.md" });
      expect(first.metadata.artifact).toEqual({ id: "art_t", version: 1, mode: "pinned" });
      const stored = JSON.parse(decode("artifacts/art_t/versions/1/note.md"));
      expect(stored.encryptedSymmetricKeyHash).toBe((1).toString(16).padStart(64, "0"));
      // The manifest holds the digest of the stored ciphertext only, never of the plaintext.
      const manifestText = decode("artifacts/art_t/versions/1/manifest.json");
      const manifest = JSON.parse(manifestText);
      expect(manifest.files[0]).toEqual({ bytes: ownerKv.get("artifacts/art_t/versions/1/note.md")!.byteLength, path: "note.md", sha256: createHash("sha256").update(ownerKv.get("artifacts/art_t/versions/1/note.md")!).digest("hex") });
      expect(manifestText).not.toContain(createHash("sha256").update("only me").digest("hex"));
      // The envelope the owner signs carries the pin: ids, the manifest digest and the digest of that stored ciphertext.
      const signedPin = first.deliveryMaterial?.envelope.artifactPin;
      expect(signedPin).toEqual({
        v: 1, artifactId: "art_t", version: 1,
        manifestSha256: createHash("sha256").update(ownerKv.get("artifacts/art_t/versions/1/manifest.json")!).digest("hex"),
        files: [manifest.files[0]],
      });
      expect(unifiedPolicyV2Schema.parse(registeredPolicies[0]).contentSource.initialCiphertextDigestHex).toBe(manifest.files[0].sha256);

      // The same plaintext again is a fresh encryption (fresh wrapped key), so a new version bound to its own key.
      const second = await adapter.publish(toOwner("only me", "b@example.com"));
      if ("state" in second) throw new Error("expected addressed publication");
      expect(second.metadata.artifact?.version).toBe(2);
      const bound = registeredPolicies.map((policy) => unifiedPolicyV2Schema.parse(policy).contentSource);
      expect(encryptions).toBe(2);
      expect(bound.map((source) => source.encryptedSymmetricKeyDigestHex)).toEqual([(1).toString(16).padStart(64, "0"), (2).toString(16).padStart(64, "0")]);
      expect(bound.map((source) => source.kvResource.split("/kv/")[1])).toEqual(["artifacts/art_t/versions/1/note.md", "artifacts/art_t/versions/2/note.md"]);
      expect(JSON.parse(decode("artifacts/art_t/versions/1/note.md")).encryptedSymmetricKeyHash).toBe((1).toString(16).padStart(64, "0"));
    });

    it("reports a denied artifact listing with the same re-login hint publish gives", async () => {
      listErrorCode = "AUTH_UNAUTHORIZED";
      const { artifactStore } = artifactAdapter();
      const store = await artifactStore();
      await expect(store.list("artifacts/art_t/versions/")).rejects.toMatchObject({ failure: { kind: "scope-denied", capability: "artifact storage", requiredAction: "tinycloud.kv/list" } });
    });

    it("refuses to grant edit on a pinned version before encrypting or uploading anything", async () => {
      await expect(addressedAdapter().publish({ ...addressedInput({ kind: "email", address: "a@example.com" }, ["read", "edit"]), artifact: { id: "art_t" } }))
        .rejects.toMatchObject({ failure: { kind: "invalid-request", reason: "a pinned artifact share cannot grant edit" } });
      expect(encryptions).toBe(0);
      expect(ownerKv.size).toBe(0);
    });
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

  it("refuses an addressed share before any request when a session-only sign-in lacks decrypt on the encryption network (TC-1753)", async () => {
    holdsDecrypt = false;
    // Every request the adapter itself makes goes through this fetch; the Share config answers 503,
    // so a refusal that came after the config fetch would surface as share-service-unavailable.
    const requests: string[] = [];
    const adapter = createShareAuthorityAdapters({
      origin: "https://share.example",
      profileName: async () => "test",
      fetchFn: (async (input: string | URL | Request) => {
        requests.push(String(input instanceof Request ? input.url : input));
        return new Response(null, { status: 503 });
      }) as unknown as typeof globalThis.fetch,
    }).targetAdapter;
    const error = await adapter.publish(addressedInput({ kind: "email", address: "owner@example.com" })).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SharePublishAuthorityError);
    expect((error as InstanceType<typeof SharePublishAuthorityError>).failure).toEqual({ kind: "decrypt-not-held" });
    expect(decryptChecks).toEqual([[{
      service: "tinycloud.encryption",
      path: expect.stringMatching(new RegExp(`^urn:tinycloud:encryption:${canonicalOwnerDid}:default/share/[0-9a-f]{32}$`)),
      actions: ["tinycloud.encryption/decrypt"],
    }]]);
    // No Share config fetch, registry write, upload, encryption, signing, policy registration or node probe.
    expect(requests).toEqual([]);
    expect(publishEvents).toEqual([]);
    expect(uploadedPaths).toEqual([]);
    expect(encryptions).toBe(0);
    expect(ownerRootInputs).toEqual([]);
    expect(sessionSignatures).toEqual([]);
    expect(registeredPolicies).toEqual([]);
    expect(nodeInfoRequests).toEqual([]);
  });

  it("still publishes addressed shares for a session that holds decrypt, and for a signer-backed owner without a session grant", async () => {
    const held = await addressedAdapter().publish(addressedInput({ kind: "email", address: "owner@example.com" }));
    expect("state" in held).toBe(false);
    holdsDecrypt = false;
    sessionOnly = false;
    const local = await addressedAdapter().publish(addressedInput({ kind: "email", address: "owner@example.com" }));
    expect("state" in local).toBe(false);
    expect(uploadedPaths).toHaveLength(2);
  });

  it("does not ask for decrypt on a bearer share", async () => {
    holdsDecrypt = false;
    const bearer = await addressedAdapter().publish(addressedInput({ kind: "bearer" }));
    expect("state" in bearer).toBe(false);
    expect(decryptChecks).toEqual([]);
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
      const link = buildShortLink({
        origin: "https://share.example",
        type: "share",
        id: "a".repeat(26),
        key: new Uint8Array(32).fill(7),
        bodyCid: "bafkreibm6jg3ux5qucnwb24kinphs4b5fbc7n5t3lti2skm4du5qjn4fli",
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
    const record = recordWithShortLink(published);
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

  it("classifies a history path the filesystem cannot read as ShareHistoryReadError", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-read-failed-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(join(historyCacheDir, "share-history-v2.json"), { recursive: true });
        const storage = createEncryptedProfileHistory(async () => "history-test");
        const error = await storage.get("share-history").catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ShareHistoryReadError);
        expect(shareHistoryReason(error)).toBe("HISTORY_READ_FAILED");
      });
    } finally {
      historyCacheDir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a corrupt history file as ShareHistoryUnreadableError", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-history-unreadable-"));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(historyCacheDir, { recursive: true });
        await writeFile(join(historyCacheDir, "share-history-v2.json"), "not json");
        const storage = createEncryptedProfileHistory(async () => "history-test");
        const error = await storage.get("share-history").catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ShareHistoryUnreadableError);
        expect(shareHistoryReason(error)).toBe("HISTORY_UNREADABLE");
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
    const record = recordWithShortLink(published);
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

  it("treats the node's refusal of a delivery authorization (its 422 and its 400) as one final refusal that names neither the link nor the key", async () => {
    const adapters = deliveringAdapters();
    const published = await adapters.targetAdapter.publish(addressedInput({ kind: "email", address: "alice@example.com" }));
    if ("state" in published) throw new Error("expected addressed publication");
    const record = recordWithShortLink(published);
    const original = node.authorizeShareDeliveryV3;
    const results: ShareNotifyResult[] = [];
    try {
      // The node answers 422 (body did not parse) or 400 (failed its checks); the node SDK raises this one error for both.
      for (let answer = 0; answer < 2; answer += 1) {
        const refusal = async (): Promise<never> => { throw new ShareDeliveryRefusedError(); };
        Object.defineProperty(node, "authorizeShareDeliveryV3", { value: refusal, configurable: true, writable: true });
        results.push(await notifyShare({ shareId: record.shareId, recipient: "alice@example.com", record, adapter: adapters.delivery }));
      }
    } finally {
      Object.defineProperty(node, "authorizeShareDeliveryV3", { value: original, configurable: true, writable: true });
    }
    expect(results[0]).toMatchObject({ state: "partial-failure", retryable: false, attempts: 1 });
    expect(results[1]).toEqual(results[0]);
    expect(JSON.stringify(results)).not.toContain(record.link ?? "no link");
    expect(JSON.stringify(results)).not.toContain(published.deliveryMaterial!.envelopeKey);
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
      const record = recordWithShortLink(published);
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

describe("sender history recovery and key-drop guard (TC-1669)", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const liveRecord = (shareId: string, expiresAt = "2099-01-01T00:00:00.000Z", revokedAt?: string): SenderShareRecord => ({
    shareId,
    target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
    resource: { kind: "exact", path: `shares/${shareId}/note.md` },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "emailDomain", value: "example.com" },
    registeredAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  });
  const withHistoryDirectory = async (prefix: string, run: (cacheDir: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    try {
      await withTinyCloudStateRoot(root, async () => {
        historyCacheDir = join(profilePath("history-test"), "cache");
        await mkdir(historyCacheDir, { recursive: true });
        await run(historyCacheDir);
      });
    } finally {
      historyCacheDir = undefined;
      historyLocalKey = true;
      await rm(root, { recursive: true, force: true });
    }
  };

  it("quarantines an unreadable history file under a new name and keeps its bytes", () =>
    withHistoryDirectory("tc-share-quarantine-", async (cacheDir) => {
      await writeFile(join(cacheDir, "share-history-v2.json"), "not json", { mode: 0o644 });
      const moved = await quarantineUnreadableProfileHistory("history-test");
      expect(moved).toMatch(/share-history-v2\.json\.unreadable-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      expect(await readFile(moved!, "utf8")).toBe("not json");
      expect((await stat(moved!)).mode & 0o777).toBe(0o600);
      expect(await profileHistoryFileExists("history-test")).toBe(false);
    }));

  it("does not quarantine on a plain write and leaves the unreadable bytes identical", () =>
    withHistoryDirectory("tc-share-quarantine-put-", async (cacheDir) => {
      await writeFile(join(cacheDir, "share-history-v2.json"), "not json");
      const storage = createEncryptedProfileHistory(async () => "history-test");
      await expect(storage.put(liveRecord("blocked-write"))).rejects.toBeInstanceOf(ShareHistoryUnreadableError);
      expect(await readFile(join(cacheDir, "share-history-v2.json"), "utf8")).toBe("not json");
    }));

  it("leaves a readable history in place", () =>
    withHistoryDirectory("tc-share-quarantine-readable-", async () => {
      const storage = createEncryptedProfileHistory(async () => "history-test");
      await storage.put(liveRecord("kept"));
      expect(await storage.quarantineUnreadable()).toBeNull();
      expect((await storage.list()).map((record) => record.shareId)).toEqual(["kept"]);
      expect(await profileHistoryFileExists("history-test")).toBe(true);
    }));

  it("returns null when no history file exists", () =>
    withHistoryDirectory("tc-share-quarantine-missing-", async () => {
      expect(await quarantineUnreadableProfileHistory("history-test")).toBeNull();
    }));

  it("starts a fresh readable history after quarantine and keeps the moved bytes untouched", () =>
    withHistoryDirectory("tc-share-quarantine-fresh-", async (cacheDir) => {
      await writeFile(join(cacheDir, "share-history-v2.json"), "not json");
      const moved = await quarantineUnreadableProfileHistory("history-test");
      const storage = createEncryptedProfileHistory(async () => "history-test");
      await storage.put(liveRecord("fresh"));
      expect((await storage.list()).map((record) => record.shareId)).toEqual(["fresh"]);
      expect(await readFile(moved!, "utf8")).toBe("not json");
    }));

  it("counts only unexpired, unrevoked recorded shares as stranded by a key drop", () =>
    withHistoryDirectory("tc-share-guard-count-", async () => {
      historyLocalKey = false;
      const storage = createEncryptedProfileHistory(async () => "history-test", signShareHistoryBytes);
      await storage.put(liveRecord("live-share"));
      await storage.put(liveRecord("expired-share", "2020-01-01T00:00:00.000Z"));
      await storage.put(liveRecord("revoked-share", "2099-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"));
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "unexpired", shareIds: ["live-share"] });
    }));

  it("treats history with no unexpired shares as clear", () =>
    withHistoryDirectory("tc-share-guard-expired-", async () => {
      historyLocalKey = false;
      const storage = createEncryptedProfileHistory(async () => "history-test", signShareHistoryBytes);
      await storage.put(liveRecord("expired-only", "2020-01-01T00:00:00.000Z"));
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "clear" });
    }));

  it("exempts local-owner profiles, whose history key does not change on logout", () =>
    withHistoryDirectory("tc-share-guard-local-", async () => {
      const storage = createEncryptedProfileHistory(async () => "history-test");
      await storage.put(liveRecord("local-share"));
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "clear" });
    }));

  it("counts a share expiring exactly at the check time as expired, and one millisecond later as unexpired", () =>
    withHistoryDirectory("tc-share-guard-boundary-", async () => {
      historyLocalKey = false;
      const storage = createEncryptedProfileHistory(async () => "history-test", signShareHistoryBytes);
      await storage.put(liveRecord("expires-at-now", now.toISOString()));
      await storage.put(liveRecord("expires-after-now", "2026-06-01T00:00:00.001Z"));
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "unexpired", shareIds: ["expires-after-now"] });
    }));

  it("leaves readable history in place when asked to quarantine it", () =>
    withHistoryDirectory("tc-share-quarantine-readable-", async (cacheDir) => {
      const storage = createEncryptedProfileHistory(async () => "history-test");
      await storage.put(liveRecord("readable-share"));
      const history = join(cacheDir, "share-history-v2.json");
      const before = await readFile(history, "utf8");
      expect(await quarantineUnreadableProfileHistory("history-test")).toBeNull();
      expect(await readFile(history, "utf8")).toBe(before);
      expect(await readdir(cacheDir)).toEqual(["share-history-v2.json"]);
    }));

  it("reports unreadable history as unavailable for the key drop", () =>
    withHistoryDirectory("tc-share-guard-unreadable-", async (cacheDir) => {
      historyLocalKey = false;
      await writeFile(join(cacheDir, "share-history-v2.json"), "not json");
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "unavailable", reason: "unreadable" });
    }));

  it("reports no history file as clear", () =>
    withHistoryDirectory("tc-share-guard-none-", async () => {
      historyLocalKey = false;
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "clear" });
    }));

  it("refuses a key drop that would strand unexpired shares, naming them with a bypass hint", () =>
    withHistoryDirectory("tc-share-guard-refuse-", async () => {
      historyLocalKey = false;
      const storage = createEncryptedProfileHistory(async () => "history-test", signShareHistoryBytes);
      await storage.put(liveRecord("live-share"));
      const error = await assertShareHistoryAllowsKeyDrop("history-test", "logout").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CLIError);
      expect(error).toMatchObject({
        code: "SHARE_HISTORY_UNEXPIRED",
        exitCode: 5,
        message: expect.stringContaining("live-share"),
        metadata: { hint: expect.stringContaining("--force") },
      });
    }));

  it("refuses unreadable history with a recovery hint", () =>
    withHistoryDirectory("tc-share-guard-refuse-unreadable-", async (cacheDir) => {
      historyLocalKey = false;
      await writeFile(join(cacheDir, "share-history-v2.json"), "not json");
      const error = await assertShareHistoryAllowsKeyDrop("history-test", "rotate").catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "SHARE_HISTORY_UNAVAILABLE",
        exitCode: 5,
        metadata: { hint: expect.stringContaining("share history recover") },
      });
    }));

  it("passes a key drop when no recorded share can be stranded", () =>
    withHistoryDirectory("tc-share-guard-pass-", async () => {
      historyLocalKey = false;
      await expect(assertShareHistoryAllowsKeyDrop("history-test", "logout")).resolves.toBeUndefined();
    }));

  it("counts a share with an unparsable expiry as unexpired, so the key drop is refused", () =>
    withHistoryDirectory("tc-share-guard-nan-", async () => {
      historyLocalKey = false;
      const storage = createEncryptedProfileHistory(async () => "history-test", signShareHistoryBytes);
      await storage.put(liveRecord("bad-expiry", "not-a-date"));
      expect(await checkShareHistoryForKeyDrop("history-test", now)).toEqual({ status: "unexpired", shareIds: ["bad-expiry"] });
    }));

  it("skips the key-drop check for a signed-out profile", () =>
    withHistoryDirectory("tc-share-guard-signed-out-", async () => {
      historyLocalKey = false;
      historySignedOut = true;
      const storage = createEncryptedProfileHistory(async () => "history-test", signShareHistoryBytes);
      await storage.put(liveRecord("live-after-signout"));
      await expect(assertShareHistoryAllowsKeyDrop("history-test", "logout")).resolves.toBeUndefined();
    }));

  it("never replaces an existing file when the quarantine name is already taken", () =>
    withHistoryDirectory("tc-share-quarantine-collision-", async (cacheDir) => {
      const history = join(cacheDir, "share-history-v2.json");
      const taken = join(cacheDir, "share-history-v2.json.unreadable-2026-06-01T00-00-00-000Z");
      await writeFile(history, "not json");
      await writeFile(taken, "earlier evidence");
      setSystemTime(now);
      try {
        await expect(quarantineUnreadableProfileHistory("history-test")).rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        setSystemTime();
      }
      expect(await readFile(taken, "utf8")).toBe("earlier evidence");
      expect(await readFile(history, "utf8")).toBe("not json");
    }));

  it("moves nothing when the history bytes change between the probe and the lock", () =>
    withHistoryDirectory("tc-share-quarantine-race-", async (cacheDir) => {
      const history = join(cacheDir, "share-history-v2.json");
      await writeFile(history, "not json");
      historyBeforeLock = async () => { await writeFile(history, "rewritten after probe"); };
      await expect(quarantineUnreadableProfileHistory("history-test")).rejects.toBeInstanceOf(ShareHistoryRetryError);
      expect(await readFile(history, "utf8")).toBe("rewritten after probe");
      expect(await readdir(cacheDir)).toEqual(["share-history-v2.json"]);
    }));

  it("returns null without moving anything when the history disappears before the lock", () =>
    withHistoryDirectory("tc-share-quarantine-vanished-", async (cacheDir) => {
      const history = join(cacheDir, "share-history-v2.json");
      await writeFile(history, "not json");
      historyBeforeLock = async () => { await rm(history); };
      await expect(quarantineUnreadableProfileHistory("history-test")).resolves.toBeNull();
      expect(await readdir(cacheDir)).toEqual([]);
    }));

  it("quarantines once when two recoveries run at the same time", () =>
    withHistoryDirectory("tc-share-quarantine-twice-", async (cacheDir) => {
      await writeFile(join(cacheDir, "share-history-v2.json"), "not json");
      const results = await Promise.all([
        quarantineUnreadableProfileHistory("history-test"),
        quarantineUnreadableProfileHistory("history-test"),
      ]);
      const moved = results.filter((path): path is string => path !== null);
      expect(moved).toHaveLength(1);
      expect(await readFile(moved[0]!, "utf8")).toBe("not json");
    }));

  it("leaves the history in place when signing fails, so a sign-in problem is not read as unreadable history", () =>
    withHistoryDirectory("tc-share-quarantine-signer-", async (cacheDir) => {
      historyLocalKey = false;
      const history = join(cacheDir, "share-history-v2.json");
      await writeFile(history, "not json");
      historyOnSign = () => { throw new CLIError("AUTH_REQUIRED", "sign in again", 3); };
      await expect(quarantineUnreadableProfileHistory("history-test")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(await readFile(history, "utf8")).toBe("not json");
      expect(await readdir(cacheDir)).toEqual(["share-history-v2.json"]);
    }));
});
