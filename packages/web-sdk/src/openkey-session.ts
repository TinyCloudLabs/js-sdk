import type {
  ClientSession,
  ComposedManifestRequest,
  Manifest,
} from "@tinycloud/sdk-core";
import { utils } from "ethers";
import {
  createOpenKeyCallbackSigningStrategy,
  type OpenKeySigningRequestBody,
} from "@tinycloud/sdk-core";
import {
  TinyCloudWeb,
  type Config,
  type SessionRestoreResult,
} from "./modules/tcw";

const SESSION_EXPIRATION_MS = 3600000 as const;
const SESSION_STORAGE_KEY_PREFIX =
  "coordinationos:tinycloud:session:v1:" as const;
const SIGNING_PATH = "/api/delegate/sign";

const FORBIDDEN_TINYCLOUD_OPTIONS = [
  "provider",
  "providers",
  "signStrategy",
  "manifest",
  "capabilityRequest",
  "siweConfig",
  "nonce",
  "domain",
  "persistSession",
  "sessionStorage",
  "sessionExpirationMs",
  "sessionStorageKeyPrefix",
  "includeAccountRegistryPermissions",
  "autoCreateSpace",
  "autoBootstrapAccount",
  "spaceCreationHandler",
  "spacePrefix",
  "kvPrefix",
] as const;

type CoordinationOsControlledConfig =
  | "provider"
  | "providers"
  | "signStrategy"
  | "manifest"
  | "capabilityRequest"
  | "siweConfig"
  | "nonce"
  | "domain"
  | "persistSession"
  | "sessionStorage"
  | "sessionExpirationMs"
  | "sessionStorageKeyPrefix"
  | "includeAccountRegistryPermissions"
  | "autoCreateSpace"
  | "autoBootstrapAccount"
  | "spaceCreationHandler"
  | "spacePrefix"
  | "kvPrefix";

export type EstablishOpenKeySessionStatus =
  | "established"
  | "restored"
  | "missing"
  | "expired"
  | "corrupt"
  | "storage-unavailable"
  | "restore-failed"
  | "stale"
  | "disabled";

export interface EstablishOpenKeySessionOptions {
  providerToken?: string;
  signingEndpoint: string;
  key: {
    keyId: string;
    address: string;
    chainId: 1;
  };
  manifest: Manifest;
  origin: string;
  sessionExpirationMs: typeof SESSION_EXPIRATION_MS;
  sessionStorageKeyPrefix: typeof SESSION_STORAGE_KEY_PREFIX;
  tinycloud?: Omit<Config, CoordinationOsControlledConfig>;
  fetch?: typeof fetch;
}

export interface EstablishOpenKeySessionResult {
  client: TinyCloudWeb;
  session?: ClientSession;
  status: EstablishOpenKeySessionStatus;
}

const TOKEN_UNAVAILABLE = new Error("OpenKey provider token is unavailable");

function ownKeysEqual(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function normalizeEndpoint(value: string): string {
  if (value.includes("?") || value.includes("#")) {
    throw new Error("OpenKey signing endpoint is not CoordinationOS-compatible");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("OpenKey signing endpoint must be an absolute URL");
  }

  const rawHttpAuthority = value.match(/^http:\/\/([^/?#]*)/i)?.[1];
  const isExactLoopback =
    rawHttpAuthority !== undefined &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(
      rawHttpAuthority,
    );
  const allowedProtocol =
    endpoint.protocol === "https:" ||
    (endpoint.protocol === "http:" && isExactLoopback);
  if (
    !allowedProtocol ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== SIGNING_PATH ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("OpenKey signing endpoint is not CoordinationOS-compatible");
  }
  return endpoint.href;
}

function normalizeOrigin(value: string): { origin: string; domain: string } {
  if (value.includes("?") || value.includes("#")) {
    throw new Error("CoordinationOS origin is not canonical");
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("CoordinationOS origin must be an absolute URL");
  }

  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("CoordinationOS origin is not canonical");
  }

  return { origin: origin.origin, domain: origin.host };
}

function validateAddress(address: string): void {
  let checksummed: string;
  try {
    checksummed = utils.getAddress(address);
  } catch {
    throw new Error("OpenKey key address must be EIP-55-compatible");
  }
  if (checksummed !== address) {
    throw new Error("OpenKey key address must use EIP-55 checksum casing");
  }
}

function validateTinyCloudOverrides(
  tinycloud: EstablishOpenKeySessionOptions["tinycloud"],
): void {
  if (tinycloud === undefined) return;
  if (tinycloud === null || typeof tinycloud !== "object") {
    throw new Error("TinyCloud options must be an object");
  }
  for (const key of FORBIDDEN_TINYCLOUD_OPTIONS) {
    if (Object.prototype.hasOwnProperty.call(tinycloud, key)) {
      throw new Error(`TinyCloud option "${key}" is controlled by CoordinationOS`);
    }
  }
}

async function coordinationOsUserNamespace(keyId: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("CoordinationOS manifest validation requires Web Crypto");
  }
  const bytes = new TextEncoder().encode(
    `coordinationos-openkey-v1:${keyId}`,
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes),
  );
  const base64 = btoa(String.fromCharCode(...digest));
  return base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "")
    .slice(0, 22);
}

