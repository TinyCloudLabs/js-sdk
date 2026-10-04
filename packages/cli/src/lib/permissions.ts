import { appendFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPermissionRequestArtifact,
  isPermissionRequestArtifact,
  type PermissionRequestArtifact,
} from "@tinycloud/operations/artifacts";
import {
  additionalDelegationsPath as sharedAdditionalDelegationsPath,
  authRequestsPath as sharedAuthRequestsPath,
  profileStoreMetadataPath,
  readAdditionalDelegations,
  readAuthRequests,
  withProfileLock,
  writeJsonAtomic,
} from "@tinycloud/operations/state";
import {
  ENCRYPTION_MANIFEST_SPACE,
  ENCRYPTION_PERMISSION_SERVICE,
  expandActionShortNames,
  resolveManifest,
} from "../../../sdk-core/src/manifest.js";
import { isCapabilitySubset } from "../../../sdk-core/src/capabilities.js";
import {
  type AuthRequestArtifact,
  type PermissionEntry,
  type PortableDelegation,
  type RuntimeDelegationActivator,
  type TinyCloudNode,
} from "@tinycloud/node-sdk";
import { PROFILES_DIR } from "../config/constants.js";
import { fileExists, PRIVATE_FILE_MODE } from "../config/storage.js";
import { ProfileManager } from "../config/profiles.js";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { resolveSpaceUri } from "./space.js";
import { isRawEncryptionPermission } from "./raw-encryption.js";
import { canonicalOwnerDid } from "./owner-did.js";
import { SHARE_PUBLISHING_MANIFEST, SHARE_PUBLISHING_MANIFEST_REF } from "../share/publishing-manifest.js";
import {
  resolveProfileOperatorType,
  resolveProfilePosture,
  type ProfileConfig,
} from "../config/types.js";

export { isPermissionRequestArtifact };
export type { PermissionRequestArtifact };

/**
 * The public node-sdk request transport deliberately has fewer fields than
 * the canonical operations artifact. Keep accepting it in the CLI's legacy
 * request store without changing the canonical operations validator.
 */
type StoredPermissionRequestArtifact = PermissionRequestArtifact | AuthRequestArtifact;

export function isCompatiblePermissionRequestArtifact(
  value: unknown,
): value is StoredPermissionRequestArtifact {
  return isPermissionRequestArtifact(value) || isNodeSdkAuthRequestArtifact(value);
}

function isNodeSdkAuthRequestArtifact(value: unknown): value is AuthRequestArtifact {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AuthRequestArtifact>;
  return candidate.kind === "tinycloud.auth.request" &&
    candidate.version === 1 &&
    typeof candidate.requestId === "string" &&
    Array.isArray(candidate.requested);
}

/**
 * Stored shape for a runtime delegation appended to a profile.
 * `permissions` mirrors the request that produced this delegation so
 * `tc auth caps` can surface the originally-asked-for entries even after
 * the delegation has been baked into a recap.
 */
export interface StoredAdditionalDelegation {
  delegation: PortableDelegation;
  permissions: PermissionEntry[];
}

export interface GrantHistoryEntry {
  ts: string;
  profile: string;
  addedCaps: PermissionEntry[];
  source: "cli" | "401-hint" | "manifest";
  delegationCid?: string;
  expiry?: string;
}

export function additionalDelegationsPath(profile: string): string {
  // Sibling file keeps legacy session.json schema unchanged for existing readers.
  return sharedAdditionalDelegationsPath(profile);
}

export function permissionRequestsPath(profile: string): string {
  return sharedAuthRequestsPath(profile);
}

export function grantHistoryPath(profile: string): string {
  return join(PROFILES_DIR, profile, "auth-grants.jsonl");
}

