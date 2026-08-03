import {
  CredentialError,
  credentialEndpointPath,
  type CredentialFlowDescriptor,
  type CredentialHolderBinding,
  type CredentialIssuerMetadata,
  type CredentialRequirement,
  type IssuedCredentialEnvelope,
} from "@tinycloud/sdk-core";
import type { CredentialAcquisitionTransport, CredentialRequestState, PrimitiveStepResult } from "./types";

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`);
  return value as Record<string, unknown>;
}

function requestId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new CredentialError("REQUEST_SUBSTITUTED", `${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CredentialError("VERIFICATION_FAILED", `${label} is invalid`);
  return new Date(value).toISOString();
}

export class OpenCredentialsHttpTransport implements CredentialAcquisitionTransport {
  constructor(private readonly descriptor: CredentialFlowDescriptor, private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private url(endpoint: Parameters<typeof credentialEndpointPath>[0], id?: string): string {
    return new URL(credentialEndpointPath(endpoint, id), this.descriptor.issuer.origin).href;
  }

  private async request(endpoint: Parameters<typeof credentialEndpointPath>[0], input: { readonly id?: string; readonly method?: "GET" | "POST"; readonly verifier?: string; readonly body?: unknown; readonly signal?: AbortSignal }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url(endpoint, input.id), { method: input.method ?? "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: input.signal, headers: { "accept": "application/json", ...(input.body === undefined ? {} : { "content-type": "application/json" }), ...(input.verifier === undefined ? {} : { "authorization": `CredentialVerifier ${input.verifier}` }) }, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw new CredentialError("CANCELED", "Credential acquisition was canceled", { cause });
      throw new CredentialError("OFFLINE", "OpenCredentials is unavailable", { cause });
    }
    if (response.status === 410) throw new CredentialError("REQUEST_EXPIRED", "Credential request expired");
    if (response.status === 409) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential request was replayed or substituted");
    if (response.status === 503) throw new CredentialError("ISSUER_UNREADY", "Credential issuer is not ready", { retryAfterMs: Number(response.headers.get("retry-after")) * 1000 || undefined });
    if (!response.ok) throw new CredentialError("VERIFICATION_FAILED", "OpenCredentials rejected the request", { correlationId: response.headers.get("x-correlation-id") ?? undefined });
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch (cause) { throw new CredentialError("VERIFICATION_FAILED", "OpenCredentials response is invalid", { cause }); }
  }

  async create(input: { descriptor: CredentialFlowDescriptor; descriptorDigest: string; requirement: CredentialRequirement; requirementDigest: string; holderDid: string; openerOrigin: string; completionVerifierChallenge: string; signal?: AbortSignal }) {
    const body = jsonObject(await this.request("create_request", { method: "POST", body: { type: "OpenCredentialsAcquisitionCreate", protocol: input.descriptor.protocol, version: 1, profile: input.descriptor.profile, descriptorDigest: input.descriptorDigest, requirement: input.requirement, requirementDigest: input.requirementDigest, holderDid: input.holderDid, openerOrigin: input.openerOrigin, completionVerifierChallenge: input.completionVerifierChallenge }, signal: input.signal }), "create response");
    const expected = ["type", "version", "requestId", "locator", "expiresAt", "correlationId"].sort(); const actual = Object.keys(body).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) || body.type !== "OpenCredentialsAcquisitionCreated" || body.version !== 1) throw new CredentialError("VERIFICATION_FAILED", "create response is invalid");
    return { requestId: requestId(body.requestId, "requestId"), locator: requestId(body.locator, "locator"), expiresAt: timestamp(body.expiresAt, "expiresAt"), correlationId: requestId(body.correlationId, "correlationId") };
  }

  async state(id: string, verifier: string, signal?: AbortSignal): Promise<CredentialRequestState> {
    const value = jsonObject(await this.request("request_state", { id, verifier, signal }), "state response");
    const allowed = ["type", "version", "requestId", "transitionId", "state", "nextStep", "retryAfterMs", "correlationId"];
    if (Object.keys(value).some((key) => !allowed.includes(key)) || value.type !== "OpenCredentialsAcquisitionState" || value.version !== 1 || value.requestId !== id || !["pending", "ready_to_issue", "issued", "complete", "expired", "canceled", "issuer_unready"].includes(value.state as string) || typeof value.transitionId !== "string" || typeof value.correlationId !== "string") throw new CredentialError("REQUEST_SUBSTITUTED", "Credential state response is substituted");
    if (value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || (value.retryAfterMs as number) < 0 || (value.retryAfterMs as number) > 60_000)) throw new CredentialError("VERIFICATION_FAILED", "Credential retry interval is invalid");
    if (value.nextStep !== undefined) {
      const next = jsonObject(value.nextStep, "next step"); const keys = Object.keys(next).sort(); const expected = ["id", "type", "version", "constraints"].sort();
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || typeof next.id !== "string" || !["collect_input", "mailbox_otp", "holder_signature"].includes(next.type as string) || next.version !== 1 || typeof next.constraints !== "object" || next.constraints === null || Array.isArray(next.constraints)) throw new CredentialError("VERIFICATION_FAILED", "Credential next step is invalid");
    }
    return value as unknown as CredentialRequestState;
  }
  async submitStep(id: string, verifier: string, stepId: string, proof: PrimitiveStepResult, signal?: AbortSignal): Promise<void> { await this.request("submit_proof", { id, verifier, method: "POST", body: { type: "OpenCredentialsStepProof", version: 1, stepId, proof }, signal }); }
  async holderBinding(id: string, verifier: string, signal?: AbortSignal): Promise<CredentialHolderBinding> { return await this.request("holder_binding", { id, verifier, signal }) as CredentialHolderBinding; }
  async submitHolderSignature(id: string, verifier: string, signature: string, signal?: AbortSignal): Promise<void> { await this.request("submit_holder_signature", { id, verifier, method: "POST", body: { type: "OpenCredentialsHolderSignature", version: 1, alg: "EdDSA", signature }, signal }); }
  async issue(id: string, verifier: string, signal?: AbortSignal): Promise<void> { await this.request("issue", { id, verifier, method: "POST", body: { type: "OpenCredentialsIssue", version: 1 }, signal }); }
  async result(id: string, verifier: string, signal?: AbortSignal): Promise<IssuedCredentialEnvelope> { return await this.request("result", { id, verifier, signal }) as IssuedCredentialEnvelope; }
  async issuerMetadata(signal?: AbortSignal): Promise<CredentialIssuerMetadata> { return await this.request("issuer_metadata", { signal }) as CredentialIssuerMetadata; }
  async checkStatus(status: IssuedCredentialEnvelope["status"], signal?: AbortSignal): Promise<boolean> {
    const value = jsonObject(await this.request("credential_status", { method: "POST", body: { type: "OpenCredentialsStatusRequest", version: 1, reference: status.reference }, signal }), "status response");
    return value.type === "OpenCredentialsStatusResponse" && value.version === 1 && value.reference === status.reference && value.valid === true;
  }
}
