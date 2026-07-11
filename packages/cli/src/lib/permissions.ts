import { randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENCRYPTION_MANIFEST_SPACE,
  ENCRYPTION_PERMISSION_SERVICE,
  expandActionShortNames,
  resolveManifest,
} from "../../../sdk-core/src/manifest.js";
import { isCapabilitySubset } from "../../../sdk-core/src/capabilities.js";
import {
  type PermissionEntry,
  type PortableDelegation,
  type TinyCloudNode,
} from "@tinycloud/node-sdk";
import { PROFILES_DIR } from "../config/constants.js";
import { fileExists, readJson, writeJson, ensureDir } from "../config/storage.js";
import { ProfileManager } from "../config/profiles.js";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { resolveSpaceUri } from "./space.js";
import {
  resolveProfileOperatorType,
  resolveProfilePosture,
  type CLIOperatorType,
  type CLIProfilePosture,
  type ProfileConfig,
} from "../config/types.js";

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

export interface PermissionRequestArtifact {
  kind: "tinycloud.auth.request";
  version: 1;
  requestId: string;
  createdAt: string;
  profile: string;
  posture: CLIProfilePosture;
  operatorType: CLIOperatorType;
  host: string;
  sessionDid: string;
  ownerDid?: string;
  spaceId?: string;
  requestedExpiry?: string | number;
  requested: PermissionEntry[];
  command?: {
    argv: string[];
    cwd: string;
  };
}

export interface DelegationImportArtifact {
  kind: "tinycloud.auth.delegation";
  version: 1;
  requestId?: string;
  delegation: PortableDelegation;
  permissions?: PermissionEntry[];
}

export function additionalDelegationsPath(profile: string): string {
  // Sibling file keeps legacy session.json schema unchanged for existing readers.
  return join(PROFILES_DIR, profile, "additional-delegations.json");
}