export function createPermissionRequestArtifact(params: {
  profileName: string;
  profile: ProfileConfig;
  host: string;
  requested: PermissionEntry[];
  requestedExpiry?: string | number;
  argv?: string[];
  cwd?: string;
}): PermissionRequestArtifact {
  return buildPermissionRequestArtifact({
    profile: params.profileName,
    posture: resolveProfilePosture(params.profile),
    operatorType: resolveProfileOperatorType(params.profile),
    host: params.host,
    sessionDid: didWithoutFragment(params.profile.sessionDid ?? params.profile.did),
    ownerDid: params.profile.ownerDid,
    spaceId: params.profile.spaceId,
    requestedExpiry: params.requestedExpiry,
    missing: params.requested,
    command: {
      argv: params.argv ?? process.argv.slice(2),
      cwd: params.cwd ?? process.cwd(),
    },
  });
}

function didWithoutFragment(did: string): string {
  const fragment = did.indexOf("#");
  return fragment === -1 ? did : did.slice(0, fragment);
}

export async function loadAdditionalDelegations(
  profile: string,
): Promise<StoredAdditionalDelegation[]> {
  return readAdditionalDelegations<StoredAdditionalDelegation>(profile);
}

export async function saveAdditionalDelegations(
  profile: string,
  entries: StoredAdditionalDelegation[],
): Promise<void> {
  await replaceSharedRecords(profile, "additional-delegations", entries);
}

/**
 * Stores a delegation that was not checked against a stored request. A stored
 * record for the same CID that carries a request binding is kept as it is.
 */
export async function appendAdditionalDelegation(
  profile: string,
  entry: StoredAdditionalDelegation,
): Promise<void> {
  // Loaded on use: a static import would evaluate node-sdk in every command
  // that only reads profile state through this module.
  const { storeDelegationWithoutRequest } = await import("@tinycloud/operations/delegation-binding");
  await storeDelegationWithoutRequest(profile, { ...entry });
}

export async function loadPermissionRequestArtifacts(
  profile: string,
): Promise<StoredPermissionRequestArtifact[]> {
  const raw = await readAuthRequests<unknown>(profile);
  return raw.filter(isCompatiblePermissionRequestArtifact);
}

export async function savePermissionRequestArtifacts(
  profile: string,
  entries: StoredPermissionRequestArtifact[],
): Promise<void> {
  await replaceSharedRecords(profile, "auth-requests", entries);
}

export async function appendPermissionRequestArtifact(
  profile: string,
  artifact: StoredPermissionRequestArtifact,
): Promise<void> {
  // Retain the legacy parser's behavior of dropping malformed historical
  // records, while performing that read-modify-write sequence under the
  // operations-owned profile lock.
  await withProfileLock(profile, async () => {
    const existing = (await readAuthRequests<unknown>(profile))
      .filter(isCompatiblePermissionRequestArtifact);
    const next = existing.filter((item) => item.requestId !== artifact.requestId);
    next.push(artifact);
    await writeSharedRecords(profile, "auth-requests", next);
  });
}

async function replaceSharedRecords<T>(
  profile: string,
  store: "additional-delegations" | "auth-requests",
  entries: T[],
): Promise<void> {
  await withProfileLock(profile, () => writeSharedRecords(profile, store, entries));
}

async function writeSharedRecords<T>(
  profile: string,
  store: "additional-delegations" | "auth-requests",
  entries: T[],
): Promise<void> {
  const path = store === "additional-delegations"
    ? additionalDelegationsPath(profile)
    : permissionRequestsPath(profile);
  await writeJsonAtomic(path, entries);
  await writeJsonAtomic(profileStoreMetadataPath(profile, store), { formatVersion: 1 });
}

export async function getPermissionRequestArtifact(
  profile: string,
  requestId: string,
): Promise<StoredPermissionRequestArtifact | null> {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.find((item) => item.requestId === requestId) ?? null;
}

export async function getLastPermissionRequestArtifact(
  profile: string,
): Promise<StoredPermissionRequestArtifact | null> {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.at(-1) ?? null;
}

