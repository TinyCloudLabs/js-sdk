import {
  admitPolicyCredentialV4,
  credentialRequirementDigest,
  createEmailCredentialRequirement,
  createEmailDomainCredentialRequirement,
  encodeBase64Url,
  isCanonicalEmailDomain,
  parseCompactUcanAuthorization,
  signCompactPolicyDescendant,
  verifyOwnerNodeBinding,
  type CredentialRequirement,
  type UnifiedPolicyV2,
} from "@tinycloud/sdk-core";
import { inspectShare, ShareRecipientClient, type ShareMetadata } from "@tinycloud/share-sdk";
import { ed25519PublicKeyFromDidKey, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { CredentialsService, type CredentialClient } from "../credentials";
import { SessionReceiverCredentialCustody } from "./receiver-credentials";
import { createOrRestoreShareReceiverSession, type ReceiverSessionStorage, type ShareReceiverSession } from "./receiver-session";
import type {
  ReceivedShare,
  ShareDelegateOptions,
  ShareDelegation,
  ShareDelegationLink,
  ShareImportAccountClient,
  ShareImportOptions,
  ShareImportResult,
  ShareReceiveOptions,
  ShareReceivedContent,
  ShareReceiverClient,
  ShareReceiverIdentity,
  ShareReceiverRecipient,
} from "./types";

const DEFAULT_CREDENTIAL_DISCOVERY = "https://credentials.org/.well-known/opencredentials";

export interface ShareReceiverServiceOptions {
  readonly origin?: string;
  readonly sessionStorage?: ReceiverSessionStorage;
  readonly credentialDiscoveryUrl?: string;
  /** Out-of-band Share application origin allowed to supply invitation URLs. */
  readonly expectedShareOrigin: string;
  /** Registry containing the share owner's signed TinyCloud location record. */
  readonly registryOrigin: string;
  readonly fetch?: typeof fetch;
}

export function validateShareReceiverServiceTrust(
  envelope: Pick<ShareEnvelopeV3, "target" | "attestedEnforcerBinding">,
): void {
  if (envelope.target.nodeAudience !== envelope.attestedEnforcerBinding.nodeAudience) throw new Error("share Node DID does not match the signed target");
  try {
    if (ed25519PublicKeyFromDidKey(envelope.target.nodeAudience).length !== 32
      || ed25519PublicKeyFromDidKey(envelope.attestedEnforcerBinding.nodeAudience).length !== 32) throw new Error("invalid key length");
  } catch { throw new Error("share Node DID must be a canonical Ed25519 did:key"); }
}

/** @internal */
export function validateShareReceiverExpectedOrigin(shareUrl: string, expectedOrigin: string): string {
  const link = new URL(shareUrl);
  const expected = new URL(expectedOrigin);
  const allowed = (url: URL) => url.protocol === "https:" || url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!allowed(link) || !allowed(expected) || expected.origin !== expectedOrigin || link.origin !== expected.origin) throw new Error("share URL origin does not match the configured Share deployment");
  if (link.search !== "") throw new Error("share URL must not carry a query string");
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
  const commitment = policyV2For(envelope).credentialRequirement;
  const matcher = envelope.recipientMatcher;
  if (matcher.kind === "exactEmail") return createEmailCredentialRequirement({ email: matcher.value, profile: commitment.profile, credentialType: commitment.credentialType });
  if (matcher.kind === "emailDomain") {
    if (!isCanonicalEmailDomain(matcher.value)) throw new Error("share email domain is not canonical");
    return createEmailDomainCredentialRequirement({ domain: matcher.value, profile: commitment.profile, credentialType: commitment.credentialType });
  }
  throw new Error("accountless receive requires an exact-email or email-domain share");
}

function recipientFor(requirement: CredentialRequirement): ShareReceiverRecipient {
  const { email, emailDomain } = requirement.claims;
  if (email !== undefined) return Object.freeze({ kind: "exactEmail", email });
  return Object.freeze({ kind: "emailDomain", domain: emailDomain! });
}

