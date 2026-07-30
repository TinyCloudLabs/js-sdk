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
  readonly enforcerDid: string;
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
  readonly buildPresentation: (input: { readonly challenge: SharePolicyChallenge; readonly envelope: ShareEnvelopeV2; readonly policy: Record<string, unknown> }) => Promise<SharePresentationMaterial>;
}

export interface SharePolicySession {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly actions: readonly ("read" | "list" | "edit")[];
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
}

const DOMAIN = "xyz.tinycloud.share/policy-challenge/v2\0";
const SESSION_DOMAIN = "xyz.tinycloud.share/policy-session/v2\0";
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

async function verifyWrapped(value: unknown, key: "challenge" | "session", domain: string, trust: ShareNodeTrust): Promise<Record<string, unknown>> {
  const wrapper = object(value, `${key} response`);
  if (Object.keys(wrapper).length !== 2 || !Object.hasOwn(wrapper, key)) throw new Error(`${key} response is invalid`);
  const artifact = object(wrapper[key], `${key} artifact`);
  const proof = object(wrapper.proof, `${key} proof`);
  if (proof.alg !== "EdDSA" || proof.kid !== trust.invitationKid) throw new Error(`${key} proof is invalid`);
  if (!ed25519.verify(bytes(proof.signature, `${key} signature`), new TextEncoder().encode(`${domain}${canonicalize(artifact)}`), trust.invitationPublicKey)) throw new Error(`${key} proof is invalid`);
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
  }

  private async establish(envelope: ShareEnvelopeV2): Promise<SharePolicySession> {
    const authority = envelope.ownerAuthority;
    if (authority === undefined) throw new Error("addressed owner authority is required");
    const outer = object(authority.outerEnvelope, "outer envelope");
    const target = object(outer.target, "outer target");
    const resource = object(outer.resource, "outer resource");
    const source = object(outer.contentSource, "outer content source");
    const enforcement = object(authority.enforcementDelegation, "enforcement delegation");
    const actions = [...new Set(envelope.actions.map(nativeAction))].sort();
    const challengeBody = {
      envelopeCid: authority.envelopeCid, shareCid: authority.shareCid, shareId: envelope.shareId,
      registrationCid: authority.registrationCid, delegationCid: envelope.delegationCid,
      policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "",
      enforcementDelegationCid: String(enforcement.cid), enforcementDelegation: enforcement,
      outerEnvelope: outer, contentSource: source, contentSourceDigest: String(outer.contentSourceDigest),
      holderDid: this.options.holderDid, targetOrigin: String(target.origin), nodeAudience: String(target.nodeAudience),
      action: selectedAction(envelope), actions, resource: String(resource.path),
    };
    const requestBodyDigest = await digest(challengeBody);
    const challenge = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v2/policy/challenges", { ...challengeBody, requestBodyDigest }), "challenge", DOMAIN, this.options.trustedNode) as unknown as SharePolicyChallenge;
    if (challenge.type !== "TinyCloudSharePolicyChallenge" || challenge.version !== 2 || challenge.challengeId === undefined || challenge.nonce === undefined || challenge.shareCid !== authority.shareCid || challenge.shareId !== envelope.shareId || challenge.registrationCid !== authority.registrationCid || challenge.envelopeCid !== authority.envelopeCid || challenge.policyCid !== challengeBody.policyCid || challenge.enforcementDelegationCid !== enforcement.cid || challenge.requestBodyDigest !== requestBodyDigest || challenge.contentSourceDigest !== challengeBody.contentSourceDigest || canonicalize(challenge.contentSource) !== canonicalize(source) || challenge.holderDid !== this.options.holderDid || challenge.targetOrigin !== target.origin || challenge.nodeAudience !== target.nodeAudience || challenge.action !== challengeBody.action || canonicalize(challenge.actions) !== canonicalize(actions) || challenge.resource !== resource.path) throw new Error("share authority returned an unbound challenge");
    const material = await this.options.buildPresentation({ challenge, envelope, policy: {} });
    this.holderProof = material.proof;
    this.signer = material.sign;
    if (this.signer === undefined) throw new Error("share holder signer is required");
    const presentation = {
      type: "TinyCloudSharePolicyPresentation", version: 2, challengeId: challenge.challengeId, nonce: challenge.nonce,
      shareCid: authority.shareCid, shareId: envelope.shareId, delegationCid: envelope.delegationCid,
      policyCid: challengeBody.policyCid, contentSource: source, contentSourceDigest: challengeBody.contentSourceDigest,
      holderDid: material.holderDid, targetOrigin: target.origin, nodeAudience: target.nodeAudience,
      enforcerDid: challenge.enforcerDid, credentialDigest: material.credentialDigest ?? await digest(material.credential),
      action: challengeBody.action, actions, resource: resource.path, requestBodyDigest,
      issuedAt: new Date().toISOString(), expiresAt: challenge.expiresAt, jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const presentationProof = { alg: "EdDSA", kid: `${material.holderDid}#${material.holderDid.slice("did:key:".length)}`, signature: toBase64Url(await this.signer(new TextEncoder().encode(`${SESSION_DOMAIN}${canonicalize(presentation)}`))) };
    const session = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v2/policy/session", { challengeId: challenge.challengeId, nonce: challenge.nonce, presentation, credential: material.credential, proof: presentationProof, holderBinding: material.holderBinding, readSignerDid: material.holderDid }), "session", SESSION_DOMAIN, this.options.trustedNode);
    if (session.type !== "TinyCloudSharePolicySession" || session.version !== 2 || typeof session.sessionId !== "string" || session.shareCid !== authority.shareCid || session.shareId !== envelope.shareId || session.registrationCid !== authority.registrationCid || session.envelopeCid !== authority.envelopeCid || session.policyCid !== challengeBody.policyCid || session.delegationCid !== envelope.delegationCid || session.holderDid !== this.options.holderDid || session.resource !== resource.path || typeof session.expiresAt !== "string") throw new Error("share authority returned an unbound session");
    this.session = { sessionId: session.sessionId, expiresAt: session.expiresAt, actions: actions.map(uiAction), resource: { kind: envelope.resource.kind, path: String(session.resource) } };
    return this.session;
  }

  async authorize(envelope: ShareEnvelopeV2): Promise<ShareAuthorizedContent> {
    await this.establish(envelope);
    const response = await this.nativeInvoke({ action: "get", resource: envelope.resource });
    if (!response.ok) throw new Error("share recipient read was rejected");
    const value = object(await response.json(), "share read response");
    if (value.type !== "TinyCloudShareInvokeResponse" || value.version !== 2 || typeof value.content !== "string" || typeof value.bodyDigest !== "string" || typeof value.proof !== "object") throw new Error("share read response is invalid");
    const content = fromBase64Url(value.content);
    return { bytes: content, bodyDigest: value.bodyDigest, contentSourceDigest: envelope.contentSourceDigest, binding: { shareId: envelope.shareId, delegationCid: envelope.delegationCid, authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest, resource: envelope.resource, action: String(value.action) }, proof: { detached: value.proof, response: value } };
  }

  async establishPolicySession(): Promise<SharePolicySession> {
    if (this.session !== undefined) return this.session;
    return this.establish(this.options.envelope);
  }

  async nativeInvoke(request: { readonly action: string; readonly resource?: Record<string, unknown>; readonly body?: number[]; readonly bodyDigest?: number[]; readonly ifMatch?: string; readonly contentType?: string }): Promise<Response> {
    if (this.session === undefined) throw new Error("share policy session is required");
    if (this.options.envelope.ownerAuthority === undefined || this.signer === undefined || this.holderProof === undefined) throw new Error("share holder signer is required");
    const authority = this.options.envelope.ownerAuthority;
    const outer = object(authority.outerEnvelope, "outer envelope");
    const target = object(outer.target, "outer target");
    const source = object(outer.contentSource, "outer content source");
    const action = request.action === "list" ? "tinycloud.kv/list" : request.action === "put" ? "tinycloud.kv/put" : request.action === "metadata" ? "tinycloud.kv/metadata" : "tinycloud.kv/get";
    const resource = typeof request.resource?.path === "string" ? request.resource.path : this.session.resource.path;
    const actions = [...new Set(this.session.actions.map(nativeAction).concat(action === "tinycloud.kv/metadata" ? [action] : []))].sort();
    const bodyBytes = request.body === undefined ? undefined : Uint8Array.from(request.body);
    const bodyDigest = bodyBytes === undefined ? undefined : toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes)));
    const invocation = { type: "TinyCloudShareReadInvocation", version: 2, sessionId: this.session.sessionId, envelopeCid: authority.envelopeCid, shareCid: authority.shareCid, shareId: this.options.envelope.shareId, registrationCid: authority.registrationCid, delegationCid: this.options.envelope.delegationCid, policyCid: this.options.envelope.authorizationTarget.kind === "policy" ? this.options.envelope.authorizationTarget.policyCid : "", enforcementDelegationCid: String(object(authority.enforcementDelegation, "enforcement delegation").cid), contentSource: source, contentSourceDigest: String(outer.contentSourceDigest), holderDid: this.session.sessionId.length > 0 ? this.options.holderDid : this.options.holderDid, nodeAudience: String(target.nodeAudience), action, actions, resource, issuedAt: new Date().toISOString(), expiresAt: new Date(Math.min(Date.now() + 60_000, Date.parse(this.session.expiresAt))).toISOString(), jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), ...(bodyDigest === undefined ? {} : { bodyDigest, ifMatch: request.ifMatch, contentType: request.contentType }) };
    const requestBodyDigest = await digest({ sessionId: this.session.sessionId, delegationCid: this.options.envelope.delegationCid, contentSource: source, contentSourceDigest: invocation.contentSourceDigest, action, actions, resource, invocation });
    const signedInvocation = { ...invocation, requestBodyDigest };
    const proof = { ...this.holderProof, signature: toBase64Url(await this.signer(new TextEncoder().encode(`${INVOCATION_DOMAIN}${canonicalize(signedInvocation)}`))) };
    return this.fetchFn(new URL("/share/v2/invoke", this.options.nodeOrigin), { method: "POST", redirect: "error", headers: { accept: "application/vnd.tinycloud.share+json", "content-type": "application/vnd.tinycloud.share+json" }, body: JSON.stringify({ request: { ...signedInvocation, proof }, ...(bodyBytes === undefined ? {} : { body: toBase64Url(bodyBytes), bodyDigest, ifMatch: request.ifMatch, contentType: request.contentType }) }) });
  }
}

