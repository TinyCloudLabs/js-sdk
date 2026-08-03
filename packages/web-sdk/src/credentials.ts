import {
  CREDENTIAL_PROTOCOL,
  EMAIL_PROOF_DESCRIPTOR,
  credentialDescriptorDigest,
  credentialStorageKey,
  jcsCanonicalize,
  validateCredentialDescriptor,
  type CredentialDescriptor,
  type StoredCredential,
} from "@tinycloud/sdk-core";
import type { ClientSession, IKVService } from "@tinycloud/sdk-core";

interface CredentialClient {
  readonly sessionDid: string;
  session(): ClientSession | undefined;
  signSessionBytes(bytes: Uint8Array): Promise<Uint8Array>;
  ensureOwnedSpaceHosted(name: string): Promise<string>;
  kvForSpace(spaceId: string): IKVService;
}

export interface CredentialsEnsureOptions {
  /** A pinned descriptor. Supplying it keeps the flow usable during discovery outages. */
  readonly descriptor?: CredentialDescriptor;
  /** Optional catalog URL used only when a pinned descriptor is not supplied. */
  readonly discoveryUrl?: string;
  /** Test/browser harness hook for the popup. Production callers use window.open. */
  readonly openPopup?: (url: string) => Window | null;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Internal hosted handoff values; callers normally leave these unset. */
  readonly state?: string;
  readonly requestId?: string;
}

export interface CredentialsEnsureResult extends StoredCredential {}

const COMPLETION_TYPE = "tinycloud-credential-complete";
const REQUEST_TYPE = "tinycloud-credential-request";
const SIGN_REQUEST_TYPE = "tinycloud-credential-sign-request";
const SIGN_RESPONSE_TYPE = "tinycloud-credential-sign-response";
const HOLDER_PROOF_DOMAIN = "xyz.tinycloud.share/email-claim-holder-binding/v1";
const REQUEST_VERSION = 1;

function randomOpaqueState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digestText(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function exactResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("credential issuance response is invalid");
  return value as Record<string, unknown>;
}

async function loadDescriptor(options: CredentialsEnsureOptions): Promise<CredentialDescriptor> {
  if (options.descriptor !== undefined) return validateCredentialDescriptor(options.descriptor);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(options.discoveryUrl ?? `${EMAIL_PROOF_DESCRIPTOR.issuerOrigin}${EMAIL_PROOF_DESCRIPTOR.discoveryPath}`, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("credential discovery unavailable");
  const catalog = exactResponse(await response.json());
  if (catalog.type !== "TinyCloudCredentialCatalog" || catalog.version !== 1 || !Array.isArray(catalog.descriptors)) throw new Error("credential catalog is invalid");
  const descriptor = catalog.descriptors.find((candidate) => typeof candidate === "object" && candidate !== null && (candidate as Record<string, unknown>).id === "email-proof");
  return validateCredentialDescriptor(descriptor);
}

function waitForCompletion(input: {
  readonly popup: Window;
  readonly origin: string;
  readonly state: string;
  readonly requestId: string;
  readonly holderDid: string;
  readonly holderSignature: string;
  readonly descriptorDigest: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly timeoutMs: number;
}): Promise<void> {
  const { popup, origin, state, requestId, holderDid, holderSignature, descriptorDigest, sign, timeoutMs } = input;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("credential proof timed out"));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      window.removeEventListener("message", onMessage);
      try { popup.close(); } catch { /* popup lifecycle is outside the SDK */ }
      if (error) reject(error); else resolve();
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== origin || event.source !== popup) return;
      const value = event.data;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.type === SIGN_REQUEST_TYPE && message.version === REQUEST_VERSION && message.state === state && message.requestId === requestId && message.holderDid === holderDid && typeof message.binding === "object" && message.binding !== null && !Array.isArray(message.binding)) {
        void sign(new TextEncoder().encode(`${HOLDER_PROOF_DOMAIN}\0${jcsCanonicalize(message.binding)}`)).then((signature) => {
          popup.postMessage({ type: SIGN_RESPONSE_TYPE, version: REQUEST_VERSION, state, requestId, signature: base64Url(signature) }, origin);
        }).catch(() => undefined);
        return;
      }
      if (message.type !== COMPLETION_TYPE || message.version !== REQUEST_VERSION || message.state !== state || message.requestId !== requestId) return;
      finish();
    };
    window.addEventListener("message", onMessage);
    popup.postMessage({ type: REQUEST_TYPE, version: REQUEST_VERSION, state, requestId, descriptorDigest, holderDid, holderSignature }, origin);
  });
}

