import {
  CredentialError, canonicalDigest, credentialEndpointPath, decodeBase64Url, encodeBase64Url,
  holderBindingCanonicalBytes, sha256Base64Url, validateCredentialHolderBinding,
  type CredentialFlowDescriptor, type CredentialHolderBinding, type CredentialIssuerMetadata,
  type CredentialRequirement, type IssuedCredentialEnvelope,
} from "@tinycloud/sdk-core";
import type { CredentialAcquisitionTransport, CredentialRequestState, PrimitiveStepResult } from "./types";

function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`); return value as Record<string, unknown>; }
function opaque(value: unknown, label: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new CredentialError("REQUEST_SUBSTITUTED", `${label} is invalid`); return value; }
function timestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`); return new Date(value).toISOString(); }
function jwtPayload(credential: string): Record<string, unknown> { const part = credential.split("~", 1)[0]?.split(".")[1]; if (!part) throw new CredentialError("VERIFICATION_FAILED", "Issued SD-JWT is invalid"); try { return object(JSON.parse(new TextDecoder().decode(decodeBase64Url(part))), "SD-JWT payload"); } catch (cause) { if (cause instanceof CredentialError) throw cause; throw new CredentialError("VERIFICATION_FAILED", "Issued SD-JWT is invalid", { cause }); } }
const SERVER_CODES = new Set(["REQUEST_EXPIRED", "ISSUER_UNREADY", "UNSUPPORTED_PROFILE", "SIGNATURE_REJECTED"] as const);
function serverError(value: unknown, response: Response): CredentialError | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "code,correlationId,recoverable,state,type" || body.type !== "tinycloud.credentials/error/v1" || typeof body.code !== "string" || typeof body.recoverable !== "boolean" || typeof body.state !== "string" || typeof body.correlationId !== "string") return undefined;
  if (!SERVER_CODES.has(body.code as any)) return undefined;
  const code = body.code as "REQUEST_EXPIRED" | "ISSUER_UNREADY" | "UNSUPPORTED_PROFILE" | "SIGNATURE_REJECTED";
  return new CredentialError(code, `OpenCredentials rejected the request: ${code}`, {
    state: body.state,
    correlationId: body.correlationId,
    retryAfterMs: Number(response.headers.get("retry-after")) * 1000 || undefined,
  });
}