export function permissionRequestsPath(profile: string): string {
  return join(PROFILES_DIR, profile, "auth-requests.json");
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
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: `req_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
    createdAt: new Date().toISOString(),
    profile: params.profileName,
    posture: resolveProfilePosture(params.profile),
    operatorType: resolveProfileOperatorType(params.profile),
    host: params.host,
    sessionDid: didWithoutFragment(params.profile.sessionDid ?? params.profile.did),
    ownerDid: params.profile.ownerDid,
    spaceId: params.profile.spaceId,
    requestedExpiry: params.requestedExpiry,
    requested: params.requested,
    command: {
      argv: params.argv ?? process.argv.slice(2),
      cwd: params.cwd ?? process.cwd(),
    },
  };
}

function didWithoutFragment(did: string): string {
  const fragment = did.indexOf("#");
  return fragment === -1 ? did : did.slice(0, fragment);
}

export async function loadAdditionalDelegations(
  profile: string,
): Promise<StoredAdditionalDelegation[]> {
  const raw = await readJson<StoredAdditionalDelegation[]>(
    additionalDelegationsPath(profile),
  );
  return Array.isArray(raw) ? raw : [];
}

export async function saveAdditionalDelegations(
  profile: string,
  entries: StoredAdditionalDelegation[],
): Promise<void> {
  const profileDir = join(PROFILES_DIR, profile);
  await ensureDir(profileDir);
  await writeJson(additionalDelegationsPath(profile), entries);
}

export async function appendAdditionalDelegation(
  profile: string,
  entry: StoredAdditionalDelegation,
): Promise<void> {
  const existing = await loadAdditionalDelegations(profile);
  const next = existing.filter((item) => item.delegation.cid !== entry.delegation.cid);
  next.push(entry);
  await saveAdditionalDelegations(profile, next);
}

export async function loadPermissionRequestArtifacts(
  profile: string,
): Promise<PermissionRequestArtifact[]> {
  const raw = await readJson<PermissionRequestArtifact[]>(
    permissionRequestsPath(profile),
  );
  return Array.isArray(raw) ? raw.filter(isPermissionRequestArtifact) : [];
}

export async function savePermissionRequestArtifacts(
  profile: string,
  entries: PermissionRequestArtifact[],
): Promise<void> {
  const profileDir = join(PROFILES_DIR, profile);
  await ensureDir(profileDir);
  await writeJson(permissionRequestsPath(profile), entries);
}

export async function appendPermissionRequestArtifact(
  profile: string,
  artifact: PermissionRequestArtifact,
): Promise<void> {
  const existing = await loadPermissionRequestArtifacts(profile);
  const next = existing.filter((item) => item.requestId !== artifact.requestId);
  next.push(artifact);
  await savePermissionRequestArtifacts(profile, next);
}

export async function getPermissionRequestArtifact(
  profile: string,
  requestId: string,
): Promise<PermissionRequestArtifact | null> {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.find((item) => item.requestId === requestId) ?? null;
}

export async function getLastPermissionRequestArtifact(
  profile: string,
): Promise<PermissionRequestArtifact | null> {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.at(-1) ?? null;
}

export function isPermissionRequestArtifact(value: unknown): value is PermissionRequestArtifact {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PermissionRequestArtifact>;
  return (
    candidate.kind === "tinycloud.auth.request" &&
    candidate.version === 1 &&
    typeof candidate.requestId === "string" &&
    Array.isArray(candidate.requested)
  );
}

export function isDelegationImportArtifact(value: unknown): value is DelegationImportArtifact {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<DelegationImportArtifact>;
  return (
    candidate.kind === "tinycloud.auth.delegation" &&
    candidate.version === 1 &&
    candidate.delegation !== undefined &&
    typeof candidate.delegation === "object"
  );
}

export async function replayAdditionalDelegations(
  node: TinyCloudNode,
  profile: string,
): Promise<void> {
  const entries = await loadAdditionalDelegations(profile);
  for (const entry of entries) {
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
  const profileDir = join(PROFILES_DIR, profile);
  await ensureDir(profileDir);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    profile,
    ...entry,
  }) + "\n";
  await appendFile(grantHistoryPath(profile), line, "utf8");
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
): Promise<PermissionEntry[]> {
  const raw = await loadManifestText(source);
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  if (typeof manifest.id === "string") {
    const resolved = resolveManifest(manifest as Parameters<typeof resolveManifest>[0]);
    return resolvePermissionSpaces(resolved.resources, profile);
  }

  if (typeof manifest.app_id === "string") {
    const permissions = ((manifest.permissions as unknown[]) ?? [])
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .map((entry) => {
        const service = normalizeService(String(entry.service ?? ""));
        const path = String(entry.path ?? "");
        const skipPrefix = entry.skipPrefix === true;
        const resolvedPath = skipPrefix
          ? path
          : prefixAppManifestPath(path, manifest.app_id as string);
        return {
          service,
          space: String(manifest.space ?? "applications"),
          path: resolvedPath,
          actions: expandActionShortNames(
            service,
            Array.isArray(entry.actions)
              ? entry.actions.map(String)
              : [],
          ),
        };
      });
    permissions.push(...await secretPermissionsFromAppManifest(manifest, profile));
    return resolvePermissionSpaces(permissions, profile);
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
      path: await defaultSecretsNetworkId(profile),
      actions: ["tinycloud.encryption/decrypt"],
      skipPrefix: true,
    });
  }

  return permissions;
}

async function defaultSecretsNetworkId(profileName: string): Promise<string> {
  const profile = await ProfileManager.getProfile(profileName);
  const ownerDid = (profile.ownerDid ?? profile.did)?.split("#")[0];
  if (!ownerDid) {
    throw new CLIError(
      "OWNER_DID_UNKNOWN",
      `Cannot determine owner DID for profile "${profileName}". Run \`tc auth login\` first.`,
      ExitCode.AUTH_REQUIRED,
    );
  }
  return `urn:tinycloud:encryption:${ownerDid}:default`;
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
): Promise<PermissionEntry[]> {
  const profileConfig = await ProfileManager.getProfile(profile);
  const allowLogicalSpaces = resolveProfilePosture(profileConfig) === "delegate-session";
  const resolved: PermissionEntry[] = [];
  for (const entry of entries) {
    const service = normalizeService(entry.service);
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
      actions: expandActionShortNames(service, entry.actions),
    });
  }
  return resolved;
}

async function loadManifestText(source: string): Promise<string> {
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
