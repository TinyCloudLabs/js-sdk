import {
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
  type ECDH,
} from "node:crypto";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { DEFAULT_CHAIN_ID, DEFAULT_OPENKEY_DEVICE_API_HOST, ExitCode } from "../config/constants.js";
import type { ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { generateKey, keyToDID } from "./local-key.js";
import { publicJwkForDelegation, validateDelegationCallbackPayload } from "./browser-auth.js";
import {
  expiryLimit,
  permissionTuples,
  permissionsFromTuples,
  expectedOwnerFor,
  validateLoginPermissions,
  verifyScopedLogin,
  type RequestedExpiry,
  type SignedSession,
} from "./scoped-login.js";
import { assertNotLocalOwner, assertSessionReplaceable, commitLogin, readProfileSnapshot } from "./login-commit.js";

/** OpenKey caps device-approved delegations at 30 days. */
const DEVICE_DELEGATION_MAX_SECONDS = 30 * 24 * 60 * 60;
/** OpenKey's approval window is minutes; refuse a server asking us to poll for longer. */
const DEVICE_APPROVAL_WINDOW_MAX_SECONDS = 60 * 60;
const DEVICE_REASON_MAX_LENGTH = 200;

/**
 * OpenKey device API origin for a profile: TC_OPENKEY_HOST, then the
 * profile's self-hosted `openkeyHost`. Undefined means the production device
 * API (`api.openkey.so`), which differs from the browser approval origin.
 */
export function resolveDeviceApiHost(profile: Pick<ProfileConfig, "openkeyHost"> | null | undefined): string | undefined {
  return process.env.TC_OPENKEY_HOST ?? profile?.openkeyHost;
}

type DeviceStartResponse = {
  transactionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

/** What the owner needs to approve the request on another device. */
export type DeviceApprovalPrompt = {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: string;
};

type DeviceRelayEnvelope = {
  version: 1;
  algorithm: "ECDH-P256-A256GCM";
  ephemeralPublicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  nonce: string;
  ciphertext: string;
};

type DeviceBinding = {
  transactionId: string;
  sessionDid: string;
  nodeOrigin: string;
  shareOrigin: string;
  permissions: unknown;
  delegationExpiresAt: string;
};

type DevicePollResponse =
  | { status: "pending"; interval: number }
  | { status: "approved"; relay: DeviceRelayEnvelope; binding: DeviceBinding };

export interface DeviceAuthorizationInput {
  sessionDid: string;
  /** The local session key. Only its public half leaves this process. */
  jwk: object;
  nodeOrigin: string;
  shareOrigin: string;
  /** Manifest permissions: one space, fully qualified services and actions. */
  permissions: PermissionEntry[];
  /** Requested lifetime or absolute deadline; defaults to the 30-day maximum. */
  expiry?: RequestedExpiry;
  reason?: string;
  /** Primary DID the approving identity must match, when known. */
  expectedOwner?: string;
  openkeyHost?: string;
  fetchFn?: typeof globalThis.fetch;
  emitInstructions?: (prompt: DeviceApprovalPrompt) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface DeviceAuthorizationResult {
  /** Verified session, ready to persist (local private key merged back in). */
  session: Record<string, unknown> & SignedSession;
  ownerDid: string;
  spaceId: string;
  expiresAt: string;
  /** Capabilities the owner approved (a subset of the request). */
  approved: PermissionEntry[];
  /** Requested capabilities the owner unchecked. */
  declined: PermissionEntry[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function canonicalOrigin(value: string, label: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.origin !== value || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new Error(`${label} must be a canonical HTTPS origin`);
  }
  return value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
      : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function invalidResponse(message: string): CLIError {
  return new CLIError("DEVICE_AUTH_INVALID_RESPONSE", message, ExitCode.ERROR);
}

/** Verification pages live on the OpenKey site whose device API we called (`api.X` serves `X`). */
function verificationOrigins(openkeyHost: string): Set<string> {
  const api = new URL(openkeyHost);
  const site = new URL(openkeyHost);
  if (site.hostname.startsWith("api.")) site.hostname = site.hostname.slice("api.".length);
  return new Set([api.origin, site.origin]);
}

function validateStart(value: unknown, openkeyHost: string): DeviceStartResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("OpenKey returned an invalid device authorization response");
  const result = value as Record<string, unknown>;
  if (
    typeof result.transactionId !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(result.transactionId) ||
    typeof result.userCode !== "string" || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(result.userCode) ||
    typeof result.verificationUri !== "string" ||
    (result.verificationUriComplete !== undefined && typeof result.verificationUriComplete !== "string") ||
    !Number.isSafeInteger(result.expiresIn) || Number(result.expiresIn) < 60 || Number(result.expiresIn) > DEVICE_APPROVAL_WINDOW_MAX_SECONDS ||
    !Number.isSafeInteger(result.interval) || Number(result.interval) < 1
  ) throw invalidResponse("OpenKey returned an invalid device authorization response");
  canonicalOrigin(new URL(result.verificationUri).origin, "verification URI");
  if (!verificationOrigins(openkeyHost).has(new URL(result.verificationUri).origin)) {
    throw invalidResponse("OpenKey returned a verification URI outside its own site");
  }
  if (
    typeof result.verificationUriComplete === "string" &&
    new URL(result.verificationUriComplete).origin !== new URL(result.verificationUri).origin
  ) {
    throw invalidResponse("OpenKey returned an invalid verification URI");
  }
  return result as unknown as DeviceStartResponse;
}

async function responseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await response.json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(value: Record<string, unknown> | undefined): string | undefined {
  return typeof value?.error === "string" ? value.error : undefined;
}

function errorDescription(value: Record<string, unknown> | undefined): string | undefined {
  const description = value?.errorDescription ?? value?.error_description;
  return typeof description === "string" && description.length > 0 ? description : undefined;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;

  let seconds: number;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
  } else {
    if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/.test(value)) {
      return undefined;
    }
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt) || new Date(retryAt).toUTCString() !== value) return undefined;
    seconds = Math.ceil((retryAt - Date.now()) / 1000);
  }

  return seconds > 0 && seconds <= 600 ? seconds : undefined;
}