export class OpenCredentialsHttpTransport implements CredentialAcquisitionTransport {
  private readonly nonces = new Map<string, string>();
  private readonly bindings = new Map<string, CredentialHolderBinding>();
  constructor(private readonly descriptor: CredentialFlowDescriptor, private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private url(endpoint: Parameters<typeof credentialEndpointPath>[0], id?: string): string { return new URL(credentialEndpointPath(endpoint, id), this.descriptor.issuer.origin).href; }
  private async request(endpoint: Parameters<typeof credentialEndpointPath>[0], input: { readonly id?: string; readonly method?: "GET" | "POST"; readonly verifier?: string; readonly body?: unknown; readonly signal?: AbortSignal }): Promise<unknown> {
    let response: Response;
    try { response = await this.fetchFn(this.url(endpoint, input.id), { method: input.method ?? "GET", credentials: endpoint === "request" ? "include" : "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: input.signal, headers: { accept: "application/json", ...(input.body === undefined ? {} : { "content-type": "application/json" }), ...(input.verifier === undefined ? {} : { authorization: `Bearer ${input.verifier}` }) }, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) }); }
    catch (cause) { if (cause instanceof DOMException && cause.name === "AbortError") throw new CredentialError("CANCELED", "Credential acquisition was canceled", { cause }); throw new CredentialError("OFFLINE", "OpenCredentials is unavailable", { cause }); }
    if (!response.ok) {
      let parsed: unknown;
      try { parsed = await response.json(); } catch { parsed = undefined; }
      const typed = serverError(parsed, response);
      if (typed) throw typed;
      if (response.status === 410) throw new CredentialError("REQUEST_EXPIRED", "Credential request expired");
      if (response.status === 409) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential request was replayed or substituted");
      if (response.status === 503) throw new CredentialError("ISSUER_UNREADY", "Credential issuer is not ready", { retryAfterMs: Number(response.headers.get("retry-after")) * 1000 || undefined });
      throw new CredentialError("VERIFICATION_FAILED", "OpenCredentials rejected the request");
    }
    if (response.status === 204) return undefined; try { return await response.json(); } catch (cause) { throw new CredentialError("VERIFICATION_FAILED", "OpenCredentials response is invalid", { cause }); }
  }
  async create(input: { descriptor: CredentialFlowDescriptor; descriptorDigest: string; requirement: CredentialRequirement; requirementDigest: string; holderDid: string; openerOrigin: string; completionVerifierChallenge: string; signal?: AbortSignal }) {
    const body = object(await this.request("request", { method: "POST", body: { protocol: input.descriptor.protocol, profile: input.descriptor.profile, profileVersion: input.descriptor.profileVersion, descriptorDigest: input.descriptorDigest, requirementDigest: input.requirementDigest, holderDid: input.holderDid, inputs: input.requirement.claims, audience: "tinycloud://credentials", openerOrigin: input.openerOrigin, completionOrigin: input.openerOrigin, completionContext: "sdk-acquisition", completionVerifierChallenge: input.completionVerifierChallenge }, signal: input.signal }), "create response");
    if (body.type !== "tinycloud.credentials/acquisition-request/v1" || body.protocol !== input.descriptor.protocol || body.next !== "challenge" || body.endpoint !== "challenge") throw new CredentialError("VERIFICATION_FAILED", "create response is invalid");
    const requestId = opaque(body.requestId, "requestId"); return { requestId, locator: requestId, expiresAt: timestamp(body.expiresAt, "expiresAt"), correlationId: requestId };
  }
  private proofStep(): "mailbox_otp" | "collect_input" { return this.descriptor.steps.some((step) => step.type === "mailbox_otp") ? "mailbox_otp" : "collect_input"; }
  async state(id: string, verifier: string, signal?: AbortSignal): Promise<CredentialRequestState> {
    const raw = object(await this.request("state", { id, verifier, signal }), "state response");
    if (raw.type !== "tinycloud.credentials/acquisition-state/v1" || raw.requestId !== id || raw.profile !== this.descriptor.profile || raw.profileVersion !== 1) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential state response is substituted");
    const base = { type: "OpenCredentialsAcquisitionState" as const, version: 1 as const, requestId: id, transitionId: `${String(raw.state)}:${String(raw.resultPreviouslyRead ?? false)}`, correlationId: id };
    if (raw.state === "challenge_required") { const type = this.proofStep(); return { ...base, state: "pending", nextStep: { id: type, type, version: 1, constraints: { challengeRequired: true } } }; }
    if (raw.state === "proof_required") { const type = this.proofStep(); this.nonces.set(id, opaque(raw.challengeNonce, "challengeNonce")); return { ...base, state: "pending", nextStep: { id: type, type, version: 1, constraints: {} } }; }
    if (raw.state === "holder_binding_required" || raw.state === "holder_signature_required") return { ...base, state: "pending", nextStep: { id: "holder_signature", type: "holder_signature", version: 1, constraints: {} } };
    if (raw.state === "ready_to_issue") return { ...base, state: "ready_to_issue" };
    if (raw.state === "issued") return { ...base, state: "complete" };
    throw new CredentialError("REQUEST_SUBSTITUTED", "Credential state is unsupported");
  }
  async beginStep(id: string, verifier: string, stepId: "collect_input" | "mailbox_otp", signal?: AbortSignal): Promise<void> { const step = this.proofStep(); if (stepId !== step) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential challenge step is substituted"); const challenge = object(await this.request("challenge", { id, verifier, method: "POST", body: { step, stepVersion: 1 }, signal }), "challenge response"); if (challenge.type !== "tinycloud.credentials/challenge/v1" || challenge.step !== step || challenge.stepVersion !== 1) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential challenge is substituted"); this.nonces.set(id, opaque(challenge.challengeNonce, "challengeNonce")); }
  async submitStep(id: string, verifier: string, stepId: string, proof: PrimitiveStepResult, signal?: AbortSignal): Promise<void> { const step = this.proofStep(); if (stepId !== step) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential proof step is substituted"); const nonce = this.nonces.get(id); if (!nonce) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential challenge is missing"); await this.request("proof", { id, verifier, method: "POST", body: { step, stepVersion: 1, challengeNonce: nonce, proof }, signal }); }
  async holderBinding(id: string, verifier: string, signal?: AbortSignal): Promise<CredentialHolderBinding> { const raw = object(await this.request("holder_binding", { id, verifier, signal }), "holder binding response"); if (raw.type !== "tinycloud.credentials/holder-binding-request/v1" || raw.signingDomain !== "tinycloud.credentials/holder-binding/v1" || raw.alg !== "EdDSA" || typeof raw.canonical !== "string") throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding response is invalid"); const binding = validateCredentialHolderBinding(raw.binding); if (encodeBase64Url(holderBindingCanonicalBytes(binding)) !== raw.canonical) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding canonical bytes were substituted"); this.bindings.set(id, binding); return binding; }
  async submitHolderSignature(id: string, verifier: string, signature: string, signal?: AbortSignal): Promise<void> { const binding = this.bindings.get(id); if (!binding) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding was not retrieved"); const kid = `${binding.holderDid}#${binding.holderDid.replace("did:key:", "")}`; await this.request("holder_signature", { id, verifier, method: "POST", body: { alg: "EdDSA", kid, signature }, signal }); }
  async issue(id: string, verifier: string, signal?: AbortSignal): Promise<void> { await this.request("issue", { id, verifier, method: "POST", signal }); }
  async result(id: string, verifier: string, signal?: AbortSignal): Promise<IssuedCredentialEnvelope> {
    const raw = object(await this.request("result", { id, verifier, signal }), "result response"); if (raw.type !== "tinycloud.credentials/result/v1" || raw.protocol !== this.descriptor.protocol || raw.profile !== this.descriptor.profile || raw.profileVersion !== 1 || raw.format !== "vc+sd-jwt" || raw.descriptorDigest !== await canonicalDigest(this.descriptor) || raw.issuer !== this.descriptor.issuer.did || raw.issuerKid !== this.descriptor.issuer.kid || typeof raw.credential !== "string" || await sha256Base64Url(raw.credential) !== raw.credentialDigest) throw new CredentialError("VERIFICATION_FAILED", "Issued result metadata is invalid");
    const holder = object(raw.holderBinding, "result holder binding"); if (raw.subject !== holder.did || holder.signingDomain !== "tinycloud.credentials/holder-binding/v1") throw new CredentialError("HOLDER_MISMATCH", "Issued holder binding is invalid");
    const claimsRaw = object(raw.claims, "result claims"); const claims: Record<string, string> = {}; for (const [name, value] of Object.entries(claimsRaw)) { if (typeof value !== "string") throw new CredentialError("VERIFICATION_FAILED", "Issued claims are invalid"); claims[name] = value; }
    const validity = object(raw.validity, "result validity"); const payload = jwtPayload(raw.credential); if (typeof payload.jti !== "string") throw new CredentialError("VERIFICATION_FAILED", "Credential id is invalid"); const issuedAt = timestamp(validity.issuedAt, "issuedAt"); const expiresAt = timestamp(validity.expiresAt, "expiresAt");
    const status = object(raw.status, "result status"); if (status.type !== "none" || status.freshnessSeconds !== this.descriptor.status.freshnessSeconds) throw new CredentialError("VERIFICATION_FAILED", "Credential status is invalid");
    return { type: "OpenCredentialsIssuedCredential", version: 1, protocol: this.descriptor.protocol, profile: { id: this.descriptor.profile, version: 1 }, credentialType: { id: this.descriptor.format.vct, version: 1 }, schema: this.descriptor.format.vct, format: "vc+sd-jwt", issuerDid: raw.issuer as string, issuerKid: raw.issuerKid as string, subjectDid: raw.subject as string, holderDid: raw.subject as string, claims, claimsDigest: await canonicalDigest(claims), descriptorDigest: raw.descriptorDigest as string, credentialId: payload.jti, issuedAt, notBefore: issuedAt, expiresAt, status: { method: "none", freshnessSeconds: status.freshnessSeconds as number }, credential: raw.credential };
  }
  async issuerMetadata(signal?: AbortSignal): Promise<CredentialIssuerMetadata> { return await this.request("issuer_metadata", { signal }) as CredentialIssuerMetadata; }
  async checkStatus(status: IssuedCredentialEnvelope["status"], _signal?: AbortSignal): Promise<boolean> { return status.method === "none" && status.freshnessSeconds === this.descriptor.status.freshnessSeconds; }
}
