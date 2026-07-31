import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, fromBase64Url, toBase64Url, type ShareEnvelopeV2 } from "@tinycloud/share-envelope";
import type { ShareAuthorizationAdapter, ShareAuthorizedContent, ShareAuthorizationResult } from "./authorization.js";

export interface ShareNodeTrust {
  readonly invitationKid: string;
  readonly invitationPublicKey: Uint8Array;
}

export interface SharePresentationMaterial {
  readonly holderDid: string;
  readonly credential: string;
  readonly credentialDigest?: string;
  readonly holderBinding: Record<string, unknown>;
  readonly proof: Record<string, unknown>;
  readonly sign?: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly email?: string;
}

export interface SharePolicyChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly enforcerDid?: string;
  readonly action: string;
  readonly requestBodyDigest: string;
  readonly [key: string]: unknown;
}

export interface ShareRecipientClientOptions {
  readonly nodeOrigin: string;
  readonly trustedNode: ShareNodeTrust;
  readonly holderDid: string;
  readonly envelope: ShareEnvelopeV2;
  readonly fetchFn?: typeof fetch;
  readonly buildPresentation?: (input: { readonly challenge: SharePolicyChallenge; readonly envelope: ShareEnvelopeV2; readonly policy: Record<string, unknown> }) => Promise<SharePresentationMaterial>;
  readonly sign?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export interface SharePolicySession {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly actions: readonly ("read" | "list" | "edit")[];
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
}

const DOMAIN = "xyz.tinycloud.share/policy-challenge/v1\0";
const PRESENTATION_DOMAIN = "xyz.tinycloud.share/policy-presentation/v1\0";
const SESSION_DOMAIN = "xyz.tinycloud.share/policy-session/v1\0";
const INVOCATION_DOMAIN = "xyz.tinycloud.share/invocation/v2\0";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
  const decoded = fromBase64Url(value);
  if (decoded.length !== 64 || toBase64Url(decoded) !== value) throw new Error(`${label} is invalid`);
  return decoded;
}

async function digest(value: unknown): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(value)))));
}