function deviceAuthRateLimit(response: Response): CLIError {
  const retrySeconds = retryAfterSeconds(response);
  return new CLIError(
    "DEVICE_AUTH_RATE_LIMITED",
    "OpenKey rate limited device sign-in requests from this network",
    ExitCode.ERROR,
    {
      hint: `OpenKey allows 5 device sign-in requests per 10 minutes from this network; wait up to 10 minutes, then retry once. The limit is shared by every agent on this network.${retrySeconds !== undefined ? ` Retry after ${retrySeconds} seconds.` : ""}`,
    },
  );
}


function publicSessionJwk(value: object): object {
  const publicJwk = publicJwkForDelegation(value);
  const record = publicJwk as Record<string, unknown>;
  if (record.kty !== "OKP" || record.crv !== "Ed25519" || typeof record.x !== "string") {
    throw new Error("CLI session key is not a public Ed25519 JWK");
  }
  return publicJwk;
}

function publicRelayJwk(value: unknown): DeviceRelayEnvelope["ephemeralPublicJwk"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("OpenKey returned an invalid relay key");
  const jwk = value as Record<string, unknown>;
  if (
    jwk.kty !== "EC" || jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
    typeof jwk.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y) ||
    "d" in jwk
  ) throw invalidResponse("OpenKey returned an invalid relay key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function decodeCanonicalBase64Url(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidResponse(`OpenKey returned an invalid ${label}`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw invalidResponse(`OpenKey returned an invalid ${label}`);
  return decoded;
}

function deriveRelayKey(sharedSecret: Buffer, transactionId: string): Buffer {
  const extracted = createHmac("sha256", Buffer.from(transactionId)).update(sharedSecret).digest();
  return createHmac("sha256", extracted)
    .update(Buffer.from("openkey-device-relay-v1"))
    .update(Buffer.from([1]))
    .digest();
}

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/**
 * Whether (x, y) is a point on P-256 (y² = x³ − 3x + b mod p). Checked here
 * rather than left to the runtime: Node's computeSecret refuses off-curve
 * points, but not every runtime's ECDH does (Bun 1.2.0 accepts them).
 */
