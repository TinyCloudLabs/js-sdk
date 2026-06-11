import { Command } from "commander";
import {
  NodeWasmBindings,
  type PermissionEntry,
} from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import {
  resolveProfileOperatorType,
  resolveProfilePosture,
  type ProfileConfig,
} from "../config/types.js";
import { handleError } from "../output/errors.js";
import { outputJson, shouldOutputJson } from "../output/formatter.js";
import { theme } from "../output/theme.js";
import {
  compactPermission,
  loadAdditionalDelegations,
  permissionsFromDelegation,
  type StoredAdditionalDelegation,
} from "../lib/permissions.js";

interface StatusSummary {
  generatedAt: string;
  activeProfile: string;
  defaultProfile: string;
  profileCount: number;
  authenticatedProfileCount: number;
  activeDelegationCount: number;
  profiles: StatusProfile[];
}

interface StatusProfile {
  name: string;
  active: boolean;
  default: boolean;
  exists: boolean;
  status: "logged-in" | "local-key" | "expired" | "signed-out" | "missing";
  host: string | null;
  did: string | null;
  sessionDid: string | null;
  ownerDid: string | null;
  address: string | null;
  spaceId: string | null;
  authMethod: string | null;
  posture: string | null;
  operatorType: string | null;
  hasKey: boolean;
  hasPrivateKey: boolean;
  authenticated: boolean;
  session: StatusSession;
  delegations: StatusDelegation[];
  permissions: PermissionEntry[];
  permissionsCompact: string[];
  permissionCount: number;
  activeDelegationCount: number;
  delegationCount: number;
  issues: string[];
}

interface StatusSession {
  present: boolean;
  expired: boolean | null;
  expiresAt: string | null;
  permissions: PermissionEntry[];
  permissionsCompact: string[];
}

interface StatusDelegation {
  cid: string;
  active: boolean;
  expired: boolean | null;
  expiresAt: string | null;
  permissions: PermissionEntry[];
  permissionsCompact: string[];
}

let wasmBindings: NodeWasmBindings | null = null;

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show local TinyCloud profile, session, delegation, and permission state")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const config = await ProfileManager.getConfig();
        const names = (await ProfileManager.listProfiles()).sort((a, b) =>
          a.localeCompare(b),
        );
        const generatedAt = new Date().toISOString();
        const profiles = await Promise.all(
          names.map((name) =>
            inspectProfile({
              name,
              activeProfile: ctx.profile,
              defaultProfile: config.defaultProfile,
            }),
          ),
        );
        const summary: StatusSummary = {
          generatedAt,
          activeProfile: ctx.profile,
          defaultProfile: config.defaultProfile,
          profileCount: profiles.length,
          authenticatedProfileCount: profiles.filter((p) => p.authenticated)
            .length,
          activeDelegationCount: profiles.reduce(
            (sum, profile) => sum + profile.activeDelegationCount,
            0,
          ),
          profiles,
        };

        if (shouldOutputJson()) {
          outputJson(summary);
          return;
        }

        process.stdout.write(formatStatus(summary));
      } catch (error) {
        handleError(error);
      }
    });
}

async function inspectProfile(params: {
  name: string;
  activeProfile: string;
  defaultProfile: string;
}): Promise<StatusProfile> {
  const issues: string[] = [];
  const profile = await readProfile(params.name, issues);
  const session = await readSession(params.name, issues);
  const hasKey = await readHasKey(params.name, issues);
  const storedDelegations = await readDelegations(params.name, issues);
  const sessionPermissions = session ? sessionPermissionsFromRecap(session) : [];
  const sessionExpiry = session ? extractSessionExpiry(session) : null;
  const sessionExpired =
    sessionExpiry === null ? null : sessionExpiry.getTime() <= Date.now();
  const statusSession: StatusSession = {
    present: session !== null,
    expired: session === null ? null : sessionExpired,
    expiresAt: sessionExpiry?.toISOString() ?? null,
    permissions: sessionPermissions,
    permissionsCompact: compactPermissions(sessionPermissions),
  };
  const delegations = storedDelegations.map(inspectDelegation);
  const activeDelegationPermissions = delegations
    .filter((delegation) => delegation.active)
    .flatMap((delegation) => delegation.permissions);
  const permissions = uniquePermissions([
    ...sessionPermissions,
    ...activeDelegationPermissions,
  ]);
  const hasPrivateKey = typeof profile?.privateKey === "string" && profile.privateKey.length > 0;
  const localKeyAuthenticated = profile?.authMethod === "local" && hasPrivateKey;
  const sessionAuthenticated = session !== null && sessionExpired !== true;
  const authenticated = localKeyAuthenticated || sessionAuthenticated;
  const status = resolveStatus({
    exists: profile !== null,
    authenticated,
    localKeyAuthenticated,
    sessionExpired,
  });

  return {
    name: params.name,
    active: params.name === params.activeProfile,
    default: params.name === params.defaultProfile,
    exists: profile !== null,
    status,
    host: profile?.host ?? null,
    did: profile?.did ?? null,
    sessionDid: profile?.sessionDid ?? null,
    ownerDid: profile?.ownerDid ?? null,
    address: profile?.address ?? null,
    spaceId: profile?.spaceId ?? null,
    authMethod: profile?.authMethod ?? null,
    posture: profile ? resolveProfilePosture(profile) : null,
    operatorType: profile ? resolveProfileOperatorType(profile) : null,
    hasKey,
    hasPrivateKey,
    authenticated,
    session: statusSession,
    delegations,
    permissions,
    permissionsCompact: compactPermissions(permissions),
    permissionCount: permissions.length,
    activeDelegationCount: delegations.filter((delegation) => delegation.active)
      .length,
    delegationCount: delegations.length,
    issues,
  };
}