async function validateCoordinationOsManifest(
  manifest: Manifest,
  keyId: string,
): Promise<string[]> {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new Error("CoordinationOS canary manifest must be an object");
  }

  const manifestKeys = [
    "manifest_version",
    "app_id",
    "name",
    "space",
    "prefix",
    "defaults",
    "expiry",
    "permissions",
  ];
  const permissionKeys = ["service", "space", "path", "actions"];
  const permissions = (manifest as Manifest).permissions;
  const namespace = await coordinationOsUserNamespace(keyId);
  const canaryPath =
    `coordinationos/integration/v1/${namespace}/canary`;
  const inviteCodePath =
    `coordinationos/integration/v1/${namespace}/invite-code`;
  const validPermission = (
    permission: Manifest["permissions"][number] | undefined,
    path: string,
  ): boolean =>
    permission !== null &&
    typeof permission === "object" &&
    !Array.isArray(permission) &&
    ownKeysEqual(permission, permissionKeys) &&
    permission.service === "tinycloud.kv" &&
    permission.space === "applications" &&
    permission.path === path &&
    Array.isArray(permission.actions) &&
    permission.actions.length === 2 &&
    permission.actions[0] === "get" &&
    permission.actions[1] === "put";
  const valid =
    ownKeysEqual(manifest, manifestKeys) &&
    manifest.manifest_version === 1 &&
    manifest.app_id === "xyz.tinycloud.coordinationos" &&
    manifest.name === "CoordinationOS" &&
    manifest.space === "applications" &&
    manifest.prefix === "" &&
    manifest.defaults === false &&
    manifest.expiry === "1h" &&
    Array.isArray(permissions) &&
    (permissions.length === 1 || permissions.length === 2) &&
    validPermission(permissions[0], canaryPath) &&
    (
      permissions.length === 1 ||
      validPermission(permissions[1], inviteCodePath)
    );

  if (!valid) {
    throw new Error(
      "Manifest must grant only the approved CoordinationOS KV records",
    );
  }
  return permissions.map((permission) => permission.path);
}

function coordinationOsCapabilityRequest(
  manifest: Manifest,
  paths: string[],
): ComposedManifestRequest {
  return {
    manifests: [manifest],
    resources: paths.map((path) => ({
      service: "tinycloud.kv",
      space: "applications",
      path,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    })),
    delegationTargets: [],
    registryRecords: [],
    expiryMs: SESSION_EXPIRATION_MS,
    includePublicSpace: false,
  };
}

function createReadOnlyProvider(address: string) {
  return {
    request: async ({ method }: { method: string }): Promise<unknown> => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return "0x1";
        case "personal_sign":
          throw new Error(
            "OpenKey session signing must use the callback strategy",
          );
        default:
          throw new Error(`Unsupported read-only provider method: ${method}`);
      }
    },
  };
}

function sanitizeSdkCause(
  cause: unknown,
  seen: Set<object> = new Set(),
): Error {
  const sanitized = new Error("Underlying TinyCloud SDK operation failed");
  if (cause === null || typeof cause !== "object" || seen.has(cause)) {
    return sanitized;
  }

  seen.add(cause);
  const causeDescriptor = Object.getOwnPropertyDescriptor(cause, "cause");
  if (
    causeDescriptor &&
    "value" in causeDescriptor &&
    causeDescriptor.value !== undefined
  ) {
    Object.defineProperty(sanitized, "cause", {
      configurable: true,
      value: sanitizeSdkCause(causeDescriptor.value, seen),
    });
  }
  return sanitized;
}