function onP256(x: Buffer, y: Buffer): boolean {
  const px = BigInt(`0x${x.toString("hex")}`);
  const py = BigInt(`0x${y.toString("hex")}`);
  if (px >= P256_P || py >= P256_P) return false;
  const mod = (value: bigint) => ((value % P256_P) + P256_P) % P256_P;
  return mod(py * py) === mod(px * px * px - 3n * px + P256_B);
}

/**
 * The relay key's public JWK. ECDH runs on `createECDH` with raw points rather
 * than `KeyObject`s and `diffieHellman()`: the shared secret is identical, and
 * Bun 1.2.0 (the CI test runtime) corrupts memory in `diffieHellman()` once a
 * garbage collection separates two calls.
 */
function relayPublicJwkOf(relayKey: ECDH): DeviceRelayEnvelope["ephemeralPublicJwk"] {
  const point = relayKey.getPublicKey();
  return publicRelayJwk({ kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") });
}

function decryptRelayResult(envelope: unknown, transactionId: string, relayKey: ECDH): Record<string, unknown> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw invalidResponse("OpenKey returned an invalid encrypted relay result");
  const relay = envelope as Partial<DeviceRelayEnvelope>;
  if (relay.version !== 1 || relay.algorithm !== "ECDH-P256-A256GCM") throw invalidResponse("OpenKey returned an unsupported encrypted relay result");
  const peerJwk = publicRelayJwk(relay.ephemeralPublicJwk);
  const x = decodeCanonicalBase64Url(peerJwk.x, "relay key");
  const y = decodeCanonicalBase64Url(peerJwk.y, "relay key");
  if (x.length !== 32 || y.length !== 32 || !onP256(x, y)) throw invalidResponse("OpenKey returned an invalid relay key");
  const nonce = decodeCanonicalBase64Url(relay.nonce, "relay nonce");
  const ciphertext = decodeCanonicalBase64Url(relay.ciphertext, "relay ciphertext");
  if (nonce.length !== 12 || ciphertext.length <= 16) throw invalidResponse("OpenKey returned an invalid encrypted relay result");
  let sharedSecret: Buffer;
  try {
    sharedSecret = relayKey.computeSecret(Buffer.concat([Buffer.from([4]), x, y]));
  } catch {
    throw invalidResponse("OpenKey returned an invalid relay key");
  }
  const key = deriveRelayKey(sharedSecret, transactionId);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(transactionId));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8"));
  } catch {
    throw invalidResponse("OpenKey returned an unreadable encrypted relay result");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("OpenKey returned an invalid encrypted relay result");
  return value as Record<string, unknown>;
}

function permissionList(value: unknown, label: string): PermissionEntry[] {
  const valid = Array.isArray(value) && value.length > 0 && value.every((entry: Record<string, unknown> | null) =>
    entry !== null && typeof entry === "object" &&
    typeof entry.service === "string" && typeof entry.space === "string" && typeof entry.path === "string" &&
    Array.isArray(entry.actions) && entry.actions.length > 0 &&
    entry.actions.every((action) => typeof action === "string" && action.length > 0));
  if (!valid) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", `OpenKey returned no valid ${label} permissions. No session was saved.`, ExitCode.PERMISSION_DENIED);
  }
  return value as PermissionEntry[];
}

function sameTuples(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((tuple) => right.has(tuple));
}

