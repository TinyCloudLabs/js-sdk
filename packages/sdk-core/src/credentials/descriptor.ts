import { CredentialError } from "./errors";
import {
  CREDENTIAL_ACQUISITION_PROTOCOL,
  CREDENTIAL_FORMAT,
  CREDENTIAL_STEP_REGISTRY_VERSION,
  HOLDER_BINDING_DOMAIN,
  type CredentialEndpointId,
  type CredentialFlowDescriptor,
  type CredentialInputDescriptor,
  type CredentialStepDescriptor,
} from "./types";

const ENDPOINT_IDS: readonly CredentialEndpointId[] = [
  "create_request", "request_state", "create_challenge", "submit_proof", "holder_binding",
  "submit_holder_signature", "issue", "result", "issuer_metadata", "credential_status", "interaction",
];
const STEP_TYPES = new Set(["collect_input", "mailbox_otp", "holder_signature"]);
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} has unknown or missing fields`);
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
  return value as string;
}

function positiveInteger(value: unknown, label: string, max = 86400): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail(`${label} is invalid`);
  return value as number;
}

function origin(value: unknown): string {
  const candidate = text(value, "issuer.origin");
  let url: URL;
  try { url = new URL(candidate); } catch { fail("issuer.origin is invalid"); }
  if (url!.protocol !== "https:" || url!.origin !== candidate || url!.username || url!.password) fail("issuer.origin is invalid");
  return candidate;
}

function fail(message: string): never {
  throw new CredentialError("DESCRIPTOR_INVALID", message);
}

function input(value: unknown, seen: Set<string>): CredentialInputDescriptor {
  const raw = object(value, "input");
  keys(raw, ["id", "label", "required", "prefill", "schema", "accessibility"], "input");
  const id = text(raw.id, "input.id", ID);
  if (seen.has(id)) fail("input ids must be unique");
  seen.add(id);
  if (typeof raw.required !== "boolean" || (raw.prefill !== "allowed" && raw.prefill !== "forbidden")) fail("input flags are invalid");
  const schema = object(raw.schema, "input.schema");
  const schemaKeys = Object.keys(schema);
  if (schemaKeys.some((key) => !["type", "minLength", "maxLength", "pattern", "format"].includes(key)) || schema.type !== "string") fail("input.schema is unsupported");
  const minLength = schema.minLength === undefined ? undefined : positiveInteger(schema.minLength, "input.schema.minLength", 4096);
  const maxLength = schema.maxLength === undefined ? undefined : positiveInteger(schema.maxLength, "input.schema.maxLength", 4096);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) fail("input.schema length is invalid");
  if (schema.pattern !== undefined) {
    const pattern = text(schema.pattern, "input.schema.pattern");
    try { new RegExp(pattern, "u"); } catch { fail("input.schema.pattern is invalid"); }
  }
  if (schema.format !== undefined && schema.format !== "email") fail("input.schema.format is unsupported");
  const accessibility = object(raw.accessibility, "input.accessibility");
  if (Object.keys(accessibility).some((key) => !["label", "description"].includes(key)) || !Object.prototype.hasOwnProperty.call(accessibility, "label")) fail("input.accessibility is invalid");
  return {
    id, label: text(raw.label, "input.label"), required: raw.required as boolean,
    prefill: raw.prefill as "allowed" | "forbidden",
    schema: { type: "string", ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(schema.pattern === undefined ? {} : { pattern: schema.pattern as string }), ...(schema.format === undefined ? {} : { format: schema.format as "email" }) },
    accessibility: { label: text(accessibility.label, "input.accessibility.label"), ...(accessibility.description === undefined ? {} : { description: text(accessibility.description, "input.accessibility.description") }) },
  };
}

function step(value: unknown, seen: Set<string>): CredentialStepDescriptor {
  const raw = object(value, "step");
  keys(raw, ["id", "type", "version", "endpoint", "title", "description"], "step");
  const id = text(raw.id, "step.id", ID);
  if (seen.has(id)) fail("step ids must be unique");
  seen.add(id);
  if (!STEP_TYPES.has(raw.type as string) || raw.version !== 1 || !ENDPOINT_IDS.includes(raw.endpoint as CredentialEndpointId)) {
    throw new CredentialError("UNSUPPORTED_PROFILE", "Credential step type or version is unsupported");
  }
  return { id, type: raw.type as CredentialStepDescriptor["type"], version: 1, endpoint: raw.endpoint as CredentialEndpointId, title: text(raw.title, "step.title"), description: text(raw.description, "step.description") };
}

/** Strictly validates the finite, non-executable acquisition descriptor vocabulary. */
export function validateCredentialFlowDescriptor(value: unknown): CredentialFlowDescriptor {
  const raw = object(value, "descriptor");
  keys(raw, ["type", "protocol", "version", "stepRegistryVersion", "profile", "issuer", "credential", "claims", "inputs", "steps", "holderBinding", "endpoints", "ttlSeconds", "freshnessSeconds", "presentation"], "descriptor");
  if (raw.type !== "OpenCredentialsFlowDescriptor" || raw.protocol !== CREDENTIAL_ACQUISITION_PROTOCOL || raw.version !== 1 || raw.stepRegistryVersion !== CREDENTIAL_STEP_REGISTRY_VERSION) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential protocol or registry version is unsupported");
  const profile = object(raw.profile, "profile"); keys(profile, ["id", "version"], "profile");
  if (profile.version !== 1) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential profile version is unsupported");
  const issuer = object(raw.issuer, "issuer"); keys(issuer, ["origin", "did"], "issuer");
  const credential = object(raw.credential, "credential"); keys(credential, ["type", "version", "schema", "format"], "credential");
  if (credential.version !== 1 || credential.format !== CREDENTIAL_FORMAT) throw new CredentialError("UNSUPPORTED_PROFILE", "Credential format or type version is unsupported");
  if (!Array.isArray(raw.claims) || raw.claims.length === 0 || raw.claims.length > 64) fail("claims are invalid");
  const claimIds = new Set<string>();
  const claims: CredentialFlowDescriptor["claims"][number][] = raw.claims.map((value: unknown) => {
    const claim = object(value, "claim"); keys(claim, ["id", "matching", "required"], "claim");
    const id = text(claim.id, "claim.id", ID);
    if (claimIds.has(id) || claim.matching !== "exact" || typeof claim.required !== "boolean") fail("claim is invalid");
    claimIds.add(id); return { id, matching: "exact" as const, required: claim.required as boolean };
  });
  if (!Array.isArray(raw.inputs) || raw.inputs.length > 64) fail("inputs are invalid");
  const inputIds = new Set<string>(); const inputs = raw.inputs.map((value) => input(value, inputIds));
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 32) fail("steps are invalid");
  const stepIds = new Set<string>(); const steps = raw.steps.map((value) => step(value, stepIds));
  if (!steps.some((candidate) => candidate.type === "holder_signature")) fail("holder_signature is required");
  const binding = object(raw.holderBinding, "holderBinding"); keys(binding, ["required", "domain", "version"], "holderBinding");
  if (binding.required !== true || binding.domain !== HOLDER_BINDING_DOMAIN || binding.version !== 1) throw new CredentialError("UNSUPPORTED_PROFILE", "Holder binding version is unsupported");
  const endpoints = object(raw.endpoints, "endpoints"); keys(endpoints, ENDPOINT_IDS, "endpoints");
  for (const endpoint of ENDPOINT_IDS) if (endpoints[endpoint] !== endpoint) fail("endpoint identifiers must use the registered vocabulary");
  const presentation = object(raw.presentation, "presentation"); keys(presentation, ["title", "description", "consent", "progressLabel", "successLabel", "recoveryLabel"], "presentation");
  return Object.freeze({
    type: "OpenCredentialsFlowDescriptor", protocol: CREDENTIAL_ACQUISITION_PROTOCOL, version: 1, stepRegistryVersion: 1,
    profile: Object.freeze({ id: text(profile.id, "profile.id", ID), version: 1 }),
    issuer: Object.freeze({ origin: origin(issuer.origin), did: text(issuer.did, "issuer.did", /^did:[a-z0-9]+:.+$/) }),
    credential: Object.freeze({ type: text(credential.type, "credential.type", ID), version: 1, schema: text(credential.schema, "credential.schema"), format: CREDENTIAL_FORMAT }),
    claims: Object.freeze(claims.map((claim) => Object.freeze(claim))), inputs: Object.freeze(inputs.map((item) => Object.freeze(item))), steps: Object.freeze(steps.map((item) => Object.freeze(item))),
    holderBinding: Object.freeze({ required: true, domain: HOLDER_BINDING_DOMAIN, version: 1 }),
    endpoints: Object.freeze(Object.fromEntries(ENDPOINT_IDS.map((id) => [id, id])) as Record<CredentialEndpointId, CredentialEndpointId>),
    ttlSeconds: positiveInteger(raw.ttlSeconds, "ttlSeconds"), freshnessSeconds: positiveInteger(raw.freshnessSeconds, "freshnessSeconds", 31_536_000),
    presentation: Object.freeze({ title: text(presentation.title, "presentation.title"), description: text(presentation.description, "presentation.description"), consent: text(presentation.consent, "presentation.consent"), progressLabel: text(presentation.progressLabel, "presentation.progressLabel"), successLabel: text(presentation.successLabel, "presentation.successLabel"), recoveryLabel: text(presentation.recoveryLabel, "presentation.recoveryLabel") }),
  });
}

export function credentialEndpointPath(id: CredentialEndpointId, requestId?: string): string {
  const encoded = requestId === undefined ? "" : `/${encodeURIComponent(requestId)}`;
  const paths: Record<CredentialEndpointId, string> = {
    create_request: "/v1/credential-acquisitions", request_state: `/v1/credential-acquisitions${encoded}/status`, create_challenge: `/v1/credential-acquisitions${encoded}/challenge`, submit_proof: `/v1/credential-acquisitions${encoded}/proof`, holder_binding: `/v1/credential-acquisitions${encoded}/holder-binding`, submit_holder_signature: `/v1/credential-acquisitions${encoded}/holder-signature`, issue: `/v1/credential-acquisitions${encoded}/issue`, result: `/v1/credential-acquisitions${encoded}/result`, issuer_metadata: "/.well-known/opencredentials/issuer", credential_status: "/v1/credential-status", interaction: `/credential-acquisition${encoded}`,
  };
  return paths[id];
}