/**
 * Reinstalls a profile's stored delegations on a fresh node. Compact-UCAN and
 * signed-login records follow the operations runtime's binding rule
 * (validated activation, and a request binding the signed capabilities fit
 * inside); `migrate` is true only when `node` holds the profile's own session,
 * so the one-time binding migration may run. Other records (the CLI's own
 * signed-login grants) are installed as before.
 */
export async function replayAdditionalDelegations(
  node: TinyCloudNode,
  profile: string,
  options: { host: string; ownerSpace?: string; migrate: boolean },
): Promise<void> {
  // Loaded on use, as in appendAdditionalDelegation.
  const {
    operationSpaceResolver,
    prepareStoredDelegationReplay,
    replayStoredDelegation,
    storedDelegationKind,
  } = await import("@tinycloud/operations/delegation-binding");
  const activator = node as unknown as RuntimeDelegationActivator;
  const migrated = await prepareStoredDelegationReplay(profile, activator, {
    host: options.host,
    migrate: options.migrate,
  });
  const resolveSpace = operationSpaceResolver(node, options.ownerSpace);
  const entries = await loadAdditionalDelegations(profile);
  for (const entry of entries) {
    const record = { ...entry };
    if (storedDelegationKind(record) !== "other") {
      const installed = await replayStoredDelegation(activator, record, {
        host: options.host,
        migrated,
        resolveSpace,
      });
      if (installed === undefined && process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write(`[replay] skipping ${entry.delegation.cid}: refused by validation or its request binding\n`);
      }
      continue;
    }
    // Skip expired delegations rather than letting useRuntimeDelegation throw.
    const expiry = entry.delegation.expiry instanceof Date
      ? entry.delegation.expiry
      : new Date(entry.delegation.expiry as unknown as string);
    if (expiry.getTime() <= Date.now()) continue;
    try {
      await node.useRuntimeDelegation({ ...entry.delegation, expiry });
    } catch (err) {
      // A stored delegation can be invalid for several benign reasons (host
      // unreachable, key rotated). Don't fail the whole CLI invocation —
      // the user can re-run `tc auth request` to refresh the grant.
      if (process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write(`[replay] skipping ${entry.delegation.cid}: ${(err as Error).message}\n`);
      }
    }
  }
}

/**
 * Helper for `tc auth request` to construct the persisted record that
 * follows the runtime grant. Keeps the "PortableDelegation + originating
 * permissions" pair together so future `tc auth caps` output can show the
 * caller-friendly entries we agreed to grant.
 */
export function storedAdditionalDelegation(
  delegation: PortableDelegation,
  permissions: PermissionEntry[],
): StoredAdditionalDelegation {
  return { delegation, permissions };
}

export async function appendGrantHistory(
  profile: string,
  entry: Omit<GrantHistoryEntry, "ts" | "profile">,
): Promise<void> {
  await ProfileManager.ensureProfileDir(profile);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    profile,
    ...entry,
  }) + "\n";
  const path = grantHistoryPath(profile);
  await appendFile(path, line, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  // `mode` only applies on creation; tighten history written by older releases.
  await chmod(path, PRIVATE_FILE_MODE);
}

export async function readGrantHistory(
  profile: string,
): Promise<GrantHistoryEntry[]> {
  const path = grantHistoryPath(profile);
  if (!(await fileExists(path))) return [];
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GrantHistoryEntry);
}