function delegationExpiry(delegation: Record<string, unknown>): number {
  const value = delegation.expiresAt ?? delegation.expirationTime ?? delegation.expiry;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * Accept an approval only when every independent statement of it agrees:
 * the transaction binding, the relayed delegation, and the signed SIWE proof.
 */
async function verifyApproval(input: {
  binding: DeviceBinding;
  delegation: Record<string, unknown>;
  transactionId: string;
  sessionDid: string;
  nodeOrigin: string;
  shareOrigin: string;
  publicJwk: object;
  key: object;
  requested: PermissionEntry[];
  expiry: RequestedExpiry;
  expectedOwner?: string;
}): Promise<DeviceAuthorizationResult> {
  const { binding, delegation } = input;
  if (
    binding.transactionId !== input.transactionId ||
    binding.sessionDid !== input.sessionDid ||
    binding.nodeOrigin !== input.nodeOrigin ||
    binding.shareOrigin !== input.shareOrigin
  ) throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "OpenKey returned a delegation with the wrong device binding. No session was saved.", ExitCode.PERMISSION_DENIED);
  const expiresAt = Date.parse(binding.delegationExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > expiryLimit(input.expiry)) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "OpenKey returned a delegation outside the requested expiry window. No session was saved.", ExitCode.PERMISSION_DENIED);
  }
  if (delegationExpiry(delegation) !== expiresAt) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "OpenKey returned a delegation outside the approved expiry window. No session was saved.", ExitCode.PERMISSION_DENIED);
  }
  if (delegation.verificationMethod !== input.sessionDid) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "OpenKey returned a delegation for a different CLI session DID. No session was saved.", ExitCode.PERMISSION_DENIED);
  }
  if (!delegation.jwk || typeof delegation.jwk !== "object" || !jsonEqual(publicSessionJwk(delegation.jwk), input.publicJwk)) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "OpenKey returned a delegation for a different CLI session key. No session was saved.", ExitCode.PERMISSION_DENIED);
  }
  const invalid = validateDelegationCallbackPayload(delegation);
  if (invalid) throw invalidResponse(`OpenKey returned an invalid delegation: ${invalid}`);

  // Signed authority: owner, space, session key, lifetime, and a recap that
  // stays inside the request.
  const session = verifyScopedLogin(delegation, input.key, input.sessionDid, input.requested, {
    expectedOwner: input.expectedOwner,
    expiry: input.expiry,
  });
  const { ownerDid } = session;
  if (Math.abs(Date.parse(session.expiresAt) - expiresAt) > 1000) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "The signed session expiry differs from the approved expiry. No session was saved.", ExitCode.PERMISSION_DENIED);
  }

  // The signed ReCap is the authority. OpenKey's unsigned statements of the
  // approved set (binding and relayed delegation) must match it exactly, so
  // neither can over- or under-report what was granted.
  const signed = permissionTuples(session.permissions, ownerDid);
  if (
    !sameTuples(signed, permissionTuples(permissionList(binding.permissions, "approved"), ownerDid)) ||
    !sameTuples(signed, permissionTuples(permissionList(delegation.permissions, "delegated"), ownerDid))
  ) {
    throw new CLIError("DEVICE_AUTH_BINDING_MISMATCH", "OpenKey's approved permissions differ from the signed grant. No session was saved.", ExitCode.PERMISSION_DENIED);
  }
  const requested = permissionTuples(input.requested, ownerDid);
  return {
    session,
    ownerDid,
    spaceId: delegation.spaceId as string,
    expiresAt: session.expiresAt,
    approved: permissionsFromTuples(signed),
    declined: permissionsFromTuples([...requested].filter((tuple) => !signed.has(tuple))),
  };
}

function writeApprovalPrompt(prompt: DeviceApprovalPrompt): void {
  const link = prompt.verificationUriComplete ?? prompt.verificationUri;
  process.stderr.write(
    `Approve on your phone: ${link} (code ${prompt.userCode})\n` +
    `  Or open ${prompt.verificationUri} and enter code ${prompt.userCode}.\n` +
    `  Waiting for approval until ${prompt.expiresAt}. Keep this command running.\n`,
  );
}

/**
 * Request exactly `permissions` through OpenKey device authorization, wait
 * for the owner's approval for the whole approval window, and return the
 * verified session. Nothing is persisted here.
 */