export function createAddressedAuthorization(input: Omit<ShareRecipientClientOptions, "envelope">): ShareAuthorizationAdapter<ShareAuthorizedContent> {
  const client = (envelope: ShareEnvelopeV2): ShareRecipientClient => new ShareRecipientClient({ ...input, envelope });
  return {
    async begin({ envelope }): Promise<ShareAuthorizationResult<ShareAuthorizedContent>> {
      return { state: "ready", value: await client(envelope).authorize(envelope) };
    },
    async resume({ envelope }): Promise<ShareAuthorizationResult<ShareAuthorizedContent>> {
      return { state: "ready", value: await client(envelope).authorize(envelope) };
    },
    async verifyResult({ value, proof }) {
      try {
        const wrapper = object(proof, "share read proof");
        const detached = object(wrapper.detached, "share read detached proof");
        const response = object(wrapper.response, "share read response proof");
        if (detached.alg !== "EdDSA" || detached.kid !== input.trustedNode.invitationKid || typeof response.bodyDigest !== "string" || response.bodyDigest !== value.bodyDigest) return false;
        const unsigned = { ...response };
        delete unsigned.proof;
        return ed25519.verify(bytes(detached.signature, "share read signature"), new TextEncoder().encode(`xyz.tinycloud.share/read-response/v2\0${canonicalize(unsigned)}`), input.trustedNode.invitationPublicKey);
      } catch {
        return false;
      }
    },
  };
}