export async function parseCapSpec(
  spec: string,
  profile: string,
): Promise<PermissionEntry> {
  const firstColon = spec.indexOf(":");
  const lastColon = spec.lastIndexOf(":");
  if (firstColon <= 0 || lastColon <= firstColon) {
    throw new CLIError(
      "INVALID_CAP",
      `Invalid --cap "${spec}". Expected tinycloud.<service>:<space>:<path>:<actions-csv>.`,
      ExitCode.USAGE_ERROR,
    );
  }

  const service = normalizeService(spec.slice(0, firstColon));
  const actionsCsv = spec.slice(lastColon + 1);
  const spaceAndPath = spec.slice(firstColon + 1, lastColon);
  const { space, path } = splitSpaceAndPath(spaceAndPath);
  const actions = expandActionShortNames(
    service,
    actionsCsv.split(",").map((action) => action.trim()).filter(Boolean),
  );

  if (actions.length === 0) {
    throw new CLIError("INVALID_CAP", `Capability "${spec}" has no actions.`, ExitCode.USAGE_ERROR);
  }

  return (await resolvePermissionSpaces([
    { service, space, path, actions },
  ], profile))[0]!;
}

export async function loadPermissionRequest(
  source: string,
  profile: string,
): Promise<PermissionEntry[]> {
  const raw = JSON.parse(await readFile(source, "utf8")) as { permissions?: PermissionEntry[] };
  if (!Array.isArray(raw.permissions)) {
    throw new CLIError(
      "INVALID_PERMISSION_REQUEST",
      `Permission request ${source} must contain { "permissions": [...] }.`,
      ExitCode.USAGE_ERROR,
    );
  }
  return resolvePermissionSpaces(raw.permissions, profile);
}

export async function loadManifestPermissions(
  source: string,
  profile: string,
  options: {
    allowLogicalSpaces?: boolean;
    /** `--owner`: names the secrets owner when the profile has not recorded one. */
    ownerDid?: string;
    /** Reject device-ineligible secrets before an owner network is resolved. */
    device?: boolean;
  } = {},
): Promise<PermissionEntry[]> {
  const raw = await loadManifestText(source);
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  if (options.device && typeof manifest.app_id === "string" &&
    (manifest.secrets !== undefined ||
      manifest.space === "secrets" ||
      (typeof manifest.space === "string" && manifest.space.endsWith(":secrets")) ||
      (Array.isArray(manifest.permissions) && manifest.permissions.some((entry: unknown) =>
        entry !== null && typeof entry === "object" &&
        normalizeService(String((entry as Record<string, unknown>).service ?? "")) === "tinycloud.encryption")))) {
    throw new CLIError("DEVICE_AUTH_UNSUPPORTED_SCOPE", "--device cannot authorize tinycloud.encryption or the secrets space. Use browser or --paste login.", ExitCode.USAGE_ERROR);
  }

  if (typeof manifest.id === "string") {
    const resolved = resolveManifest(manifest as Parameters<typeof resolveManifest>[0]);
    if (options.device && resolved.resources.some((entry) =>
      entry.service === "tinycloud.encryption" ||
      entry.space === "secrets" ||
      entry.space?.endsWith(":secrets"))) {
      throw new CLIError("DEVICE_AUTH_UNSUPPORTED_SCOPE", "--device cannot authorize tinycloud.encryption or the secrets space. Use browser or --paste login.", ExitCode.USAGE_ERROR);
    }
    return resolvePermissionSpaces(resolved.resources, profile, options);
  }

  if (typeof manifest.app_id === "string") {
    const permissions = ((manifest.permissions as unknown[]) ?? [])
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .map((entry) => {
        const service = normalizeService(String(entry.service ?? ""));
        const path = String(entry.path ?? "");
        const actions = expandActionShortNames(
          service,
          Array.isArray(entry.actions)
            ? entry.actions.map(String)
            : [],
        );
        // A raw encryption network URN is owner-scoped, not a path in the
        // manifest's space (sdk-core resolveManifest keeps it the same way).
        if (isRawEncryptionPermission({ service, path })) {
          return { service, space: ENCRYPTION_MANIFEST_SPACE, path, actions };
        }
        const resolvedPath = entry.skipPrefix === true
          ? path
          : prefixAppManifestPath(path, manifest.app_id as string);
        return {
          service,
          space: String(manifest.space ?? "applications"),
          path: resolvedPath,
          actions,
        };
      });
    permissions.push(...await secretPermissionsFromAppManifest(manifest, profile, options.ownerDid));
    return resolvePermissionSpaces(permissions, profile, options);
  }

  throw new CLIError(
    "INVALID_MANIFEST",
    "Manifest must contain either SDK field \"id\" or app manifest field \"app_id\".",
    ExitCode.USAGE_ERROR,
  );
}