export async function acquireDeviceDelegation(input: DeviceAuthorizationInput): Promise<DeviceAuthorizationResult> {
  validateLoginPermissions(input.permissions);
  const expiry = input.expiry ?? { durationMs: DEVICE_DELEGATION_MAX_SECONDS * 1000 };
  const ttlSeconds = Math.floor(expiry.durationMs / 1000);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > DEVICE_DELEGATION_MAX_SECONDS) {
    throw new CLIError("INVALID_EXPIRY", "Device authorization --expiry must be between 1 minute and 30 days.", ExitCode.USAGE_ERROR);
  }
  const reason = input.reason?.trim().slice(0, DEVICE_REASON_MAX_LENGTH);
  const openkeyHost = canonicalOrigin(input.openkeyHost ?? DEFAULT_OPENKEY_DEVICE_API_HOST, "OpenKey host");
  const nodeOrigin = canonicalOrigin(input.nodeOrigin, "TinyCloud node origin");
  const shareOrigin = canonicalOrigin(input.shareOrigin, "Share origin");
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const deviceSecret = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const relayKey = createECDH("prime256v1");
  relayKey.generateKeys();
  const relayPublicJwk = relayPublicJwkOf(relayKey);
  const publicJwk = publicSessionJwk(input.jwk);
  let startResponse: Response;
  try {
    startResponse = await fetchFn(`${openkeyHost}/api/device-authorizations`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        deviceSecretHash: digest(deviceSecret),
        codeChallenge: digest(codeVerifier),
        relayPublicJwk,
        sessionDid: input.sessionDid,
        publicJwk,
        permissions: input.permissions.map(({ service, space, path, actions }) => ({ service, space, path, actions })),
        nodeOrigin,
        shareOrigin,
        delegationTtlSeconds: ttlSeconds,
        ...(reason ? { reason } : {}),
      }),
    });
  } catch (error) {
    throw new CLIError(
      "OPENKEY_UNREACHABLE",
      `Could not reach the OpenKey device API at ${openkeyHost}: ${error instanceof Error ? error.message : String(error)}. Check TC_OPENKEY_HOST or the profile's openkeyHost.`,
      ExitCode.NETWORK_ERROR,
    );
  }
  const startValue = await responseJson(startResponse);
  if (!startResponse.ok) {
    const code = errorCode(startValue);
    const description = errorDescription(startValue);
    if (startResponse.status === 429 && code === "rate_limited") {
      throw deviceAuthRateLimit(startResponse);
    }
    if (code === "invalid_scope") {
      throw new CLIError(
        "SCOPE_REJECTED",
        `OpenKey rejected the requested scope${description ? `: ${description}` : "."} Remove that capability from the manifest or use another approval flow.`,
        ExitCode.PERMISSION_DENIED,
        { openkeyError: code, ...(description ? { capability: description } : {}) },
      );
    }
    throw new CLIError("DEVICE_AUTH_FAILED", `OpenKey device authorization failed: ${code ?? `HTTP ${startResponse.status}`}${description ? ` (${description})` : ""}`, ExitCode.ERROR);
  }
  const started = validateStart(startValue, openkeyHost);
  const deadline = Date.now() + started.expiresIn * 1000;
  (input.emitInstructions ?? writeApprovalPrompt)({
    verificationUri: started.verificationUri,
    ...(started.verificationUriComplete ? { verificationUriComplete: started.verificationUriComplete } : {}),
    userCode: started.userCode,
    expiresAt: new Date(deadline).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });

  let interval = started.interval;
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (Date.now() < deadline) {
    await wait(interval * 1000);
    let response: Response;
    try {
      response = await fetchFn(`${openkeyHost}/api/device-authorizations/token`, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ transactionId: started.transactionId, deviceSecret, codeVerifier }),
      });
    } catch {
      // Phone approval takes minutes; a dropped poll must not end the window.
      continue;
    }
    const value = await responseJson(response);
    const code = errorCode(value);
    if (response.status >= 500 || (response.status === 429 && code !== "slow_down")) continue;
    if (code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "authorization_pending") continue;
    if (code === "access_denied") {
      throw new CLIError("DEVICE_AUTH_DENIED", "The owner denied the OpenKey device authorization. No session was saved.", ExitCode.PERMISSION_DENIED);
    }
    if (code === "expired_token") {
      throw new CLIError("DEVICE_AUTH_EXPIRED", "OpenKey device authorization expired_token: the approval window closed. Run the command again.", ExitCode.AUTH_REQUIRED);
    }
    if (!response.ok) throw new CLIError("DEVICE_AUTH_FAILED", `OpenKey device authorization failed: ${code ?? `HTTP ${response.status}`}`, ExitCode.ERROR);
    const result = value as DevicePollResponse | undefined;
    if (result?.status === "pending") {
      interval = Math.max(interval, Number.isSafeInteger(result.interval) ? result.interval : interval);
      continue;
    }
    if (result?.status !== "approved" || !result.relay || !result.binding) {
      throw invalidResponse("OpenKey returned an invalid device authorization result");
    }
    const delegation = decryptRelayResult(result.relay, started.transactionId, relayKey);
    return verifyApproval({
      binding: result.binding,
      delegation,
      transactionId: started.transactionId,
      sessionDid: input.sessionDid,
      nodeOrigin,
      shareOrigin,
      publicJwk,
      key: input.jwk,
      requested: input.permissions,
      expiry,
      expectedOwner: input.expectedOwner,
    });
  }
  throw new CLIError("DEVICE_AUTH_EXPIRED", "OpenKey device authorization expired before approval. Run the command again.", ExitCode.AUTH_REQUIRED);
}

