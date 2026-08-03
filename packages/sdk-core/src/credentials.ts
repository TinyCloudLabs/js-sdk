import { jcsCanonicalize } from "./policy/jcs";

export const CREDENTIAL_PROTOCOL = "tinycloud.credentials/v1" as const;
export const EMAIL_PROOF_PROFILE = "tinycloud.email-proof/v1" as const;

export interface CredentialFieldDescriptor {
  readonly id: "email";
  readonly label: string;
  readonly required: true;
  readonly disclosure: "selective";
}

export interface CredentialDescriptor {
  readonly type: "TinyCloudCredentialDescriptor";
  readonly version: 1;
  readonly id: "email-proof";
  readonly profile: typeof EMAIL_PROOF_PROFILE;
  readonly issuerOrigin: string;
  readonly discoveryPath: "/.well-known/tinycloud-credentials/catalog.json";
  readonly popupPath: "/credentials/email-proof";
  readonly issuancePath: "/v1/credentials/issue";
  readonly credentialType: "opencredentials.email/v1";
  readonly fields: readonly [CredentialFieldDescriptor];
  readonly consent: {
    readonly title: string;
    readonly body: string;
  };
}

export const EMAIL_PROOF_DESCRIPTOR: CredentialDescriptor = Object.freeze({
  type: "TinyCloudCredentialDescriptor",
  version: 1,
  id: "email-proof",
  profile: EMAIL_PROOF_PROFILE,
  issuerOrigin: "https://witness.credentials.org",
  discoveryPath: "/.well-known/tinycloud-credentials/catalog.json",
  popupPath: "/credentials/email-proof",
  issuancePath: "/v1/credentials/issue",
  credentialType: "opencredentials.email/v1",
  fields: Object.freeze([Object.freeze({
    id: "email",
    label: "Email address",
    required: true,
    disclosure: "selective",
  })]) as readonly [CredentialFieldDescriptor],
  consent: Object.freeze({
    title: "Prove your email",
    body: "TinyCloud will issue a holder-bound email credential that you control.",
  }),
});

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError("credential descriptor shape is invalid");
  }
}

function canonicalOrigin(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new TypeError(`${name} is invalid`);
  return value;
}

export function validateCredentialDescriptor(value: unknown): CredentialDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("credential descriptor is invalid");
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ["type", "version", "id", "profile", "issuerOrigin", "discoveryPath", "popupPath", "issuancePath", "credentialType", "fields", "consent"]);
  if (raw.type !== "TinyCloudCredentialDescriptor" || raw.version !== 1 || raw.id !== "email-proof" || raw.profile !== EMAIL_PROOF_PROFILE || raw.discoveryPath !== EMAIL_PROOF_DESCRIPTOR.discoveryPath || raw.popupPath !== EMAIL_PROOF_DESCRIPTOR.popupPath || raw.issuancePath !== EMAIL_PROOF_DESCRIPTOR.issuancePath || raw.credentialType !== EMAIL_PROOF_DESCRIPTOR.credentialType) throw new TypeError("unsupported credential descriptor");
  const issuerOrigin = canonicalOrigin(raw.issuerOrigin, "issuerOrigin");
  if (!Array.isArray(raw.fields) || raw.fields.length !== 1) throw new TypeError("credential descriptor fields are invalid");
  const field = raw.fields[0];
  if (typeof field !== "object" || field === null || Array.isArray(field)) throw new TypeError("credential descriptor field is invalid");
  const fieldObject = field as Record<string, unknown>;
  exactKeys(fieldObject, ["id", "label", "required", "disclosure"]);
  if (fieldObject.id !== "email" || typeof fieldObject.label !== "string" || fieldObject.label.length === 0 || fieldObject.required !== true || fieldObject.disclosure !== "selective") throw new TypeError("credential descriptor field is invalid");
  if (typeof raw.consent !== "object" || raw.consent === null || Array.isArray(raw.consent)) throw new TypeError("credential descriptor consent is invalid");
  const consent = raw.consent as Record<string, unknown>;
  exactKeys(consent, ["title", "body"]);
  if (typeof consent.title !== "string" || consent.title.length === 0 || typeof consent.body !== "string" || consent.body.length === 0) throw new TypeError("credential descriptor consent is invalid");
  return Object.freeze({
    type: "TinyCloudCredentialDescriptor",
    version: 1,
    id: "email-proof",
    profile: EMAIL_PROOF_PROFILE,
    issuerOrigin,
    discoveryPath: "/.well-known/tinycloud-credentials/catalog.json",
    popupPath: "/credentials/email-proof",
    issuancePath: "/v1/credentials/issue",
    credentialType: "opencredentials.email/v1",
    fields: [Object.freeze({ id: "email", label: fieldObject.label, required: true, disclosure: "selective" })] as readonly [CredentialFieldDescriptor],
    consent: Object.freeze({ title: consent.title, body: consent.body }),
  });
}

export async function credentialDescriptorDigest(descriptor: CredentialDescriptor): Promise<string> {
  const bytes = new TextEncoder().encode(jcsCanonicalize(validateCredentialDescriptor(descriptor)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function credentialStorageKey(descriptorDigest: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(descriptorDigest)) throw new TypeError("credential descriptor digest is invalid");
  return `v1/${descriptorDigest}`;
}

export interface StoredCredential {
  readonly type: "TinyCloudStoredCredential";
  readonly version: 1;
  readonly descriptorDigest: string;
  readonly format: "vc+sd-jwt";
  readonly credential: string;
  readonly holderDid: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
