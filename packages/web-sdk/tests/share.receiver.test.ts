import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  canonicalDigest,
  createEmailCredentialRequirement,
  createHolderBinding,
  type CredentialFlowDescriptor,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import { didKeyFromEd25519PublicKey, ed25519PublicKeyFromDidKey } from "@tinycloud/share-envelope";
import { interpretCredentialFlow } from "../src/credentials/interpreter";
import type { CredentialAcquisitionTransport, CredentialRequestState } from "../src/credentials/types";
import { SessionReceiverCredentialCustody } from "../src/share/receiver-credentials";
import { createOrRestoreShareReceiverSession, SHARE_RECEIVER_SESSION_STORAGE_KEY } from "../src/share/receiver-session";
import { ReceivedShareImpl, selectShareReceiverAccountSession, validateShareReceiverExpectedOrigin, validateShareReceiverRegistryBaseUrl, validateShareReceiverServiceTrust } from "../src/share/service";
import type { ShareReceivedContent } from "../src/share/types";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("receiver session strictly restores the same origin key and replaces corrupt material", async () => {
  const storage = memoryStorage();
  const first = await createOrRestoreShareReceiverSession("https://share.example", storage);
  const restored = await createOrRestoreShareReceiverSession("https://share.example", storage);
  expect(restored.holderDid).toBe(first.holderDid);
  expect(Object.keys(first).sort()).toEqual(["createdAt", "holderDid", "origin", "sign"]);
  const message = new TextEncoder().encode("tc-500");
  expect(ed25519.verify(await restored.sign(message), message, ed25519PublicKeyFromDidKey(first.holderDid))).toBe(true);
  const record = JSON.parse(storage.getItem(SHARE_RECEIVER_SESSION_STORAGE_KEY)!);
  storage.setItem(SHARE_RECEIVER_SESSION_STORAGE_KEY, JSON.stringify({ ...record, account: "forbidden" }));
  const replaced = await createOrRestoreShareReceiverSession("https://share.example", storage);
  expect(replaced.holderDid).not.toBe(first.holderDid);
  await expect(createOrRestoreShareReceiverSession("http://share.example", storage)).rejects.toThrow("loopback");
  expect((await createOrRestoreShareReceiverSession("http://localhost:5173", storage)).origin).toBe("http://localhost:5173");
  expect((await createOrRestoreShareReceiverSession("http://127.0.0.1:5173", storage)).origin).toBe("http://127.0.0.1:5173");
});

test("receiver session replaces mismatched private key material and non-canonical timestamps", async () => {
  const storage = memoryStorage();
  const otherStorage = memoryStorage();
  const first = await createOrRestoreShareReceiverSession("https://share.example", storage);
  await createOrRestoreShareReceiverSession("https://share.example", otherStorage);
  const record = JSON.parse(storage.getItem(SHARE_RECEIVER_SESSION_STORAGE_KEY)!);
  const other = JSON.parse(otherStorage.getItem(SHARE_RECEIVER_SESSION_STORAGE_KEY)!);
  storage.setItem(SHARE_RECEIVER_SESSION_STORAGE_KEY, JSON.stringify({
    ...record,
    jwk: { ...record.jwk, d: other.jwk.d },
  }));
  const replacedMismatchedKey = await createOrRestoreShareReceiverSession("https://share.example", storage);
  expect(replacedMismatchedKey.holderDid).not.toBe(first.holderDid);

  const replacementRecord = JSON.parse(storage.getItem(SHARE_RECEIVER_SESSION_STORAGE_KEY)!);
  storage.setItem(SHARE_RECEIVER_SESSION_STORAGE_KEY, JSON.stringify({
    ...replacementRecord,
    createdAt: replacementRecord.createdAt.replace(/\.\d{3}Z$/, "Z"),
  }));
  const replacedTimestamp = await createOrRestoreShareReceiverSession("https://share.example", storage);
  expect(replacedTimestamp.holderDid).not.toBe(replacedMismatchedKey.holderDid);
});