async function readProfile(
  name: string,
  issues: string[],
): Promise<ProfileConfig | null> {
  try {
    return await ProfileManager.getProfile(name);
  } catch (error) {
    issues.push(`profile: ${messageFromError(error)}`);
    return null;
  }
}

async function readSession(
  name: string,
  issues: string[],
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await ProfileManager.getSession(name));
  } catch (error) {
    issues.push(`session: ${messageFromError(error)}`);
    return null;
  }
}

async function readHasKey(name: string, issues: string[]): Promise<boolean> {
  try {
    return (await ProfileManager.getKey(name)) !== null;
  } catch (error) {
    issues.push(`key: ${messageFromError(error)}`);
    return false;
  }
}

async function readDelegations(
  name: string,
  issues: string[],
): Promise<StoredAdditionalDelegation[]> {
  try {
    return await loadAdditionalDelegations(name);
  } catch (error) {
    issues.push(`delegations: ${messageFromError(error)}`);
    return [];
  }
}

function inspectDelegation(
  entry: StoredAdditionalDelegation,
): StatusDelegation {
  const expiry = parseDate((entry.delegation as { expiry?: unknown }).expiry);
  const expired = expiry === null ? null : expiry.getTime() <= Date.now();
  const permissions = normalizePermissions(
    Array.isArray(entry.permissions) && entry.permissions.length > 0
      ? entry.permissions
      : permissionsFromDelegation(entry.delegation),
  );

  return {
    cid: entry.delegation.cid,
    active: expired !== true,
    expired,
    expiresAt: expiry?.toISOString() ?? null,
    permissions,
    permissionsCompact: compactPermissions(permissions),
  };
}

function resolveStatus(params: {
  exists: boolean;
  authenticated: boolean;
  localKeyAuthenticated: boolean;
  sessionExpired: boolean | null;
}): StatusProfile["status"] {
  if (!params.exists) return "missing";
  if (params.localKeyAuthenticated) return "local-key";
  if (params.authenticated) return "logged-in";
  if (params.sessionExpired === true) return "expired";
  return "signed-out";
}

function sessionPermissionsFromRecap(
  session: Record<string, unknown>,
): PermissionEntry[] {
  if (typeof session.siwe !== "string" || session.siwe.length === 0) return [];
  try {
    const rawEntries = getWasmBindings().parseRecapFromSiwe(session.siwe);
    if (!Array.isArray(rawEntries)) return [];
    return normalizePermissions(rawEntries.map(permissionFromRawRecap));
  } catch {
    return [];
  }
}

function permissionFromRawRecap(value: unknown): PermissionEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const service = stringValue(record.service);
  const space = stringValue(record.space);
  const path = stringValue(record.path);
  const actions = Array.isArray(record.actions)
    ? record.actions.map(String).filter(Boolean)
    : [];
  if (!service || !space || path === null || actions.length === 0) return null;
  return {
    service: normalizeService(service),
    space,
    path,
    actions,
  };
}

function normalizePermissions(entries: unknown[]): PermissionEntry[] {
  const permissions: PermissionEntry[] = [];
  for (const entry of entries) {
    const permission = permissionFromUnknown(entry);
    if (permission) permissions.push(permission);
  }
  return uniquePermissions(permissions);
}