export class CredentialsService {
  constructor(private readonly client: CredentialClient) {}

  async ensure(options: CredentialsEnsureOptions = {}): Promise<CredentialsEnsureResult> {
    if (this.client.session() === undefined) throw new Error("credentials.ensure requires an active TinyCloud session");
    const descriptor = await loadDescriptor(options);
    const descriptorDigest = await credentialDescriptorDigest(descriptor);
    const state = options.state ?? randomOpaqueState();
    const requestId = options.requestId ?? randomOpaqueState();
    if (!/^[A-Za-z0-9_-]{22}$/.test(state) || !/^[A-Za-z0-9_-]{22}$/.test(requestId)) throw new Error("credential handoff state is invalid");
    const popupFactory = options.openPopup ?? ((url: string) => window.open(url, "tinycloud-credential", "popup,width=460,height=720"));
    const popupUrl = new URL(descriptor.popupPath, descriptor.issuerOrigin);
    popupUrl.searchParams.set("state", state);
    popupUrl.searchParams.set("request", requestId);
    popupUrl.searchParams.set("descriptor", descriptorDigest);
    const popup = popupFactory(popupUrl.href);
    if (popup === null) throw new Error("credential proof popup was blocked");
    const holderDid = this.client.sessionDid;
    const unsigned = { type: CREDENTIAL_PROTOCOL, version: REQUEST_VERSION, descriptorDigest, state, requestId, holderDid };
    const signature = base64Url(await this.client.signSessionBytes(new TextEncoder().encode(`${CREDENTIAL_PROTOCOL}\0${jcsCanonicalize(unsigned)}`)));
    await waitForCompletion({ popup, origin: descriptor.issuerOrigin, state, requestId, holderDid, holderSignature: signature, descriptorDigest, sign: (bytes) => this.client.signSessionBytes(bytes), timeoutMs: options.timeoutMs ?? 120_000 });
    const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetchFn(new URL(descriptor.issuancePath, descriptor.issuerOrigin), {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "TinyCloudCredentialIssuanceRequest", version: REQUEST_VERSION, descriptorId: descriptor.id, descriptorDigest, state, requestId, holderDid, holderSignature: signature }),
    });
    if (!response.ok) throw new Error("credential issuance unavailable");
    const body = exactResponse(await response.json());
    if (body.type !== "TinyCloudCredentialIssuanceResponse" || body.version !== REQUEST_VERSION || body.format !== "vc+sd-jwt" || body.descriptorDigest !== descriptorDigest || body.holderDid !== holderDid || typeof body.credential !== "string" || typeof body.issuedAt !== "string" || typeof body.expiresAt !== "string") throw new Error("credential issuance response is invalid");
    const credentialDigest = await digestText(body.credential);
    if (body.credentialDigest !== credentialDigest) throw new Error("credential verification failed");
    const stored: StoredCredential = { type: "TinyCloudStoredCredential", version: 1, descriptorDigest, format: "vc+sd-jwt", credential: body.credential, holderDid, issuedAt: body.issuedAt, expiresAt: body.expiresAt };
    const credentialsSpace = await this.client.ensureOwnedSpaceHosted("credentials");
    const result = await this.client.kvForSpace(credentialsSpace).put(credentialStorageKey(descriptorDigest), stored);
    if (!result.ok) throw new Error("credential storage failed");
    return stored;
  }
}
