import {
  CredentialError,
  admitPolicyCredentialV3,
  canonicalDigest,
  credentialError,
  credentialRequirementDigest,
  descriptorSatisfiesRequirement,
  encodeBase64Url,
  sha256Base64Url,
  validateCredentialFlowDescriptor,
  validateCredentialRequirement,
  verifyStorageReceipt,
  verifyIssuedCredential,
  type CredentialFlowDescriptor,
  type CredentialIssuerMetadata,
  type CredentialRequirement,
  type IssuedCredentialEnvelope,
  type StoredCredentialRecord,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import { BrowserCredentialInteraction, BrowserCredentialRedirectStore } from "./browser";
import { interpretCredentialFlow } from "./interpreter";
import { findStoredCredential, storeCredential } from "./storage";
import { OpenCredentialsHttpTransport } from "./transport";
import type { CredentialClient, CredentialsAcquireOptions, CredentialsEnsureOptions, CredentialsEnsureResult, CredentialsOperationOptions, CredentialsPolicyAdmissionOptions, CredentialsPolicyAdmissionResult } from "./types";

function randomVerifier(): string { return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))); }

function active(client: CredentialClient): string {
  if (client.session() === undefined || typeof client.credentialHolderDid !== "string" || !/^did:key:z6Mk[^#]+$/.test(client.credentialHolderDid)) throw new CredentialError("ACTIVE_SESSION_REQUIRED", "credentials requires an active TinyCloud/OpenKey session");
  if (client.credentialHolderKid !== `${client.credentialHolderDid}#${client.credentialHolderDid.slice("did:key:".length)}`) throw new CredentialError("ACTIVE_SESSION_REQUIRED", "credentials requires a canonical active holder key");
  return client.credentialHolderDid;
}

async function credentialSpace(client: CredentialClient): Promise<{ spaceId: string; ownerDid: string }> {
  const spaceId = await client.ensureOwnedSpaceHosted("credentials");
  const ownerDid = client.credentialSpaceOwnerDid(spaceId);
  if (typeof ownerDid !== "string" || !ownerDid.startsWith("did:")) throw new CredentialError("VERIFIED_NOT_SAVED", "Credential space owner could not be authenticated");
  return { spaceId, ownerDid };
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new CredentialError("REQUEST_EXPIRED", "Credential acquisition timed out")), timeoutMs);
  return { signal: controller.signal, clear: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

export class CredentialsService {
  constructor(private readonly client: CredentialClient) {}

  private async descriptor(requirement: CredentialRequirement, options: CredentialsOperationOptions): Promise<CredentialFlowDescriptor> {
    if (options.descriptor !== undefined) {
      const descriptor = validateCredentialFlowDescriptor(options.descriptor);
      if (!descriptorSatisfiesRequirement(descriptor, requirement)) throw new CredentialError("UNSUPPORTED_PROFILE", "Pinned descriptor does not satisfy the policy requirement");
      return descriptor;
    }
    if (!options.discoveryUrl) throw new CredentialError("UNSUPPORTED_PROFILE", "A pinned descriptor or explicit discovery URL is required");
    let url: URL; try { url = new URL(options.discoveryUrl); } catch { throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is invalid"); }
    if (url.protocol !== "https:" || !["/.well-known/opencredentials", "/v1/credential-types"].includes(url.pathname) || url.search || url.hash) throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is not an allowed catalog endpoint");
    let response: Response;
    try { response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: options.signal }); } catch (cause) { throw new CredentialError("OFFLINE", "Credential discovery is unavailable", { cause }); }
    if (!response.ok) throw new CredentialError(response.status === 503 ? "ISSUER_UNREADY" : "OFFLINE", "Credential discovery is unavailable");
    const catalog = await response.json() as Record<string, unknown>;
    if (catalog.type !== "tinycloud.credentials/catalog/v1" || catalog.protocol !== "tinycloud.credentials/acquisition/v1" || catalog.catalogVersion !== 1 || !Array.isArray(catalog.profiles)) throw new CredentialError("DESCRIPTOR_INVALID", "Credential catalog is invalid");
    for (const entryValue of catalog.profiles) {
      if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) continue;
      const entry = entryValue as Record<string, unknown>;
      if (entry.supported !== true || entry.enabled !== true || entry.readiness !== "ready") continue;
      try { const candidate = validateCredentialFlowDescriptor(entry.descriptor); if (descriptorSatisfiesRequirement(candidate, requirement) && entry.descriptorDigest === await canonicalDigest(candidate)) return candidate; } catch { /* fail closed and inspect no other metadata on malformed entry */ }
    }
    throw new CredentialError("UNSUPPORTED_PROFILE", "No ready credential profile satisfies the requirement");
  }

  async find(requirementValue: CredentialRequirement, options: CredentialsOperationOptions = {}): Promise<StoredCredentialRecord | undefined> {
    const holderDid = active(this.client); const requirement = validateCredentialRequirement(requirementValue);
    options.onProgress?.({ state: "checking" });
    const space = await credentialSpace(this.client);
    return findStoredCredential({ kv: this.client.kvForSpace(space.spaceId), requirement, holderDid, ownerDid: space.ownerDid, now: options.now?.() });
  }

  async verify(envelope: IssuedCredentialEnvelope, input: { readonly descriptor: CredentialFlowDescriptor; readonly requirement: CredentialRequirement; readonly transport?: OpenCredentialsHttpTransport; readonly issuerMetadata?: CredentialIssuerMetadata; readonly fetch?: typeof fetch; readonly signal?: AbortSignal; readonly now?: Date }): Promise<VerifiedCredential> {
    const holderDid = active(this.client); const descriptor = validateCredentialFlowDescriptor(input.descriptor); const requirement = validateCredentialRequirement(input.requirement);
    const transport = input.transport ?? new OpenCredentialsHttpTransport(descriptor, input.fetch);
    return verifyIssuedCredential({ envelope, descriptor, descriptorDigest: await canonicalDigest(descriptor), requirement, holderDid, issuerMetadata: input.issuerMetadata ?? await transport.issuerMetadata(input.signal), now: input.now, checkStatus: (status, signal) => transport.checkStatus(status, signal), signal: input.signal });
  }

  async store(verified: VerifiedCredential, requirementValue: CredentialRequirement, options: CredentialsOperationOptions = {}) {
    const holderDid = active(this.client); const requirement = validateCredentialRequirement(requirementValue);
    const space = await credentialSpace(this.client);
    return storeCredential({ kv: this.client.kvForSpace(space.spaceId), verified, requirement, requirementDigest: await credentialRequirementDigest(requirement), activeHolderDid: holderDid, activeOwnerDid: space.ownerDid, now: options.now?.() });
  }

  async acquire(requirementValue: CredentialRequirement, options: CredentialsAcquireOptions): Promise<VerifiedCredential> {
    const holderDid = active(this.client); const requirement = validateCredentialRequirement(requirementValue); const descriptor = await this.descriptor(requirement, options);
    const descriptorDigest = await canonicalDigest(descriptor); const requirementDigest = await credentialRequirementDigest(requirement);
    const transport = options.transport ?? new OpenCredentialsHttpTransport(descriptor, options.fetch);
    const openerOrigin = options.openerOrigin ?? (typeof window === "undefined" ? "https://localhost" : window.location.origin);
    const redirectStore = options.redirectStore ?? (options.interaction === "redirect" && typeof window !== "undefined" ? new BrowserCredentialRedirectStore() : undefined);
    const timed = withTimeout(options.signal, options.timeoutMs ?? 120_000);
    let surface: Awaited<ReturnType<NonNullable<CredentialsAcquireOptions["browser"]>["start"]>> | undefined;
    let completed = false;
    try {
      const resume = await redirectStore?.load();
      if (resume && (resume.holderDid !== holderDid || resume.descriptorDigest !== descriptorDigest || resume.requirementDigest !== requirementDigest || resume.openerOrigin !== openerOrigin)) {
        await redirectStore!.clear();
        throw new CredentialError("REQUEST_SUBSTITUTED", "Redirect continuation does not match the active session and requirement");
      }
      if (resume && Date.parse(resume.expiresAt) <= Date.now()) { await redirectStore!.clear(); throw new CredentialError("REQUEST_EXPIRED", "Redirect continuation expired"); }
      const verifier = resume?.verifier ?? randomVerifier();
      const created = resume ?? await transport.create({ descriptor, descriptorDigest, requirement, requirementDigest, holderDid, openerOrigin, completionVerifierChallenge: await sha256Base64Url(verifier), signal: timed.signal });
      if (!resume && redirectStore) await redirectStore.save({ type: "TinyCloudCredentialRedirectResume", version: 1, requestId: created.requestId, locator: created.locator, verifier, expiresAt: created.expiresAt, correlationId: created.correlationId, holderDid, descriptorDigest, requirementDigest, openerOrigin });
      const requestedInteraction = options.interaction ?? "popup";
      let interaction = resume ? undefined : options.browser;
      if (!resume && !interaction && requestedInteraction !== "headless") {
        if (requestedInteraction === "inline") throw new CredentialError("UNSUPPORTED_PROFILE", "Inline credential acquisition requires a host interaction adapter");
        interaction = new BrowserCredentialInteraction(requestedInteraction);
      }
      if (!resume && interaction && interaction.kind !== requestedInteraction) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential interaction adapter does not match the requested interaction");
      if (interaction) surface = await interaction.start({ interaction: descriptor.interaction, locator: created.locator, signal: timed.signal });
      const signing = options.signing ?? {
        autoSign: async (_binding: unknown, bytes: Uint8Array) => this.client.autoSignCredentialBytes?.(bytes),
        requestApproval: async (_binding: unknown, bytes: Uint8Array) => {
          if (!this.client.approveCredentialBytes) throw new CredentialError("SIGNATURE_REJECTED", "OpenKey approval is required");
          return this.client.approveCredentialBytes(bytes);
        },
      };
      const requestProof = surface?.requestProof;
      const inlineHandlers = requestProof === undefined ? undefined : {
        collect_input: requestProof,
        mailbox_otp: requestProof,
      };
      await interpretCredentialFlow({ descriptor, requirement, requestId: created.requestId, verifier, holderDid, descriptorDigest, requirementDigest, openerOrigin, transport, signing, handlers: inlineHandlers ?? (surface ? undefined : options.stepHandlers), signal: timed.signal, onProgress: options.onProgress, onWait: surface ? async () => { if (surface!.closed()) throw new CredentialError("CANCELED", "Credential interaction was closed"); await surface!.wake(); } : undefined });
      options.onProgress?.({ state: "verifying", correlationId: created.correlationId });
      const envelope = await transport.result(created.requestId, verifier, timed.signal);
      const verified = await verifyIssuedCredential({ envelope, descriptor, descriptorDigest, requirement, holderDid, issuerMetadata: await transport.issuerMetadata(timed.signal), now: options.now?.(), checkStatus: (status, signal) => transport.checkStatus(status, signal), signal: timed.signal });
      completed = true; await redirectStore?.clear(); return verified;
    } catch (cause) {
      if (timed.signal.aborted && timed.signal.reason instanceof CredentialError) throw timed.signal.reason;
      throw credentialError(cause);
    } finally { surface?.close(); if (completed) await redirectStore?.clear(); timed.clear(); }
  }

  async ensure(requirementValue: CredentialRequirement, options: CredentialsEnsureOptions): Promise<CredentialsEnsureResult> {
    const holderDid = active(this.client); const requirement = validateCredentialRequirement(requirementValue); const descriptor = await this.descriptor(requirement, options);
    const existing = await this.find(requirement, options);
    if (existing) {
      const envelope: IssuedCredentialEnvelope = { type: "OpenCredentialsIssuedCredential", version: 1, protocol: "tinycloud.credentials/acquisition/v1", profile: existing.profile, credentialType: existing.credentialType, schema: descriptor.format.vct, format: "vc+sd-jwt", issuerDid: existing.issuerDid, issuerKid: existing.issuerKid, subjectDid: existing.holderDid, holderDid: existing.holderDid, claims: existing.claims, claimsDigest: existing.claimsDigest, descriptorDigest: existing.descriptorDigest, credentialId: existing.credentialId, issuedAt: existing.issuedAt, notBefore: existing.notBefore, expiresAt: existing.expiresAt, status: existing.status, credential: existing.credential };
      const transport = options.transport ?? new OpenCredentialsHttpTransport(descriptor, options.fetch);
      const verified = await verifyIssuedCredential({ envelope, descriptor, descriptorDigest: await canonicalDigest(descriptor), requirement, holderDid, issuerMetadata: await transport.issuerMetadata(options.signal), now: options.now?.(), checkStatus: (status, signal) => transport.checkStatus(status, signal), signal: options.signal });
      return { status: "reused", credential: verified, record: existing };
    }
    const verified = await this.acquire(requirement, { ...options, descriptor });
    options.onProgress?.({ state: "saving" });
    const saved = await this.store(verified, requirement, options);
    options.onProgress?.({ state: "success" });
    return { status: "acquired", credential: verified, record: saved.record, receipt: saved.receipt };
  }

  async admitPolicy(
    options: CredentialsPolicyAdmissionOptions,
  ): Promise<CredentialsPolicyAdmissionResult> {
    const holderDid = active(this.client);
    const requirement = validateCredentialRequirement(options.requirement);
    const requirementDigest = await credentialRequirementDigest(requirement);
    const { credential, record, receipt } = options.ensured;
    const space = await credentialSpace(this.client);
    if (
      credential.holderDid !== holderDid ||
      credential.subjectDid !== holderDid ||
      record.holderDid !== holderDid ||
      record.ownerDid !== space.ownerDid ||
      record.requirementDigest !== requirementDigest ||
      record.credential !== credential.credential ||
      record.credentialDigest !== credential.credentialDigest ||
      record.descriptorDigest !== credential.descriptorDigest ||
      record.issuerDid !== credential.issuerDid ||
      record.issuerKid !== credential.issuerKid
    ) {
      throw new CredentialError(
        "HOLDER_MISMATCH",
        "Stored credential provenance does not match the active TinyCloud session",
      );
    }
    if (
      receipt !== undefined &&
      !(await verifyStorageReceipt(
        record,
        receipt,
        space.ownerDid,
        holderDid,
      ))
    ) {
      throw new CredentialError(
        "VERIFIED_NOT_SAVED",
        "Credential storage receipt is invalid",
      );
    }
    const admission = await admitPolicyCredentialV3({
      policy: options.policy,
      policyCid: options.policyCid,
      policyRootCid: options.policyRootCid,
      enforcementRootCid: options.enforcementRootCid,
      nodeOrigin: options.nodeOrigin,
      requirement,
      credential,
      credentialSpaceOwnerDid: space.ownerDid,
      accountAuthorizationCid: this.client.accountAuthorizationCid(),
      credentialSpaceId: space.spaceId,
      requestedCapabilities: options.requestedCapabilities,
      sign: (digest) => this.client.signSessionBytes(digest),
      fetch: options.fetch,
      now: options.now,
      jti: options.jti,
    });
    if (this.client.activateCompactRuntimeDelegation === undefined) {
      throw new CredentialError(
        "ACTIVE_SESSION_REQUIRED",
        "Active TinyCloud delegation activation is unavailable",
      );
    }
    const installed = await this.client.activateCompactRuntimeDelegation({
      authorization: admission.session.authorization,
      cid: admission.session.cid,
      host: options.nodeOrigin,
    });
    return Object.freeze({ ...admission, installed });
  }
}