function permissionFromUnknown(value: unknown): PermissionEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const service = stringValue(record.service);
  const space = stringValue(record.space);
  const path = stringValue(record.path);
  const actions = Array.isArray(record.actions)
    ? record.actions.map(String).filter(Boolean)
    : [];
  if (!service || !space || path === null || actions.length === 0) return null;
  return {
    service: normalizeService(service),
    space,
    path,
    actions,
  };
}

function uniquePermissions(entries: PermissionEntry[]): PermissionEntry[] {
  const seen = new Set<string>();
  const unique: PermissionEntry[] = [];
  for (const entry of entries) {
    const key = compactPermission(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function compactPermissions(entries: PermissionEntry[]): string[] {
  return entries.map(compactPermission);
}

function extractSessionExpiry(session: Record<string, unknown>): Date | null {
  for (const key of ["expiresAt", "expiry", "expirationTime"]) {
    const parsed = parseDate(session[key]);
    if (parsed) return parsed;
  }
  if (typeof session.siwe !== "string") return null;
  const match = session.siwe.match(/^Expiration Time:\s*(.+)$/im);
  return match ? parseDate(match[1].trim()) : null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getWasmBindings(): NodeWasmBindings {
  wasmBindings ??= new NodeWasmBindings();
  return wasmBindings;
}

function normalizeService(service: string): string {
  return service.startsWith("tinycloud.") ? service : `tinycloud.${service}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatStatus(summary: StatusSummary): string {
  const lines: string[] = [];
  lines.push(theme.heading("TinyCloud Status"));
  lines.push(`Active profile: ${theme.value(summary.activeProfile)}`);
  lines.push(`Default profile: ${theme.value(summary.defaultProfile)}`);
  lines.push("");

  if (summary.profiles.length === 0) {
    lines.push(theme.muted("No profiles configured. Run: tc init"));
    return `${lines.join("\n")}\n`;
  }

  lines.push(theme.label("Profiles"));
  for (const profile of summary.profiles) {
    lines.push(formatProfile(profile));
  }
  return `${lines.join("\n")}\n`;
}

function formatProfile(profile: StatusProfile): string {
  const marker = profile.active ? theme.success("*") : " ";
  const name = profile.default ? `${profile.name} (default)` : profile.name;
  const host = profile.host ? theme.muted(profile.host) : theme.muted("no host");
  const summary = [
    `${marker} ${profile.active ? theme.brand(name) : name}`,
    formatProfileStatus(profile.status),
    profile.posture ?? "no posture",
    plural(profile.permissionCount, "permission"),
    `${profile.activeDelegationCount}/${profile.delegationCount} delegations`,
    host,
  ].join("  ");
  const lines = [summary];

  lines.push(`  session: ${formatSession(profile.session)}`);
  if (profile.permissionsCompact.length > 0) {
    lines.push("  permissions:");
    for (const permission of profile.permissionsCompact) {
      lines.push(`    ${permission}`);
    }
  }
  if (profile.delegations.length > 0) {
    lines.push("  delegations:");
    for (const delegation of profile.delegations) {
      lines.push(`    ${formatDelegation(delegation)}`);
    }
  }
  if (profile.issues.length > 0) {
    lines.push("  issues:");
    for (const issue of profile.issues) {
      lines.push(`    ${theme.warn(issue)}`);
    }
  }
  return lines.join("\n");
}

function formatProfileStatus(status: StatusProfile["status"]): string {
  switch (status) {
    case "logged-in":
      return theme.success("logged in");
    case "local-key":
      return theme.success("local key");
    case "expired":
      return theme.warn("expired");
    case "missing":
      return theme.warn("missing");
    case "signed-out":
      return theme.muted("signed out");
  }
}

function formatSession(session: StatusSession): string {
  if (!session.present) return theme.muted("none");
  if (session.expired === true) {
    return `${theme.warn("expired")}${formatExpiresAt(session.expiresAt)}`;
  }
  if (session.expired === false) {
    return `${theme.success("active")}${formatExpiresAt(session.expiresAt)}`;
  }
  return `${theme.success("present")}${formatExpiresAt(session.expiresAt)}`;
}

function formatDelegation(delegation: StatusDelegation): string {
  const state = delegation.expired === true
    ? theme.warn("expired")
    : theme.success("active");
  return [
    delegation.cid,
    state,
    formatExpiresAt(delegation.expiresAt).trim(),
    plural(delegation.permissions.length, "permission"),
  ].filter(Boolean).join("  ");
}

function formatExpiresAt(expiresAt: string | null): string {
  return expiresAt ? ` until ${expiresAt}` : "";
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}