test("share registry permits explicit loopback HTTP only", () => {
  expect(validateShareReceiverRegistryBaseUrl("https://registry.example/")).toBe("https://registry.example");
  expect(validateShareReceiverRegistryBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
  expect(validateShareReceiverRegistryBaseUrl("http://localhost:8787/api/")).toBe("http://localhost:8787/api");
  expect(() => validateShareReceiverRegistryBaseUrl("http://registry.example")).toThrow("invalid");
  expect(() => validateShareReceiverRegistryBaseUrl("http://user@localhost:8787")).toThrow("invalid");
  expect(() => validateShareReceiverRegistryBaseUrl("http://localhost:8787?token=secret")).toThrow("invalid");
});

test("share links are bound to the configured out-of-band Share origin", () => {
  expect(validateShareReceiverExpectedOrigin("https://share.example/s/claim#secret", "https://share.example")).toBe("https://share.example");
  expect(validateShareReceiverExpectedOrigin("http://localhost:5173/s/claim#secret", "http://localhost:5173")).toBe("http://localhost:5173");
  expect(validateShareReceiverExpectedOrigin("http://127.0.0.1:5173/s/claim#secret", "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
  expect(() => validateShareReceiverExpectedOrigin("https://attacker.example/s/claim#secret", "https://share.example")).toThrow("configured Share deployment");
  expect(() => validateShareReceiverExpectedOrigin("http://share.example/s/claim#secret", "https://share.example")).toThrow("configured Share deployment");
  expect(() => validateShareReceiverExpectedOrigin("https://share.example/s/claim#secret", "https://share.example/path")).toThrow("configured Share deployment");
});

test("auto identity restores persisted TinyCloud authority without probing a wallet provider", async () => {
  let walletRestoreCalls = 0;
  let persistedRestoreCalls = 0;
  const restoredSession = { address: "0x1" } as any;
  const signedOutClient = {
    session: () => undefined,
    restorePersistedSession: async () => { persistedRestoreCalls += 1; return { status: "restored", session: restoredSession }; },
    restoreSession: async () => { walletRestoreCalls += 1; return { status: "restored", session: restoredSession }; },
  } as any;
  expect(await selectShareReceiverAccountSession(signedOutClient, "auto")).toBe(restoredSession);
  expect(persistedRestoreCalls).toBe(1);
  expect(walletRestoreCalls).toBe(0);
  expect(await selectShareReceiverAccountSession(signedOutClient, "account")).toBe(restoredSession);
  expect(walletRestoreCalls).toBe(1);

  const activeClient = { ...signedOutClient, session: () => restoredSession };
  expect(await selectShareReceiverAccountSession(activeClient, "auto")).toBe(restoredSession);
  expect(persistedRestoreCalls).toBe(1);
  expect(walletRestoreCalls).toBe(1);
});

test("Share trust requires a did:key target and keeps invitation verification identity separate", () => {
  const enforcerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
  const trustedNode = { invitationKid: "did:web:node.example#share-invitations", invitationPublicKey: new Uint8Array(32).fill(9) };
  expect(validateShareReceiverServiceTrust(
    { target: { nodeAudience: enforcerDid } } as any,
    { expectedEnforcerDid: enforcerDid, trustedNode },
  )).toBe(trustedNode);
  expect(() => validateShareReceiverServiceTrust(
    { target: { nodeAudience: enforcerDid } } as any,
    { expectedEnforcerDid: "did:web:node.example", trustedNode },
  )).toThrow("enforcer DID");
  expect(() => validateShareReceiverServiceTrust(
    { target: { nodeAudience: didKeyFromEd25519PublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(8))) } } as any,
    { expectedEnforcerDid: enforcerDid, trustedNode },
  )).toThrow("enforcer DID");
  expect(() => validateShareReceiverServiceTrust(
    { target: { nodeAudience: enforcerDid } } as any,
    { expectedEnforcerDid: enforcerDid, trustedNode: { ...trustedNode, invitationKid: "did:web:node.example" } },
  )).toThrow("invitation");
});

test("receiver credential custody is bounded, holder-scoped, and expires with the credential", async () => {
  const storage = memoryStorage();
  const custody = new SessionReceiverCredentialCustody(storage);
  const holder = (await createOrRestoreShareReceiverSession("https://share.example", storage)).holderDid;
  const requirement = createEmailCredentialRequirement({ email: "receiver@example.com", profile: { id: "tinycloud.email-proof/v1", version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 } });
  const requirementDigest = await canonicalDigest(requirement);
  const verified = {
    type: "OpenCredentialsIssuedCredential", version: 1, protocol: "tinycloud.credentials/acquisition/v1",
    profile: requirement.profile, credentialType: requirement.credentialType, schema: requirement.credentialType.id,
    format: "vc+sd-jwt", issuerDid: "did:key:z6MkIssuer", issuerKid: "did:key:z6MkIssuer#key",
    subjectDid: holder, holderDid: holder, claims: requirement.claims, claimsDigest: await canonicalDigest(requirement.claims),
    descriptorDigest: "descriptor", credentialId: "credential", issuedAt: "2030-01-01T00:00:00Z",
    notBefore: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
    status: { method: "none", freshnessSeconds: 300 }, credential: "signed", verifiedAt: "2030-01-01T00:00:01Z",
    credentialDigest: await canonicalDigest("signed"), statusCheckedAt: "2030-01-01T00:00:01Z",
  } as VerifiedCredential;
  await custody.store({ verified, requirement, requirementDigest, holderDid: holder, now: new Date("2030-01-01T00:00:02Z") });
  expect((await custody.find({ requirement, requirementDigest, holderDid: holder, now: new Date("2030-01-01T00:00:03Z") }))?.holderDid).toBe(holder);
  expect(await custody.find({ requirement, requirementDigest, holderDid: "did:key:z6MkOther", now: new Date("2030-01-01T00:00:03Z") })).toBeUndefined();
  expect(await custody.find({ requirement, requirementDigest, holderDid: holder, now: new Date("2030-01-01T01:00:00Z") })).toBeUndefined();
});

test("receiver holder binding uses the receiver signer without an OpenKey approval path", async () => {
  const storage = memoryStorage();
  const receiver = await createOrRestoreShareReceiverSession("https://share.example", storage);
  const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
  const descriptor = fixture.vectors[0]!.descriptor;
  const requirement = createEmailCredentialRequirement({ email: "receiver@example.com", profile: { id: descriptor.profile, version: 1 }, credentialType: { id: descriptor.format.vct, version: 1 } });
  const descriptorDigest = await canonicalDigest(descriptor);
  const requirementDigest = await canonicalDigest(requirement);
  const binding = createHolderBinding({ requestId: "R".repeat(32), profile: descriptor.profile, profileVersion: 1, descriptorDigest, requirementDigest, issuer: descriptor.issuer.did, issuerKid: descriptor.issuer.kid, holderDid: receiver.holderDid, normalizedClaimsDigest: "N".repeat(43), challengeNonce: "C".repeat(32), audience: "tinycloud://credentials", openerOrigin: "https://share.example", completionOrigin: "https://share.example", completionContext: "sdk-acquisition", jti: "J".repeat(32), issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T00:05:00Z" });
  const states: CredentialRequestState[] = [
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: "R".repeat(32), transitionId: "sign", state: "pending", nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} }, correlationId: "R".repeat(32) },
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: "R".repeat(32), transitionId: "done", state: "complete", correlationId: "R".repeat(32) },
  ];
  let index = 0;
  let signature: Uint8Array | undefined;
  const transport = {
    state: async () => states[Math.min(index, states.length - 1)]!,
    holderBinding: async () => binding,
    submitHolderSignature: async (_id: string, _verifier: string, value: string) => { signature = Uint8Array.from(Buffer.from(value, "base64url")); index += 1; },
  } as CredentialAcquisitionTransport;
  let openKeyApprovals = 0;
  await interpretCredentialFlow({ descriptor, requirement, requestId: "R".repeat(32), verifier: "V".repeat(32), holderDid: receiver.holderDid, descriptorDigest, requirementDigest, openerOrigin: "https://share.example", transport, signing: { autoSign: async (_binding, bytes) => receiver.sign(bytes), requestApproval: async () => { openKeyApprovals += 1; throw new Error("must not open OpenKey"); } } });
  expect(signature?.length).toBe(64);
  expect(openKeyApprovals).toBe(0);
});