async function digestText(value: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function digestBytes(value: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

function trustedPublicKey(value: ShareNodeTrust): Uint8Array {
  if (!(value.invitationPublicKey instanceof Uint8Array) || value.invitationPublicKey.length !== 32) {
    throw new Error("share node trust key is invalid");
  }
  return value.invitationPublicKey;
}

async function verifyWrapped(value: unknown, key: "challenge" | "session", domain: string, trust: ShareNodeTrust): Promise<Record<string, unknown>> {
  const wrapper = object(value, `${key} response`);
  if (Object.keys(wrapper).length !== 2 || !Object.hasOwn(wrapper, key) || !Object.hasOwn(wrapper, "proof")) throw new Error(`${key} response is invalid`);
  const artifact = object(wrapper[key], `${key} artifact`);
  const proof = object(wrapper.proof, `${key} proof`);
  if (proof.alg !== "EdDSA" || proof.kid !== trust.invitationKid) throw new Error(`${key} proof is invalid`);
  if (!ed25519.verify(bytes(proof.signature, `${key} signature`), new TextEncoder().encode(`${domain}${canonicalize(artifact)}`), trustedPublicKey(trust))) throw new Error(`${key} proof is invalid`);
  return artifact;
}

function nativeAction(action: string): string {
  return action === "list" ? "tinycloud.kv/list" : action === "edit" ? "tinycloud.kv/put" : "tinycloud.kv/get";
}

function uiAction(action: unknown): "read" | "list" | "edit" {
  return action === "tinycloud.kv/list" ? "list" : action === "tinycloud.kv/put" ? "edit" : "read";
}

function selectedAction(envelope: ShareEnvelopeV2): string {
  return envelope.actions.includes("list") ? "tinycloud.kv/list" : envelope.actions.includes("edit") ? "tinycloud.kv/put" : "tinycloud.kv/get";
}

async function verifyDetachedResponse(response: Response, trust: ShareNodeTrust): Promise<void> {
  let value: unknown;
  try { value = await response.clone().json(); } catch { throw new Error("share read response is invalid"); }
  const record = object(value, "share read response");
  const proof = object(record.proof, "share read detached proof");
  if (proof.alg !== "EdDSA" || proof.kid !== trust.invitationKid) throw new Error("share read detached proof is invalid");
  const unsigned = { ...record };
  delete unsigned.proof;
  if (!ed25519.verify(bytes(proof.signature, "share read signature"), new TextEncoder().encode(`xyz.tinycloud.share/read-response/v2\0${canonicalize(unsigned)}`), trustedPublicKey(trust))) throw new Error("share read detached proof is invalid");
}

async function post(fetchFn: typeof fetch, origin: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetchFn(new URL(path, origin), { method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("share authority rejected the request");
  return response.json();
}

export class ShareRecipientClient {
  private readonly fetchFn: typeof fetch;
  private session: SharePolicySession | undefined;
  private signer: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
  private holderProof: Record<string, unknown> | undefined;

  constructor(private readonly options: ShareRecipientClientOptions) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.signer = options.sign;
  }

  async beginChallenge(envelope: ShareEnvelopeV2): Promise<SharePolicyChallenge> {
    const authority = envelope.ownerAuthority;
    if (authority === undefined) throw new Error("addressed owner authority is required");
    const actions = [...new Set(envelope.actions.map(nativeAction))].sort();
    const challengeBody = { shareCid: authority.shareCid, shareId: envelope.shareId, policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "", delegationCid: envelope.delegationCid, authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest, contentSource: envelope.contentSource, contentSourceDigest: envelope.contentSourceDigest, holderDid: this.options.holderDid, targetOrigin: envelope.target.origin, nodeAudience: envelope.target.nodeAudience, action: selectedAction(envelope), actions, resource: envelope.resource.path.replace(/\/$/, "") };
    const requestBodyDigest = await digest(challengeBody);
    const challenge = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v1/policy/challenges", { ...challengeBody, requestBodyDigest }), "challenge", DOMAIN, this.options.trustedNode) as unknown as SharePolicyChallenge;
    if (challenge.type !== "TinyCloudSharePolicyChallenge" || challenge.version !== 1 || challenge.challengeId.length < 16 || challenge.nonce.length < 16 || challenge.shareCid !== authority.shareCid || challenge.shareId !== envelope.shareId || challenge.policyCid !== challengeBody.policyCid || challenge.delegationCid !== envelope.delegationCid || challenge.authorityMaterialHandle !== envelope.authorityMaterialHandle || challenge.authorityMaterialDigest !== envelope.authorityMaterialDigest || canonicalize(challenge.contentSource) !== canonicalize(envelope.contentSource) || challenge.contentSourceDigest !== envelope.contentSourceDigest || challenge.requestBodyDigest !== requestBodyDigest || challenge.holderDid !== this.options.holderDid || challenge.targetOrigin !== envelope.target.origin || challenge.nodeAudience !== envelope.target.nodeAudience || challenge.action !== challengeBody.action || canonicalize(challenge.actions) !== canonicalize(actions) || challenge.resource !== challengeBody.resource || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("share authority returned an unbound challenge");
    return challenge;
  }

  private async establish(envelope: ShareEnvelopeV2): Promise<SharePolicySession> {
    const authority = envelope.ownerAuthority;
    if (authority === undefined) throw new Error("addressed owner authority is required");
    const actions = [...new Set(envelope.actions.map(nativeAction))].sort();
    const challengeBody = { shareCid: authority.shareCid, shareId: envelope.shareId, policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "", delegationCid: envelope.delegationCid, authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest, contentSource: envelope.contentSource, contentSourceDigest: envelope.contentSourceDigest, holderDid: this.options.holderDid, targetOrigin: envelope.target.origin, nodeAudience: envelope.target.nodeAudience, action: selectedAction(envelope), actions, resource: envelope.resource.path.replace(/\/$/, "") };
    const requestBodyDigest = await digest(challengeBody);
    const challenge = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v1/policy/challenges", { ...challengeBody, requestBodyDigest }), "challenge", DOMAIN, this.options.trustedNode) as unknown as SharePolicyChallenge;
    if (challenge.type !== "TinyCloudSharePolicyChallenge" || challenge.version !== 1 || challenge.challengeId === undefined || challenge.nonce === undefined || challenge.shareCid !== authority.shareCid || challenge.shareId !== envelope.shareId || challenge.policyCid !== challengeBody.policyCid || challenge.delegationCid !== envelope.delegationCid || challenge.authorityMaterialHandle !== envelope.authorityMaterialHandle || challenge.authorityMaterialDigest !== envelope.authorityMaterialDigest || challenge.requestBodyDigest !== requestBodyDigest || canonicalize(challenge.contentSource) !== canonicalize(envelope.contentSource) || challenge.contentSourceDigest !== envelope.contentSourceDigest || challenge.holderDid !== this.options.holderDid || challenge.targetOrigin !== envelope.target.origin || challenge.nodeAudience !== envelope.target.nodeAudience || challenge.action !== challengeBody.action || canonicalize(challenge.actions) !== canonicalize(actions) || challenge.resource !== challengeBody.resource || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("share authority returned an unbound challenge");
    if (this.options.buildPresentation === undefined) throw new Error("share presentation builder is required");
    const material = await this.options.buildPresentation({ challenge, envelope, policy: {} });
    this.holderProof = material.proof;
    this.signer = material.sign;
    if (this.signer === undefined) throw new Error("share holder signer is required");
    const presentation = {
      type: "TinyCloudSharePolicyPresentation", version: 1, challengeId: challenge.challengeId, nonce: challenge.nonce,
      shareCid: authority.shareCid, shareId: envelope.shareId, delegationCid: envelope.delegationCid,
      policyCid: challengeBody.policyCid, authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest,
      contentSource: envelope.contentSource, contentSourceDigest: envelope.contentSourceDigest,
      holderDid: material.holderDid, targetOrigin: envelope.target.origin, nodeAudience: envelope.target.nodeAudience,
      ...(challenge.enforcerDid === undefined ? {} : { enforcerDid: challenge.enforcerDid }), credentialDigest: material.credentialDigest ?? await digestText(material.credential),
      action: challengeBody.action, actions, resource: challengeBody.resource, requestBodyDigest,
      issuedAt: new Date().toISOString(), expiresAt: challenge.expiresAt, jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const presentationProof = { alg: "EdDSA", kid: `${material.holderDid}#${material.holderDid.slice("did:key:".length)}`, signature: toBase64Url(await this.signer(new TextEncoder().encode(`${PRESENTATION_DOMAIN}${canonicalize(presentation)}`))) };
    const session = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v1/policy/session", { presentation, credential: material.credential, proof: presentationProof, holderBinding: material.holderBinding, readSignerDid: material.holderDid }), "session", SESSION_DOMAIN, this.options.trustedNode);
    if (session.type !== "TinyCloudSharePolicySession" || session.version !== 1 || typeof session.sessionId !== "string" || session.shareCid !== authority.shareCid || session.shareId !== envelope.shareId || session.policyCid !== challengeBody.policyCid || session.delegationCid !== envelope.delegationCid || session.authorityMaterialHandle !== envelope.authorityMaterialHandle || session.authorityMaterialDigest !== envelope.authorityMaterialDigest || session.holderDid !== this.options.holderDid || session.targetOrigin !== envelope.target.origin || session.nodeAudience !== envelope.target.nodeAudience || session.action !== challengeBody.action || canonicalize(session.actions) !== canonicalize(actions) || canonicalize(session.contentSource) !== canonicalize(envelope.contentSource) || session.contentSourceDigest !== envelope.contentSourceDigest || session.resource !== challengeBody.resource || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new Error("share authority returned an unbound session");
    this.session = { sessionId: session.sessionId, expiresAt: session.expiresAt, actions: actions.map(uiAction), resource: { kind: envelope.resource.kind, path: String(session.resource) } };
    return this.session;
  }

  async authorize(envelope: ShareEnvelopeV2): Promise<ShareAuthorizedContent> {
    if (this.session === undefined) await this.establish(envelope);
    const response = await this.nativeInvoke({ action: "get", resource: envelope.resource });
    if (!response.ok) throw new Error("share recipient read was rejected");
    const value = object(await response.json(), "share read response");
    const expectedAction = nativeAction("read");
    if (
      value.type !== "TinyCloudShareInvokeResponse" ||
      value.version !== 2 ||
      value.action !== expectedAction ||
      value.resource !== envelope.resource.path ||
      typeof value.content !== "string" ||
      typeof value.bodyDigest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.bodyDigest) ||
      !Object.hasOwn(value, "proof")
    ) throw new Error("share read response is invalid");
    const content = fromBase64Url(value.content);
    if (await digestBytes(content) !== value.bodyDigest) throw new Error("share read response integrity is invalid");
    return { bytes: content, bodyDigest: value.bodyDigest, contentSourceDigest: envelope.contentSourceDigest, binding: { shareId: envelope.shareId, delegationCid: envelope.delegationCid, authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest, resource: { kind: envelope.resource.kind, path: value.resource }, action: value.action }, proof: { response: value, detached: value.proof } };
  }

  async establishPolicySession(): Promise<SharePolicySession> {
    if (this.session !== undefined) return this.session;
    return this.establish(this.options.envelope);
  }

  async resumeWithProof(envelope: ShareEnvelopeV2, resumeToken: string, proof: unknown): Promise<ShareAuthorizedContent> {
    const material = object(proof, "share authorization proof");
    const presentation = object(material.presentation, "share presentation");
    const presentationProof = object(material.presentationProof, "share presentation proof");
    const nonce = material.nonce;
    const credential = material.credential;
    const holderDid = material.holderDid;
    const holderBinding = material.holderBinding;
    if (typeof nonce !== "string" || typeof credential !== "string" || typeof holderDid !== "string" || holderDid !== this.options.holderDid || typeof holderBinding !== "object" || holderBinding === null || presentationProof.alg !== "EdDSA" || typeof presentationProof.signature !== "string") throw new Error("share authorization proof is incomplete");
    const value = object(await post(this.fetchFn, this.options.nodeOrigin, "/share/v1/policy/session", { challengeId: resumeToken, nonce, presentation, credential, proof: presentationProof, holderBinding, readSignerDid: holderDid }), "share policy session");
    const session = await verifyWrapped(value, "session", SESSION_DOMAIN, this.options.trustedNode);
    const authority = envelope.ownerAuthority;
    if (authority === undefined || session.type !== "TinyCloudSharePolicySession" || session.version !== 1 || typeof session.sessionId !== "string" || session.shareCid !== authority.shareCid || session.shareId !== envelope.shareId || session.delegationCid !== envelope.delegationCid || session.authorityMaterialHandle !== envelope.authorityMaterialHandle || session.authorityMaterialDigest !== envelope.authorityMaterialDigest || session.resource !== envelope.resource.path.replace(/\/$/, "") || typeof session.expiresAt !== "string") throw new Error("share authority returned an unbound session");
    const policyCid = envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "";
    const actions = [...new Set(envelope.actions.map(nativeAction))].sort();
    if (
      session.policyCid !== policyCid ||
      session.holderDid !== this.options.holderDid ||
      session.targetOrigin !== envelope.target.origin ||
      session.nodeAudience !== envelope.target.nodeAudience ||
      session.action !== selectedAction(envelope) ||
      canonicalize(session.actions) !== canonicalize(actions) ||
      canonicalize(session.contentSource) !== canonicalize(envelope.contentSource) ||
      session.contentSourceDigest !== envelope.contentSourceDigest ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) throw new Error("share authority returned an unbound session");
    this.session = { sessionId: session.sessionId, expiresAt: session.expiresAt, actions: actions.map(uiAction), resource: { kind: envelope.resource.kind, path: String(session.resource) } };
    this.holderProof = presentationProof;
    this.signer ??= this.options.sign;
    return this.authorize(envelope);
  }

  async nativeInvoke(request: { readonly action: string; readonly resource?: Record<string, unknown>; readonly body?: number[]; readonly bodyDigest?: number[]; readonly ifMatch?: string; readonly contentType?: string }): Promise<Response> {
    if (this.session === undefined) throw new Error("share policy session is required");
    if (this.options.envelope.ownerAuthority === undefined || this.signer === undefined || this.holderProof === undefined) throw new Error("share holder signer is required");
    const authority = this.options.envelope.ownerAuthority;
    const action = request.action === "list" ? "tinycloud.kv/list" : request.action === "put" ? "tinycloud.kv/put" : request.action === "metadata" ? "tinycloud.kv/metadata" : "tinycloud.kv/get";
    const resource = typeof request.resource?.path === "string" ? request.resource.path : this.session.resource.path;
    const actions = [...new Set(this.session.actions.map(nativeAction).concat(action === "tinycloud.kv/metadata" ? [action] : []))].sort();
    const bodyBytes = request.body === undefined ? undefined : Uint8Array.from(request.body);
    const bodyDigest = bodyBytes === undefined ? undefined : toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes)));
    const invocationBase = { type: "TinyCloudShareReadInvocation", version: 2, sessionId: this.session.sessionId, shareCid: authority.shareCid, shareId: this.options.envelope.shareId, policyCid: this.options.envelope.authorizationTarget.kind === "policy" ? this.options.envelope.authorizationTarget.policyCid : "", delegationCid: this.options.envelope.delegationCid, authorityMaterialHandle: this.options.envelope.authorityMaterialHandle, authorityMaterialDigest: this.options.envelope.authorityMaterialDigest, contentSource: this.options.envelope.contentSource, contentSourceDigest: this.options.envelope.contentSourceDigest, holderDid: this.options.holderDid, targetOrigin: this.options.envelope.target.origin, nodeAudience: this.options.envelope.target.nodeAudience, action, actions, resource, ...(action === "tinycloud.kv/list" ? { limit: 100 } : {}), ...(bodyDigest === undefined ? {} : { bodyDigest, ifMatch: request.ifMatch, contentType: request.contentType }), issuedAt: new Date().toISOString(), expiresAt: new Date(Math.min(Date.now() + 60_000, Date.parse(this.session.expiresAt))).toISOString(), jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
    const requestBodyDigest = await digest({ sessionId: this.session.sessionId, delegationCid: this.options.envelope.delegationCid, authorityMaterialHandle: this.options.envelope.authorityMaterialHandle, authorityMaterialDigest: this.options.envelope.authorityMaterialDigest, contentSource: this.options.envelope.contentSource, contentSourceDigest: this.options.envelope.contentSourceDigest, action, actions, resource, invocation: invocationBase });
    const invocation = { ...invocationBase, requestBodyDigest };
    const proof = { ...this.holderProof, signature: toBase64Url(await this.signer(new TextEncoder().encode(`${INVOCATION_DOMAIN}${canonicalize(invocation)}`))) };
    const signedRequest = { sessionId: this.session.sessionId, delegationCid: this.options.envelope.delegationCid, authorityMaterialHandle: this.options.envelope.authorityMaterialHandle, authorityMaterialDigest: this.options.envelope.authorityMaterialDigest, contentSource: this.options.envelope.contentSource, contentSourceDigest: this.options.envelope.contentSourceDigest, action, actions, resource, requestBodyDigest, invocation, proof };
    const response = await this.fetchFn(new URL("/invoke", this.options.nodeOrigin), { method: "POST", redirect: "error", headers: { accept: "application/vnd.tinycloud.share+json", "content-type": "application/vnd.tinycloud.share+json" }, body: JSON.stringify({ request: signedRequest, ...(action === "tinycloud.kv/list" ? { limit: 100 } : {}), ...(bodyBytes === undefined ? {} : { body: toBase64Url(bodyBytes), bodyDigest, ifMatch: request.ifMatch, contentType: request.contentType }) }) });
    if (response.ok) await verifyDetachedResponse(response, this.options.trustedNode);
    return response;
  }
}

export function createAddressedAuthorization(input: Omit<ShareRecipientClientOptions, "envelope">): ShareAuthorizationAdapter<ShareAuthorizedContent> {
  const client = (envelope: ShareEnvelopeV2): ShareRecipientClient => new ShareRecipientClient({ ...input, envelope });
  return {
    async begin({ envelope, method }): Promise<ShareAuthorizationResult<ShareAuthorizedContent>> {
      const current = client(envelope);
      if (input.buildPresentation !== undefined) return { state: "ready", value: await current.authorize(envelope) };
      const challenge = await current.beginChallenge(envelope);
      return { state: "authorization-required", method, resumeToken: challenge.challengeId };
    },
    async resume({ envelope, method, resumeToken, proof }): Promise<ShareAuthorizationResult<ShareAuthorizedContent>> {
      if (proof === undefined) return { state: "authorization-required", method, resumeToken };
      return { state: "ready", value: await client(envelope).resumeWithProof(envelope, resumeToken, proof) };
    },
    async verifyResult({ envelope, value, proof }) {
      try {
        const wrapper = object(proof, "share read proof");
        const response = object(wrapper.response, "share read response proof");
        const envelopeAction = nativeAction("read");
        if (
          response.type !== "TinyCloudShareInvokeResponse" ||
          response.version !== 2 ||
          response.action !== envelopeAction ||
          response.resource !== envelope.resource.path ||
          typeof response.bodyDigest !== "string" ||
          response.bodyDigest !== value.bodyDigest ||
          response.bodyDigest !== await digestBytes(value.bytes)
        ) return false;
        const detached = object(wrapper.detached, "share read detached proof");
        if (detached.alg !== "EdDSA" || detached.kid !== input.trustedNode.invitationKid) return false;
        const unsigned = { ...response };
        delete unsigned.proof;
        return ed25519.verify(bytes(detached.signature, "share read signature"), new TextEncoder().encode(`xyz.tinycloud.share/read-response/v2\0${canonicalize(unsigned)}`), trustedPublicKey(input.trustedNode));
      } catch {
        return false;
      }
    },
  };
}