function wrapSdkError(cause: unknown): Error {
  const error = new Error("OpenKey session establishment failed");
  Object.defineProperty(error, "cause", {
    configurable: true,
    value: sanitizeSdkCause(cause),
  });
  return error;
}

function resultFromRestore(
  client: TinyCloudWeb,
  restore: SessionRestoreResult,
): EstablishOpenKeySessionResult {
  return {
    client,
    session: restore.session,
    status: restore.status as EstablishOpenKeySessionStatus,
  };
}

export async function establishOpenKeySession(
  options: EstablishOpenKeySessionOptions,
): Promise<EstablishOpenKeySessionResult> {
  validateTinyCloudOverrides(options.tinycloud);
  const signingEndpoint = normalizeEndpoint(options.signingEndpoint);
  const { domain } = normalizeOrigin(options.origin);
  validateAddress(options.key.address);
  if (options.key.chainId !== 1) {
    throw new Error("OpenKey session delegation requires chainId 1");
  }
  if (
    typeof options.key.keyId !== "string" ||
    options.key.keyId.trim() === ""
  ) {
    throw new Error("OpenKey key ID must be non-empty");
  }
  if (options.sessionExpirationMs !== SESSION_EXPIRATION_MS) {
    throw new Error("OpenKey session expiration must be exactly one hour");
  }
  if (options.sessionStorageKeyPrefix !== SESSION_STORAGE_KEY_PREFIX) {
    throw new Error("OpenKey session storage prefix is invalid");
  }
  const coordinationOsPaths = await validateCoordinationOsManifest(
    options.manifest,
    options.key.keyId,
  );

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("OpenKey session establishment requires fetch");
  }

  let token = options.providerToken;
  let signerFetchCount = 0;
  const hasProviderToken =
    typeof token === "string" && token.length > 0;

  const takeToken = (): string => {
    const current = token;
    token = undefined;
    if (typeof current !== "string" || current.length === 0) {
      throw TOKEN_UNAVAILABLE;
    }
    return current;
  };

  const oneShotFetch: typeof fetch = async (input, init) => {
    let body: OpenKeySigningRequestBody;
    try {
      body = JSON.parse(String(init?.body)) as OpenKeySigningRequestBody;
    } catch {
      throw new Error("OpenKey callback request must be valid JSON");
    }
    if (body.type !== "siwe" || body.purpose !== "sign-in") {
      throw new Error("OpenKey callback request is not an approved sign-in");
    }
    if (signerFetchCount !== 0) {
      throw new Error("OpenKey signing endpoint may be called only once");
    }
    signerFetchCount += 1;
    return fetchImpl(input, init);
  };

  const signStrategy = createOpenKeyCallbackSigningStrategy({
    endpoint: signingEndpoint,
    keyId: options.key.keyId,
    token: takeToken,
    fetch: oneShotFetch,
  });
  const client = new TinyCloudWeb({
    ...options.tinycloud,
    provider: createReadOnlyProvider(options.key.address),
    signStrategy,
    manifest: options.manifest,
    capabilityRequest: coordinationOsCapabilityRequest(
      options.manifest,
      coordinationOsPaths,
    ),
    includeAccountRegistryPermissions: false,
    autoCreateSpace: false,
    autoBootstrapAccount: false,
    persistSession: true,
    sessionStorageKeyPrefix: SESSION_STORAGE_KEY_PREFIX,
    domain,
    sessionExpirationMs: SESSION_EXPIRATION_MS,
  });

  try {
    let restore: SessionRestoreResult;
    try {
      restore = await client.restoreSession(options.key.address);
    } catch (error) {
      throw wrapSdkError(error);
    }
    if (restore.status !== "restored" && !hasProviderToken) {
      return resultFromRestore(client, restore);
    }

    try {
      const session = await client.signIn();
      return {
        client,
        session,
        status: signerFetchCount === 1 ? "established" : "restored",
      };
    } catch (error) {
      if (
        restore.status === "restored" &&
        !hasProviderToken &&
        error === TOKEN_UNAVAILABLE
      ) {
        return { client, status: "stale" };
      }
      throw wrapSdkError(error);
    }
  } finally {
    token = undefined;
  }
}
