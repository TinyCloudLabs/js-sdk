import {
  buildPolicyCredentialPresentationV4,
  credentialRequirementDigest,
  createEmailCredentialRequirement,
  encodeBase64Url,
  issuedCredentialEnvelopeFromVerified,
  type CredentialRequirement,
  type UnifiedPolicyV2,
} from "@tinycloud/sdk-core";
import { inspectShare, ShareRecipientClient } from "@tinycloud/share-sdk";
import { ed25519PublicKeyFromDidKey, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { CredentialsService, type CredentialClient } from "../credentials";
import { SessionReceiverCredentialCustody } from "./receiver-credentials";
import { createOrRestoreShareReceiverSession, type ReceiverSessionStorage, type ShareReceiverSession } from "./receiver-session";
import type {
  ReceivedShare,
  ShareImportAccountClient,
  ShareImportOptions,
  ShareImportResult,
  ShareReceiveOptions,
  ShareReceivedContent,
  ShareReceiverClient,
  ShareReceiverIdentity,
} from "./types";

const DEFAULT_CREDENTIAL_DISCOVERY = "https://credentials.org/.well-known/opencredentials";

export interface ShareReceiverServiceOptions {
  readonly origin?: string;
  readonly sessionStorage?: ReceiverSessionStorage;
  readonly credentialDiscoveryUrl?: string;
  /** Out-of-band Share application origin allowed to supply invitation URLs. */
  readonly expectedShareOrigin: string;
  /** Explicit share blob registry. Never inferred from the viewer URL. */
  readonly registryBaseUrl: string;
  /** Pinned Node identity used by recipient response verification. */
  readonly trustedNode: { readonly invitationKid: string; readonly invitationPublicKey: Uint8Array };
  /** Exact Ed25519 enforcer DID committed as the signed envelope target. */
  readonly expectedEnforcerDid: string;
  readonly fetch?: typeof fetch;
}

export function validateShareReceiverServiceTrust(
  envelope: Pick<ShareEnvelopeV3, "target">,
  config: ShareReceiverServiceOptions,
): { readonly invitationKid: string; readonly invitationPublicKey: Uint8Array } {
  if (typeof config.expectedEnforcerDid !== "string" || envelope.target.nodeAudience !== config.expectedEnforcerDid) throw new Error("share enforcer DID does not match the signed target");
  try {
    if (ed25519PublicKeyFromDidKey(config.expectedEnforcerDid).length !== 32) throw new Error("invalid key length");
  } catch { throw new Error("share enforcer DID must be a canonical Ed25519 did:key"); }
  if (config.trustedNode === undefined
    || typeof config.trustedNode.invitationKid !== "string"
    || !/^did:[a-z0-9]+:[^#\s]+#[^#\s]+$/.test(config.trustedNode.invitationKid)
    || !(config.trustedNode.invitationPublicKey instanceof Uint8Array)
    || config.trustedNode.invitationPublicKey.length !== 32) throw new Error("share receiver requires pinned Node invitation verification material");
  return config.trustedNode;
}

/** @internal */
export function validateShareReceiverRegistryBaseUrl(value: string): string {
  const registry = new URL(value);
  const loopbackHttp = registry.protocol === "http:"
    && (registry.hostname === "127.0.0.1" || registry.hostname === "localhost");
  if ((registry.protocol !== "https:" && !loopbackHttp) || registry.username || registry.password || registry.search || registry.hash) throw new Error("share registry URL is invalid");
  return registry.toString().replace(/\/$/, "");
}

/** @internal */
export function validateShareReceiverExpectedOrigin(shareUrl: string, expectedOrigin: string): string {
  const link = new URL(shareUrl);
  const expected = new URL(expectedOrigin);
  const allowed = (url: URL) => url.protocol === "https:" || url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!allowed(link) || !allowed(expected) || expected.origin !== expectedOrigin || link.origin !== expected.origin) throw new Error("share URL origin does not match the configured Share deployment");
  return expected.origin;
}

/** @internal */
export async function selectShareReceiverAccountSession(
  client: ShareReceiverClient,
  requestedIdentity: ShareReceiveOptions["identity"],
): Promise<ReturnType<ShareReceiverClient["session"]>> {
  if (requestedIdentity === "receiver") return undefined;
  const active = client.session();
  if (active !== undefined) return active;
  if (requestedIdentity === "auto") {
    const restored = await client.restorePersistedSession();
    return restored.status === "restored" ? restored.session : undefined;
  }
  const restored = await client.restoreSession();
  return restored.status === "restored" ? restored.session : undefined;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function safeFilename(value: string): string {
  if (value.length === 0 || value === "." || value === ".." || /[/\\\u0000-\u001f\u007f]/.test(value)) throw new Error("share filename must be one safe path segment");
  return value;
}

function policyV2For(envelope: ShareEnvelopeV3): UnifiedPolicyV2 {
  if (envelope.policy.schema !== "xyz.tinycloud.policy/policy/v2") throw new Error("share receive requires Policy/v2");
  return envelope.policy as unknown as UnifiedPolicyV2;
}

function requirementFor(envelope: ShareEnvelopeV3): CredentialRequirement {
  if (envelope.recipientMatcher.kind !== "exactEmail") throw new Error("accountless receive currently requires an exact-email share");
  const commitment = policyV2For(envelope).credentialRequirement;
  return createEmailCredentialRequirement({ email: envelope.recipientMatcher.value, profile: commitment.profile, credentialType: commitment.credentialType });
}

function guestCredentialClient(session: ShareReceiverSession, storage: ReceiverSessionStorage): CredentialClient {
  const unavailable = (): never => { throw new Error("account credential storage is unavailable to a receiver session"); };
  return {
    sessionDid: session.holderDid,
    credentialHolderDid: session.holderDid,
    credentialHolderKid: `${session.holderDid}#${session.holderDid.slice("did:key:".length)}`,
    session: () => undefined,
    signSessionBytes: (bytes) => session.sign(bytes),
    autoSignCredentialBytes: (bytes) => session.sign(bytes),
    approveCredentialBytes: (bytes) => session.sign(bytes),
    ensureOwnedSpaceHosted: async () => unavailable(),
    credentialSpaceOwnerDid: unavailable,
    kvForSpace: unavailable,
    accountAuthorizationCid: unavailable,
    receiverCredentialCustody: new SessionReceiverCredentialCustody(storage),
  };
}

/** @internal */
export class ReceivedShareImpl implements ReceivedShare {
  private content?: ShareReceivedContent;
  private getPromise?: Promise<ShareReceivedContent>;

  constructor(
    readonly identity: ShareReceiverIdentity,
    readonly shareId: string,
    private readonly envelope: ShareEnvelopeV3,
    private readonly credentials: CredentialsService,
    private readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>,
    private readonly options: ShareReceiveOptions,
    private readonly fetchFn: typeof fetch,
    private readonly credentialDiscoveryUrl: string,
    private readonly trustedNode: { readonly invitationKid: string; readonly invitationPublicKey: Uint8Array },
  ) {}

  get(): Promise<ShareReceivedContent> {
    if (this.content !== undefined) return Promise.resolve(this.content);
    if (this.getPromise !== undefined) return this.getPromise;
    this.getPromise = this.load().catch((error) => {
      this.getPromise = undefined;
      this.content = undefined;
      throw error;
    });
    return this.getPromise;
  }

  private async load(): Promise<ShareReceivedContent> {
    aborted(this.options.signal);
    const requirement = requirementFor(this.envelope);
    const policy = policyV2For(this.envelope);
    if (await credentialRequirementDigest(requirement) !== policy.credentialRequirement.requirementDigest) throw new Error("share credential requirement does not match its policy commitment");
    this.options.onProgress?.({ state: "credential-acquisition", status: "started" });
    const ensured = await this.credentials.ensure(requirement, {
      interaction: "inline",
      mountTarget: this.options.interaction.mountTarget,
      discoveryUrl: this.credentialDiscoveryUrl,
      fetch: this.fetchFn,
      signal: this.options.signal,
    });
    this.options.onProgress?.({ state: "credential-acquisition", status: "completed" });
    aborted(this.options.signal);
    let previousStage: "policy-admission" | "delegation-import" | "invocation" | "decryption" | undefined;
    const common = {
      nodeOrigin: this.envelope.target.origin,
      envelope: this.envelope,
      holderDid: this.identity.holderDid,
      trustedNode: this.trustedNode,
      fetchFn: this.fetchFn,
      signal: this.options.signal,
      sign: this.sign,
      onStage: (stage: "policy-admission" | "delegation-import" | "invocation" | "decryption") => {
        if (previousStage !== undefined) this.options.onProgress?.({ state: previousStage, status: "completed" });
        previousStage = stage;
        this.options.onProgress?.({ state: stage, status: "started" });
      },
    } as const;
    let client: ShareRecipientClient;
    if (this.identity.kind === "account") {
      this.options.onProgress?.({ state: "policy-admission", status: "started" });
      const admitted = await this.credentials.admitPolicy({
        ensured,
        policy,
        policyCid: this.envelope.policyCid,
        policyRootCid: this.envelope.policyRoot.cid,
        enforcementRootCid: this.envelope.enforcementRoot.cid,
        requirement,
        requestedCapabilities: policy.capabilityCeiling,
        nodeOrigin: this.envelope.target.origin,
        fetch: this.fetchFn,
        signal: this.options.signal,
      });
      this.options.onProgress?.({ state: "policy-admission", status: "completed" });
      this.options.onProgress?.({ state: "delegation-import", status: "started" });
      this.options.onProgress?.({ state: "delegation-import", status: "completed" });
      client = new ShareRecipientClient({ ...common, policyAuthorization: { authorization: admitted.session.authorization, cid: admitted.session.cid } });
    } else {
      client = new ShareRecipientClient({
        ...common,
        buildPresentation: async ({ challenge }) => {
          const presentation = await buildPolicyCredentialPresentationV4({
            policy,
            policyCid: this.envelope.policyCid,
            challenge: challenge as any,
            requirement,
            credential: ensured.credential,
            requestedCapabilities: policy.capabilityCeiling,
            sign: this.sign,
          });
          return {
            holderDid: this.identity.holderDid,
            credential: ensured.credential.credential,
            holderBinding: {},
            proof: {},
            sign: this.sign,
            presentation: presentation as unknown as Record<string, unknown>,
            credentialEnvelope: { ...issuedCredentialEnvelopeFromVerified(ensured.credential) },
            requirement: { ...requirement },
          };
        },
      });
      await client.establishPolicySession();
    }
    const response = await client.nativeInvoke({ action: "get", resource: this.envelope.resource });
    if (!response.ok) throw new Error(`share invocation rejected (${response.status})`);
    const encrypted = new Uint8Array(await response.arrayBuffer());
    const opened = await client.decryptV3Content(encrypted);
    if (previousStage !== undefined) this.options.onProgress?.({ state: previousStage, status: "completed" });
    aborted(this.options.signal);
    const bytes = opened.bytes.slice();
    const byteDigest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const content = Object.freeze({
      bytes,
      filename: safeFilename(this.envelope.metadata.filename ?? this.envelope.display.filename ?? `${this.shareId}.bin`),
      mediaType: opened.mediaType,
      senderDid: policy.ownerDid,
      shareId: this.shareId,
      byteDigest,
      receivedAt: new Date().toISOString(),
    });
    this.content = content;
    this.options.onProgress?.({ state: "ready", status: "completed" });
    return content;
  }

  async importInto(accountClient: ShareImportAccountClient, options: ShareImportOptions): Promise<ShareImportResult> {
    if (this.content === undefined) throw new Error("share content must be received before import");
    if (accountClient.session() === undefined) throw new Error("Save to TinyCloud requires an active account session");
    if (options.namespace !== "files-for-you") throw new Error("share imports require the files-for-you namespace");
    aborted(options.signal);
    this.options.onProgress?.({ state: "import", status: "started" });
    const filename = safeFilename(options.filename ?? this.content.filename);
    const contentKey = `v1/content/${this.shareId}/${filename}`;
    const metadataKey = `v1/metadata/${this.shareId}/${filename}.json`;
    const logicalPath = `files-for-you/${contentKey}`;
    const spaceId = await accountClient.ensureOwnedSpaceHosted(options.namespace);
    const kv = accountClient.kvForSpace(spaceId);
    const existing = await kv.get<{ readonly byteDigest?: string }>(metadataKey, { signal: options.signal });
    if ("error" in existing) {
      if (existing.error.code !== "KV_NOT_FOUND") throw new Error(`share import metadata read failed (${existing.error.code})`);
    } else {
      if (existing.data.data.byteDigest !== this.content.byteDigest) throw new Error("an import for this share already exists with different bytes");
      this.options.onProgress?.({ state: "import", status: "completed" });
      return Object.freeze({ status: "existing", path: logicalPath, byteDigest: this.content.byteDigest });
    }
    aborted(options.signal);
    const metadata = {
      filename,
      mediaType: this.content.mediaType,
      senderDid: this.content.senderDid,
      shareId: this.shareId,
      byteDigest: this.content.byteDigest,
      receivedAt: this.content.receivedAt,
    };
    const written = await kv.batchPut([
      { key: contentKey, value: this.content.bytes, contentType: this.content.mediaType },
      { key: metadataKey, value: metadata, contentType: "application/json" },
    ], { signal: options.signal });
    if (!written.ok) throw new Error("share import failed");
    this.options.onProgress?.({ state: "import", status: "completed" });
    return Object.freeze({ status: "imported", path: logicalPath, byteDigest: this.content.byteDigest });
  }
}

export class ShareReceiverService {
  private readonly fetchFn: typeof fetch;
  private readonly storage: ReceiverSessionStorage;
  private readonly config: ShareReceiverServiceOptions;

  constructor(private readonly client: ShareReceiverClient, config: ShareReceiverServiceOptions | undefined) {
    if (config === undefined) throw new Error("share receiver requires explicit deployment configuration");
    this.config = config;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.storage = config.sessionStorage ?? window.sessionStorage;
  }

  async receive(shareUrl: string, options: ShareReceiveOptions): Promise<ReceivedShare> {
    aborted(options.signal);
    options.onProgress?.({ state: "identity-selection", status: "started" });
    let envelope: ShareEnvelopeV3 | undefined;
    const expectedShareOrigin = validateShareReceiverExpectedOrigin(shareUrl, this.config.expectedShareOrigin);
    const registryBaseUrl = validateShareReceiverRegistryBaseUrl(this.config.registryBaseUrl);
    const inspection = await inspectShare(shareUrl, {
      registryBaseUrl,
      expectedOrigin: expectedShareOrigin,
      fetchFn: this.fetchFn,
      signal: options.signal,
      onResolvedAddressedEnvelope: (value) => { if (value.version === 3) envelope = value; },
    });
    aborted(options.signal);
    if (envelope === undefined) throw new Error("accountless receive requires a verified v3 share");
    const trustedNode = validateShareReceiverServiceTrust(envelope, this.config);
    const account = await selectShareReceiverAccountSession(this.client, options.identity);
    let identity: ShareReceiverIdentity;
    let credentials: CredentialsService;
    let sign: (bytes: Uint8Array) => Promise<Uint8Array>;
    if (options.identity !== "receiver" && account !== undefined) {
      identity = Object.freeze({ kind: "account", holderDid: this.client.credentialHolderDid });
      credentials = this.client.credentials;
      sign = (bytes) => this.client.signSessionBytes(bytes);
    } else {
      if (options.identity === "account") throw new Error("an active or restored TinyCloud session is required");
      const origin = this.config.origin ?? window.location.origin;
      const receiver = await createOrRestoreShareReceiverSession(origin, this.storage);
      identity = Object.freeze({ kind: "receiver", holderDid: receiver.holderDid, custody: "session", origin: receiver.origin });
      credentials = new CredentialsService(guestCredentialClient(receiver, this.storage));
      sign = (bytes) => receiver.sign(bytes);
    }
    options.onProgress?.({ state: "identity-selection", status: "completed", identity });
    return new ReceivedShareImpl(identity, inspection.metadata.shareId, envelope, credentials, sign, options, this.fetchFn, this.config.credentialDiscoveryUrl ?? DEFAULT_CREDENTIAL_DISCOVERY, trustedNode);
  }
}