async function secretPermissionsFromAppManifest(
  manifest: Record<string, unknown>,
  profile: string,
  requestedOwner: string | undefined,
): Promise<PermissionEntry[]> {
  if (manifest.secrets === undefined) {
    return [];
  }

  const resolved = resolveManifest({
    app_id: String(manifest.app_id),
    name: typeof manifest.name === "string" ? manifest.name : String(manifest.app_id),
    defaults: false,
    prefix: "",
    secrets: manifest.secrets as Parameters<typeof resolveManifest>[0]["secrets"],
  });
  const permissions = resolved.resources.filter((resource) =>
    resource.service === "tinycloud.kv" &&
    resource.space === "secrets" &&
    resource.path.startsWith("vault/secrets/")
  );

  const needsDecrypt = permissions.some((permission) =>
    permission.actions.includes("tinycloud.kv/get")
  );
  if (needsDecrypt) {
    permissions.push({
      service: ENCRYPTION_PERMISSION_SERVICE,
      space: ENCRYPTION_MANIFEST_SPACE,
      path: await defaultSecretsNetworkId(profile, requestedOwner),
      actions: ["tinycloud.encryption/decrypt"],
    });
  }

  return permissions;
}

/**
 * The owner's default secrets network. The owner is the profile's recorded
 * owner (or a local owner key's own did:pkh), else `--owner`. A key-only
 * profile's `did` is its session did:key, which owns no secrets network.
 */
async function defaultSecretsNetworkId(profileName: string, requestedOwner: string | undefined): Promise<string> {
  const profile = await ProfileManager.getProfile(profileName);
  const ownDid = profile.did?.split("#")[0];
  const recorded = profile.ownerDid ?? (ownDid?.startsWith("did:pkh:") ? ownDid : undefined);
  const owner = (recorded ?? requestedOwner)?.split("#")[0];
  if (!owner) {
    throw new CLIError(
      "OWNER_DID_UNKNOWN",
      `Cannot determine the secrets owner for profile "${profileName}". Pass --owner did:pkh:eip155:CHAIN:ADDRESS with --manifest.`,
      ExitCode.AUTH_REQUIRED,
    );
  }
  return `urn:tinycloud:encryption:${canonicalOwnerDid(owner, "Secrets owner")}:default`;
}

export function diffPermissions(
  requested: PermissionEntry[],
  granted: PermissionEntry[],
): PermissionEntry[] {
  return isCapabilitySubset(requested, granted).missing;
}

export function permissionsFromDelegation(
  delegation: PortableDelegation,
): PermissionEntry[] {
  if (delegation.resources?.length) {
    return delegation.resources.map((resource) => ({
      service: resource.service.startsWith("tinycloud.")
        ? resource.service
        : `tinycloud.${resource.service}`,
      space: resource.space,
      path: resource.path,
      actions: [...resource.actions],
      ...(resource.caveats?.length ? { caveats: resource.caveats.map((caveat) => structuredClone(caveat)) } : {}),
    }));
  }
  return [{
    service: serviceFromActions(delegation.actions),
    space: delegation.spaceId,
    path: delegation.path,
    actions: [...delegation.actions],
  }];
}

export function compactPermission(permission: PermissionEntry): string {
  const service = permission.service;
  const space = permission.space.startsWith("tinycloud:")
    ? permission.space.slice(permission.space.lastIndexOf(":") + 1)
    : permission.space;
  const actions = permission.actions
    .map((action) => action.startsWith(`${service}/`) ? action.slice(service.length + 1) : action)
    .join(",");
  return `${service}:${space}:${permission.path}:${actions}`;
}