export function mergePrivateJwkIntoSession(session: Record<string, unknown>, key: object): Record<string, unknown> {
  const sessionJwk = session.jwk;
  if (!sessionJwk || typeof sessionJwk !== "object") return session;
  const sessionJwkRecord = sessionJwk as Record<string, unknown>;
  if (typeof sessionJwkRecord.d === "string" && sessionJwkRecord.d.length > 0) return session;
  const privateParameter = (key as Record<string, unknown>).d;
  if (typeof privateParameter !== "string" || privateParameter.length === 0) return session;
  return { ...session, jwk: { ...sessionJwkRecord, d: privateParameter } };
}

/**
 * Device login for a profile: request `permissions`, verify the approval, and
 * only then persist key, session and the OpenKey owner posture, in one
 * lock-protected compare-and-commit against the state seen before consent.
 */
export async function loginWithDeviceAuthorization(input: Omit<DeviceAuthorizationInput, "sessionDid" | "jwk"> & {
  profileName: string;
  /** Explicitly allow replacing a live session that the new scope would narrow. */
  replaceSession?: boolean;
  /** Record `nodeOrigin` as the profile host (an explicit `--host`, or a profile without one). */
  persistHost?: boolean;
}): Promise<{ profile: ProfileConfig; result: DeviceAuthorizationResult }> {
  const snapshot = await readProfileSnapshot(input.profileName);
  const existing = snapshot.profile;
  assertNotLocalOwner(input.profileName, existing, "Device login");
  // Every profile that recorded an owner stays with that owner.
  const expectedOwner = expectedOwnerFor(input.profileName, existing, input.expectedOwner);
  // Early refusal on the request; the commit re-checks the approved scope.
  if (input.replaceSession !== true) {
    const estimatedExpiry = new Date(Date.now() + (input.expiry?.durationMs ?? DEVICE_DELEGATION_MAX_SECONDS * 1000)).toISOString();
    assertSessionReplaceable(input.profileName, snapshot, expectedOwner, input.permissions, estimatedExpiry);
  }
  const key = snapshot.key ?? generateKey().jwk;
  const sessionDid = keyToDID(key);
  const result = await acquireDeviceDelegation({
    ...input,
    sessionDid,
    jwk: key,
    openkeyHost: input.openkeyHost ?? resolveDeviceApiHost(existing),
    expectedOwner,
  });
  const profile: ProfileConfig = {
    ...existing,
    name: input.profileName,
    host: input.persistHost === true || !existing?.host ? input.nodeOrigin : existing.host,
    chainId: existing?.chainId ?? DEFAULT_CHAIN_ID,
    spaceName: result.spaceId.slice(result.spaceId.lastIndexOf(":") + 1),
    did: sessionDid,
    sessionDid,
    ownerDid: result.ownerDid,
    spaceId: result.spaceId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    posture: "owner-openkey",
    operatorType: existing?.operatorType ?? "human",
    authMethod: "openkey",
  };
  await commitLogin(input.profileName, snapshot, {
    key,
    session: result.session,
    profile,
    // The signed permissions, with their caveats; `approved` is the action summary.
    approved: { scope: result.session.permissions, ownerDid: result.ownerDid, replaceSession: input.replaceSession === true },
  });
  return { profile, result };
}