function receivedShareForImport(onProgress?: (event: unknown) => void): ReceivedShareImpl {
  const received = new ReceivedShareImpl(
    { kind: "receiver", holderDid: "did:key:z6MkReceiver", custody: "session", origin: "https://share.example" },
    "share-1",
    {} as never,
    {} as never,
    async () => new Uint8Array(64),
    {
      identity: "receiver",
      interaction: { kind: "inline", mountTarget: "#credentials" },
      ...(onProgress === undefined ? {} : { onProgress }),
    },
    fetch,
    "https://credentials.org/.well-known/opencredentials",
    { invitationKid: "did:web:node.example#share-invitations", invitationPublicKey: new Uint8Array(32) },
  );
  const content: ShareReceivedContent = Object.freeze({
    bytes: new Uint8Array([1, 2, 3]),
    filename: "received.txt",
    mediaType: "text/plain",
    senderDid: "did:key:z6MkSender",
    shareId: "share-1",
    byteDigest: "digest",
    receivedAt: "2030-01-01T00:00:00.000Z",
  });
  (received as unknown as { content: ShareReceivedContent }).content = content;
  return received;
}

test("share import is idempotent and writes content plus non-sensitive metadata once", async () => {
  let storedMetadata: Record<string, unknown> | undefined;
  let batchWrites = 0;
  const kv = {
    get: async () => storedMetadata === undefined
      ? { ok: false, error: { code: "KV_NOT_FOUND", message: "missing", service: "kv" } }
      : { ok: true, data: { data: storedMetadata, headers: {} } },
    batchPut: async (items: { key: string; value: unknown }[]) => {
      batchWrites += 1;
      storedMetadata = items.find((item) => item.key.includes("/metadata/"))?.value as Record<string, unknown>;
      return { ok: true, data: { count: items.length, keys: items.map((item) => item.key) } };
    },
  };
  const accountClient = {
    session: () => ({}) as any,
    ensureOwnedSpaceHosted: async () => "did:key:z6MkAccount:files-for-you",
    kvForSpace: () => kv as any,
  };
  const received = receivedShareForImport();
  const imported = await received.importInto(accountClient, { namespace: "files-for-you" });
  const existing = await received.importInto(accountClient, { namespace: "files-for-you" });
  expect(imported.status).toBe("imported");
  expect(existing.status).toBe("existing");
  expect(batchWrites).toBe(1);
  expect(storedMetadata).toEqual({
    filename: "received.txt",
    mediaType: "text/plain",
    senderDid: "did:key:z6MkSender",
    shareId: "share-1",
    byteDigest: "digest",
    receivedAt: "2030-01-01T00:00:00.000Z",
  });
});

test("share import fails closed on metadata read errors and cancellation", async () => {
  let batchWrites = 0;
  const accountClient = {
    session: () => ({}) as any,
    ensureOwnedSpaceHosted: async () => "did:key:z6MkAccount:files-for-you",
    kvForSpace: () => ({
      get: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "denied", service: "kv" } }),
      batchPut: async () => { batchWrites += 1; return { ok: true, data: {} }; },
    }) as any,
  };
  const received = receivedShareForImport();
  await expect(received.importInto(accountClient, { namespace: "files-for-you" })).rejects.toThrow("AUTH_UNAUTHORIZED");
  expect(batchWrites).toBe(0);

  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await expect(received.importInto(accountClient, { namespace: "files-for-you", signal: controller.signal })).rejects.toThrow("cancelled");
  expect(batchWrites).toBe(0);
});