export async function resolvePermissionSpaces(
  entries: PermissionEntry[],
  profile: string,
  options: { allowLogicalSpaces?: boolean } = {},
): Promise<PermissionEntry[]> {
  const profileConfig = await ProfileManager.getProfile(profile);
  // First login (and delegates) may not know the owner's address yet. Keep
  // logical space names; the approving owner binds them to their own space.
  const allowLogicalSpaces = options.allowLogicalSpaces === true ||
    resolveProfilePosture(profileConfig) === "delegate-session";
  const resolved: PermissionEntry[] = [];
  for (const entry of entries) {
    const service = normalizeService(entry.service);
    const actions = expandActionShortNames(service, entry.actions);
    // Raw encryption network entries keep the `encryption` pseudo-space; an
    // owner space prefix would make the node refuse the decrypt grant.
    if (isRawEncryptionPermission({ service, path: entry.path })) {
      // A network URN is never prefixed; send OpenKey the contract shape.
      const { skipPrefix: _skipPrefix, ...raw } = entry;
      resolved.push({ ...raw, service, space: ENCRYPTION_MANIFEST_SPACE, actions });
      continue;
    }
    let space: string;
    try {
      space = await resolveSpaceUri(entry.space, profile) ?? entry.space;
    } catch (error) {
      if (
        !allowLogicalSpaces ||
        entry.space.startsWith("tinycloud:") ||
        !(error instanceof CLIError) ||
        error.code !== "ADDRESS_UNKNOWN"
      ) {
        throw error;
      }
      // A new delegate does not know the owner's address yet. Keep the logical
      // space name in the request; the granting owner resolves it below.
      space = entry.space;
    }
    resolved.push({
      ...entry,
      service,
      space,
      actions,
    });
  }
  return resolved;
}

async function loadManifestText(source: string): Promise<string> {
  if (source === SHARE_PUBLISHING_MANIFEST_REF) {
    return JSON.stringify(SHARE_PUBLISHING_MANIFEST);
  }
  if (source.startsWith("base64:")) {
    return Buffer.from(source.slice("base64:".length), "base64").toString("utf8");
  }
  if (await fileExists(source)) {
    return readFile(source, "utf8");
  }
  try {
    const decoded = Buffer.from(source, "base64").toString("utf8");
    JSON.parse(decoded);
    return decoded;
  } catch {
    return readFile(source, "utf8");
  }
}

function normalizeService(service: string): string {
  if (!service) {
    throw new CLIError("INVALID_CAP", "Capability service is required.", ExitCode.USAGE_ERROR);
  }
  return service.startsWith("tinycloud.") ? service : `tinycloud.${service}`;
}

function splitSpaceAndPath(input: string): { space: string; path: string } {
  if (input.startsWith("tinycloud:")) {
    const parts = input.split(":");
    if (parts.length < 7) {
      throw new CLIError(
        "INVALID_CAP",
        `Full tinycloud space specs must include a path after the space URI.`,
        ExitCode.USAGE_ERROR,
      );
    }
    return {
      space: parts.slice(0, 6).join(":"),
      path: parts.slice(6).join(":"),
    };
  }

  const colon = input.indexOf(":");
  if (colon <= 0) {
    throw new CLIError(
      "INVALID_CAP",
      `Capability must include both space and path.`,
      ExitCode.USAGE_ERROR,
    );
  }
  return {
    space: input.slice(0, colon),
    path: input.slice(colon + 1),
  };
}

function prefixAppManifestPath(path: string, appId: string): string {
  const slash = path.indexOf("/");
  if (slash === -1) return `${appId}/${path}`;
  return `${path.slice(0, slash)}/${appId}/${path.slice(slash + 1)}`;
}

function serviceFromActions(actions: string[]): string {
  const first = actions[0] ?? "tinycloud.unknown/read";
  return first.includes("/") ? first.slice(0, first.indexOf("/")) : "tinycloud.unknown";
}