/**
 * @internal Binds the invitation's addressed recipient to the owner-signed
 * policy's credential commitment. A matcher that does not hash to the
 * committed requirement is rejected before anything is displayed or sent.
 */
export async function verifiedShareRequirement(envelope: ShareEnvelopeV3): Promise<CredentialRequirement> {
  const requirement = requirementFor(envelope);
  if (await credentialRequirementDigest(requirement) !== policyV2For(envelope).credentialRequirement.requirementDigest) throw new Error("share credential requirement does not match its policy commitment");
  return requirement;
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
type ShareProgressStage = "policy-admission" | "delegation-import" | "invocation" | "decryption";

/** An admitted client and the delegation chain that authorizes it, S0 first. */
interface ShareAccess {
  readonly client: ShareRecipientClient;
  readonly chain: readonly ShareDelegationLink[];
  /** When the chain's last link stops authorizing anything, in Unix seconds. */
  readonly expiresAt: number;
}

/** The Node refused the session or its chain (expired, revoked, or unknown). */
function sessionRefused(error: unknown): boolean {
  return error instanceof Error && /\((?:401|403)\)$/.test(error.message);
}

/** The earlier of two RFC 3339 instants, as whole-second RFC 3339. */
function earliestExpiry(...values: readonly (string | undefined)[]): string | undefined {
  const seconds = values.map((value) => (value === undefined ? Number.NaN : Math.floor(Date.parse(value) / 1000))).filter(Number.isFinite);
  return seconds.length === 0 ? undefined : new Date(Math.min(...seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function leafExpiry(chain: readonly ShareDelegationLink[]): number {
  const leaf = chain[chain.length - 1]!;
  return parseCompactUcanAuthorization(leaf.authorization, leaf.cid).payload.exp;
}

function combinedSignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length < 2) return present[0];
  return typeof AbortSignal.any === "function" ? AbortSignal.any(present) : present[0];
}

export class ReceivedShareImpl implements ReceivedShare {
  private content?: ShareReceivedContent;
  private getPromise?: Promise<ShareReceivedContent>;
  private accessPromise?: Promise<ShareAccess>;
  private stage?: ShareProgressStage;

  readonly recipient: ShareReceiverRecipient;

  constructor(
    readonly identity: ShareReceiverIdentity,
    readonly metadata: ShareMetadata,
    private readonly envelope: ShareEnvelopeV3,
    private readonly requirement: CredentialRequirement,
    private readonly credentials: CredentialsService,
    private readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>,
    private readonly options: ShareReceiveOptions,
    private readonly fetchFn: typeof fetch,
    private readonly credentialDiscoveryUrl: string,
  ) {
    this.recipient = recipientFor(requirement);
  }

  get shareId(): string { return this.metadata.shareId; }

  get(): Promise<ShareReceivedContent> {
    if (this.content !== undefined) return Promise.resolve(this.content);
    if (this.getPromise !== undefined) return this.getPromise;
    this.getPromise = this.load().catch((error) => {
      this.getPromise = undefined;
      this.content = undefined;
      this.stage = undefined;
      // Keep a durable session across a transient failure; start over only
      // when the Node refused it (older Nodes mint 60-second sessions).
      if (sessionRefused(error)) this.accessPromise = undefined;
      throw error;
    });
    return this.getPromise;
  }

  /** The admitted access, admitted again once its chain has expired. */
  private async access(signal?: AbortSignal): Promise<ShareAccess> {
    const cached = this.accessPromise;
    if (cached !== undefined) {
      const current = await cached;
      if (current.expiresAt > Math.floor(Date.now() / 1000) + 1) return current;
      if (this.accessPromise === cached) this.accessPromise = undefined;
      else if (this.accessPromise !== undefined) return this.accessPromise;
    }
    const pending = this.admit(combinedSignal(this.options.signal, signal)).catch((error) => {
      if (this.accessPromise === pending) this.accessPromise = undefined;
      throw error;
    });
    this.accessPromise = pending;
    return pending;
  }

  /** Forget `access` so the next request admits again, unless it was already replaced. */
  private async forget(access: ShareAccess): Promise<void> {
    const cached = this.accessPromise;
    if (cached !== undefined && (await cached.catch(() => undefined)) === access && this.accessPromise === cached) this.accessPromise = undefined;
  }

  private async admit(signal: AbortSignal | undefined): Promise<ShareAccess> {
    aborted(signal);
    const common = {
      nodeOrigin: this.envelope.target.origin,
      envelope: this.envelope,
      holderDid: this.identity.holderDid,
      fetchFn: this.fetchFn,
      signal,
      sign: this.sign,
      onStage: (stage: ShareProgressStage) => {
        if (this.stage !== undefined) this.options.onProgress?.({ state: this.stage, status: "completed" });
        this.stage = stage;
        this.options.onProgress?.({ state: stage, status: "started" });
      },
    } as const;
    const delegation = this.options.delegation;
    if (delegation !== undefined) {
      // Another recipient re-delegated their access to this key; the client
      // verifies every link before anything is requested.
      const chain = Object.freeze(delegation.chain.map((link) => Object.freeze({ authorization: link.authorization, cid: link.cid })));
      const [session, ...descendants] = chain;
      if (session === undefined) throw new Error("this delegation has no session");
      if (descendants.length === 0) throw new Error("this delegation has no re-delegation to this key");
      if (delegation.shareId !== this.shareId || delegation.delegateDid !== this.identity.holderDid) {
        throw new Error("this delegation is for a different share or key");
      }
      const client = new ShareRecipientClient({ ...common, policyAuthorization: { authorization: session.authorization, cid: session.cid, descendants } });
      return { client, chain, expiresAt: leafExpiry(chain) };
    }
    const requirement = this.requirement;
    const policy = policyV2For(this.envelope);
    // Ask for a session as long as this share; the Node caps it further.
    const requestedExpiresAt = earliestExpiry(this.envelope.expiry, policy.expiresAt) ?? null;
    this.options.onProgress?.({ state: "credential-acquisition", status: "started" });
    const ensured = await this.credentials.ensure(requirement, {
      interaction: "inline",
      mountTarget: this.options.interaction.mountTarget,
      discoveryUrl: this.credentialDiscoveryUrl,
      fetch: this.fetchFn,
      signal,
      // Entering an address, waiting for real mail, and typing the code must
      // fit; this matches the issuer's ten-minute request lifetime.
      timeoutMs: 10 * 60_000,
    });
    // The mailbox comes from the verified, holder-bound credential.
    this.options.onProgress?.({ state: "credential-acquisition", status: "completed", ...(ensured.credential.claims.email === undefined ? {} : { mailbox: ensured.credential.claims.email }) });
    aborted(signal);
    let session: ShareDelegationLink;
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
        requestedExpiresAt,
        nodeOrigin: this.envelope.target.origin,
        fetch: this.fetchFn,
        signal,
      });
      this.options.onProgress?.({ state: "policy-admission", status: "completed" });
      this.options.onProgress?.({ state: "delegation-import", status: "started" });
      this.options.onProgress?.({ state: "delegation-import", status: "completed" });
      session = { authorization: admitted.session.authorization, cid: admitted.session.cid };
    } else {
      const admitted = await admitPolicyCredentialV4({
        policy,
        policyCid: this.envelope.policyCid,
        policyRootCid: this.envelope.policyRoot.cid,
        enforcementRootCid: this.envelope.enforcementRoot.cid,
        expectedNodeAudience: this.envelope.target.nodeAudience,
        expectedEnforcerDid: this.envelope.attestedEnforcerBinding.enforcerDid,
        requirement,
        credential: ensured.credential,
        requestedCapabilities: policy.capabilityCeiling,
        requestedExpiresAt,
        sign: this.sign,
        nodeOrigin: this.envelope.target.origin,
        fetch: this.fetchFn,
        signal,
      });
      session = { authorization: admitted.session.authorization, cid: admitted.session.cid };
    }
    const client = new ShareRecipientClient({ ...common, policyAuthorization: session });
    const chain = Object.freeze([Object.freeze(session)]);
    return { client, chain, expiresAt: leafExpiry(chain) };
  }

  private async load(): Promise<ShareReceivedContent> {
    const { client } = await this.access();
    const policy = policyV2For(this.envelope);
    const response = await client.nativeInvoke({ action: "get", resource: this.envelope.resource });
    if (!response.ok) throw new Error(`share invocation rejected (${response.status})`);
    const encrypted = new Uint8Array(await response.arrayBuffer());
    const opened = await client.decryptV3Content(encrypted);
    if (this.stage !== undefined) this.options.onProgress?.({ state: this.stage, status: "completed" });
    this.stage = undefined;
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

  async delegate(options: ShareDelegateOptions): Promise<ShareDelegation> {
    aborted(options.signal);
    // Policy invocations are compact UCANs, which only an Ed25519 did:key can sign.
    try { ed25519PublicKeyFromDidKey(options.to); } catch { throw new Error("a share can only be delegated to an Ed25519 did:key"); }
    for (let attempt = 0; ; attempt += 1) {
      const access = await this.access(options.signal);
      aborted(options.signal);
      const leaf = access.chain[access.chain.length - 1]!;
      const parent = parseCompactUcanAuthorization(leaf.authorization, leaf.cid);
      const descendant = await signCompactPolicyDescendant({
        parentAuthorization: leaf.authorization,
        parentCid: leaf.cid,
        issuerDid: this.identity.holderDid,
        audienceDid: options.to,
        attenuation: parent.payload.att,
        ...(options.expiresAt === undefined ? {} : { expiresAt: Math.floor(options.expiresAt.getTime() / 1000) }),
        sign: this.sign,
      });
      aborted(options.signal);
      // The owner's Node admits the link against its parent before the delegate can use it.
      const imported = await this.fetchFn(new URL("/delegate", this.envelope.target.origin), {
        method: "POST",
        redirect: "error",
        headers: { Authorization: descendant.authorization },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (imported.ok) {
        return Object.freeze({
          shareId: this.shareId,
          delegateDid: options.to,
          expiresAt: new Date(descendant.payload.exp * 1000).toISOString(),
          chain: Object.freeze([...access.chain, Object.freeze({ authorization: descendant.authorization, cid: descendant.cid })]),
        });
      }
      // A refused parent (expired or revoked) gets one fresh admission.
      if (attempt === 0 && (imported.status === 401 || imported.status === 403)) {
        await this.forget(access);
        continue;
      }
      throw new Error(`share delegation rejected (${imported.status})`);
    }
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
    const readback = await kv.get<{ readonly byteDigest?: string }>(metadataKey, { signal: options.signal });
    if ("error" in readback || readback.data.data.byteDigest !== this.content.byteDigest) {
      throw new Error("share import readback failed");
    }
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
    const inspection = await inspectShare(shareUrl, {
      expectedOrigin: expectedShareOrigin,
      signal: options.signal,
      onResolvedAddressedEnvelope: (value) => { if (value.version === 3) envelope = value; },
    });
    aborted(options.signal);
    if (envelope === undefined) throw new Error("accountless receive requires a verified v3 share");
    validateShareReceiverServiceTrust(envelope);
    // Bind the displayed recipient to the owner's signed policy before any
    // host can present it or any credential is requested.
    const requirement = await verifiedShareRequirement(envelope);
    await verifyOwnerNodeBinding({
      registryUrl: this.config.registryOrigin,
      ownerDid: envelope.policy.ownerDid,
      nodeOrigin: envelope.target.origin,
      nodeDid: envelope.target.nodeAudience,
      fetch: this.fetchFn,
      signal: options.signal,
    });
    aborted(options.signal);
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
    return new ReceivedShareImpl(identity, inspection.metadata, envelope, requirement, credentials, sign, options, this.fetchFn, this.config.credentialDiscoveryUrl ?? DEFAULT_CREDENTIAL_DISCOVERY);
  }
}
